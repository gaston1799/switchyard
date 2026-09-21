// src/context-compactor.js — automatic context compaction for dsw sessions.
//
// DeepSeek-style chat APIs bound the request at a large input context (default
// here: 1,032,492 tokens) plus a modest completion budget (16,384). Long agent
// sessions grow the transcript without bound, so before each model request the
// wrapper asks this module whether the estimated input is at/above a threshold
// and, if so, compacts:
//
//   * the OLD prefix of the transcript is folded into ONE structured summary
//     message (LLM-generated when a key/model is available, else a
//     deterministic roll-up of goal/plan/checkpoints/last assistant notes),
//   * the RECENT tail is kept verbatim (guaranteeing tool_call_id integrity),
//   * the system message always stays first,
//   * orphaned `tool` messages at the tail boundary are never left behind.
//
// Every compaction is recorded on session.compactions[] so the effect is
// auditable and resumable. `scripts/compact-session.mjs` exposes the same
// engine as a detached CLI so another agent (or an operator) can compact a
// session file out-of-process.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekHttpError } from "./api-error.js";
import { getProviderApiKey } from "./config.js";
import { providerConfig, normalizeProvider, contextLimitFor } from "./providers.js";
import { completeProvider } from "./provider-transport.js";
import { conversationTurns, isCompactionSummary } from "./conversation-turns.js";

import { isRetryableFetchError, retryBackoffMs } from "./fetch-retry.js";

export const DEFAULT_CONTEXT_LIMIT = 1_000_000;
export const DEFAULT_COMPLETION_TOKENS = 16_384;
export const DEFAULT_COMPACT_THRESHOLD = 0.9;
export const DEFAULT_KEEP_RECENT = 15;
const DEFAULT_SUMMARY_INPUT_TOKENS = 200_000;
const COMPACT_TIMEOUT_MS = 30_000;
const COMPACT_MAX_OUTPUT_TOKENS = 4096;
// chars/4 under-counts code/JSON-heavy transcripts; judge the budget against a
// scaled usage so compaction triggers before the real tokenizer rejects the
// request (observed: API rejects at context > max even by ~300 tokens).
const TOKEN_ESTIMATE_SAFETY = 1.2;

// ---------------------------------------------------------------------------
// Token estimation (chars/4 heuristic, matching the wrapper's display math).
// ---------------------------------------------------------------------------

export function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || "").length / 4));
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  let total = estimateTokens(message.role || "") + 4;
  total += estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""));
  total += estimateTokens(message.reasoning_content || "");
  if (message.name) total += estimateTokens(message.name);
  if (message.tool_call_id) total += estimateTokens(message.tool_call_id);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += estimateTokens(call.id || "");
      total += estimateTokens(call.type || "");
      total += estimateTokens(call.function?.name || "");
      total += estimateTokens(call.function?.arguments || "");
    }
  }
  return Math.max(total, message.providerState ? estimateTokens(JSON.stringify(message.providerState)) : 0);
}

export function estimateContextTokens(messages) {
  return (messages || []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function clampRatio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Plan: WHERE to cut, WHAT to fold, whether it is needed at all. Pure.
// ---------------------------------------------------------------------------

export function computeCompactionPlan(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(Number(options.limit) || DEFAULT_CONTEXT_LIMIT, 2000);
  const threshold = clampRatio(options.threshold, DEFAULT_COMPACT_THRESHOLD);
  const keepRecent = Number(options.keepRecent ?? DEFAULT_KEEP_RECENT);
  if (!Number.isInteger(keepRecent) || keepRecent < 1) throw new Error("keepRecent must be a positive number of complete turns");
  const completion = Math.max(Number(options.completionTokens ?? DEFAULT_COMPLETION_TOKENS), 0);
  const toolTokens = Math.max(Number(options.toolTokens) || 0, 0);
  const messagesBudget = limit - completion;
  if (messagesBudget <= 0) throw new Error("Completion budget leaves no room for context");
  const usageRaw = estimateContextTokens(list) + toolTokens;
  const usage = Math.ceil(usageRaw * TOKEN_ESTIMATE_SAFETY);
  const target = messagesBudget * threshold;
  const base = { usage: usageRaw, usageScaled: usage, target, limit, messagesBudget, threshold, completion, toolTokens, keepRecent };
  const noOp = () => ({ ...base, needed: false, keepStart: -1, prefix: [], tail: list, prefixTokens: 0, tailTokens: usageRaw });
  if (!options.force && usage < target) return noOp();
  const turns = conversationTurns(list);
  const foldTurns = Math.max(0, turns.complete.length - keepRecent);
  if (!foldTurns) {
    if (usage > messagesBudget) throw new Error(`Context cannot fit while preserving ${keepRecent} complete turns and the active turn; reduce --compact-keep-recent or use a larger context window.`);
    return noOp();
  }
  const keepStart = turns.complete[foldTurns].start;
  const prefix = list.slice(0, keepStart);
  const tail = list.slice(keepStart);
  const instructions = list.slice(0, turns.instructionsEnd);
  const retainedTokens = estimateContextTokens([...instructions, ...tail]) + toolTokens;
  // Reserve room for summary wrapper and validate the actual result again before mutation.
  const summaryBudget = Math.min(COMPACT_MAX_OUTPUT_TOKENS, Math.floor(messagesBudget / TOKEN_ESTIMATE_SAFETY - retainedTokens - 128));
  if (summaryBudget < 128) throw new Error(`Context cannot fit while preserving ${keepRecent} complete turns and the active turn; reduce --compact-keep-recent or use a larger context window.`);
  return { ...base, needed: true, keepStart, prefix, tail, instructions, keptTurns: keepRecent,
    activeTurn: turns.activeStart !== null, foldedTurns: foldTurns, summaryBudget,
    prefixTokens: estimateContextTokens(prefix), tailTokens: estimateContextTokens(tail),
    projectedTokens: Math.ceil((retainedTokens + summaryBudget + 128) * TOKEN_ESTIMATE_SAFETY) };
}

// ---------------------------------------------------------------------------
// Summarizer input: a bounded, head+tail excerpt of the folded prefix so a
// modest compaction call never has to ingest 90% of a 1M-token transcript.
// ---------------------------------------------------------------------------

export function truncateTranscriptForSummary(messages, maxTokens = DEFAULT_SUMMARY_INPUT_TOKENS) {
  const budget = Math.max(1, Math.floor(Number(maxTokens))) * 4;
  const lines = (messages || []).map((message) => {
    const calls = (message.tool_calls || []).map((call) => `${call.function?.name}: ${call.function?.arguments}`).join("; ");
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    return `[${message.role}] ${calls ? `[tool_calls: ${calls}] ` : ""}${text}`.slice(0, isCompactionSummary(message) ? 12000 : 2000);
  });
  const text = lines.join("\n");
  if (text.length <= budget) return text || "(empty transcript)";
  const marker = "\n… [middle of older transcript omitted] …\n";
  if (budget <= marker.length) return text.slice(0, budget);
  const head = Math.floor((budget - marker.length) * 0.4);
  return text.slice(0, head) + marker + text.slice(-(budget - marker.length - head));
}

const SUMMARIZER_SYSTEM_PROMPT = [
  "You are the context compactor for a long-running AI coding-agent session. Older messages have been folded away and the agent's context window was about to overflow.",
  "",
  "Produce a STRUCTURED Markdown summary of the transcript below. It will be injected as the agent's memory, so precision beats prose.",
  "",
  "Sections (in this order):",
  "## Mission & goals — what the agent set out to do.",
  "## Completed work — what was done, with exact file paths, function/route/task names, and key decisions. Include git/task identifiers verbatim.",
  "## Current state — what exists right now (files, processes, claims, leases, branch), exactly as known.",
  "## Open items & next steps — what remains, in priority order.",
  "## Important facts — paths, commands, config keys, hashes, ids, ports, error strings. No paraphrasing of identifiers.",
  "## Risks & caveats — traps, broken things, red tests, constraints (e.g. \"do not touch X\").",
  "",
  "Rules: never invent facts; if the transcript does not say, say unknown. Keep identifiers byte-exact. Total length: under 3000 tokens. Terse bullets, no filler, no sign-off."
].join("\n");

// ---------------------------------------------------------------------------
// Summarizers.
// ---------------------------------------------------------------------------

export function summaryOptions(opts) {
  const provider = normalizeProvider(opts.compactProvider || opts.provider || "deepseek");
  const sameProvider = provider === normalizeProvider(opts.provider || "deepseek");
  const config = providerConfig(provider);
  const model = opts.compactModel || (sameProvider ? opts.model : null) || config.model;
  return { provider, model, baseUrl: opts.compactBaseUrl || (sameProvider ? opts.baseUrl : null) || config.baseUrl,
    contextLimit: opts.compactContextLimit || (sameProvider && model === opts.model ? opts.contextLimit : null) || contextLimitFor(provider, model),
    maxTokens: Math.min(COMPACT_MAX_OUTPUT_TOKENS, opts.summaryBudget || COMPACT_MAX_OUTPUT_TOKENS),
    thinking: "disabled", compactionRequest: true, session: opts.session };
}

export async function summarizeWithLlm(opts, transcript, hooks = {}) {
  const requestOpts = summaryOptions(opts);
  const apiKey = hooks.apiKey ?? await getProviderApiKey(requestOpts.provider);
  if (!apiKey) throw new Error(`No ${providerConfig(requestOpts.provider).label} API key found for context compaction.`);
  const attempts = Math.min(Math.max(Number(opts.compactRetryAttempts) || 2, 1), 3);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.compactTimeoutMs || COMPACT_TIMEOUT_MS);
    try {
      const result = await completeProvider(requestOpts, [
        { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
        { role: "user", content: transcript }
      ], { apiKey, signal: controller.signal, fetchImpl: hooks.fetchImpl });
      const summary = String(result.content || "").replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
      if (!summary) throw new Error("Compactor returned an empty summary");
      return summary;
    } catch (error) {
      if (attempt === attempts || !isRetryableFetchError(error)) throw error;
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, retryBackoffMs(opts.retryDelay || 100, opts.retryMaxDelay || 1000, attempt)));
    } finally { clearTimeout(timer); }
  }
}

export function buildDeterministicSummary(session, prefix) {
  const parts = [];
  parts.push("# Context compaction summary (deterministic roll-up)");
  const prior = (prefix || []).find(isCompactionSummary);
  if (prior) parts.push("", "## Previous memory", String(prior.content).replace(/<\/?context_compaction[^>]*>/g, "").slice(0, 5000));
  const firstUser = (prefix || []).find((m) => m.role === "user" && !isCompactionSummary(m));
  if (firstUser) parts.push("", "## Earlier user request", String(firstUser.content).slice(0, 2000));
  if (session?.goal) {
    parts.push("", "## Mission & goals", `- [${session.goal.status}] ${session.goal.objective}`);
  }
  const plan = Array.isArray(session?.plan) ? session.plan : [];
  if (plan.length) {
    const counts = plan.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
    parts.push("", "## Plan", `- ${counts.completed || 0}/${plan.length} steps completed`, ...plan.map((item) => `- [${item.status}] ${item.step}`));
  }
  const checkpoints = Array.isArray(session?.checkpoints) ? session.checkpoints.slice(-5) : [];
  if (checkpoints.length) {
    parts.push("", "## Recent checkpoints", ...checkpoints.map((checkpoint) => `- ${checkpoint.createdAt || ""}: ${String(checkpoint.summary || "").slice(0, 400)}`));
  }
  const prefixList = Array.isArray(prefix) ? prefix : [];
  const lastAssistants = prefixList.filter((message) => message.role === "assistant" && message.content).slice(-3);
  if (lastAssistants.length) {
    parts.push("", "## Last assistant notes (from folded messages)", ...lastAssistants.map((message) => `- ${String(message.content).slice(0, 300)}`));
  }
  const folded = prefixList.filter((message) => message.role !== "system").length;
  parts.push("", "## Compacted away", `- ${folded} earlier message${folded === 1 ? "" : "s"} were folded into this summary to free context. The folded prefix is replaced in the saved session; this summary is the retained memory.`);

  const importantFacts = prefixList
    .flatMap((message) => {
      if (!Array.isArray(message.tool_calls)) return [];
      return message.tool_calls
        .map((call) => call.function?.name || "")
        .filter((name) => ["patch_files", "write_text_file", "run_cmd", "run_powershell", "git_commit", "agent_handoff", "agent_claim"].includes(name))
        .map((name) => `- tool ${name}`);
    });
  const uniqueFacts = [...new Set(importantFacts)].slice(0, 20);
  if (uniqueFacts.length) {
    parts.push("", "## Tool activity in folded messages", ...uniqueFacts);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Apply + orchestrate.
// ---------------------------------------------------------------------------

export function applyCompaction(messages, { keepStart, summary, meta = {} }) {
  const list = Array.isArray(messages) ? messages : [];
  const instructions = [];
  for (const message of list) { if (!["system", "developer"].includes(message.role)) break; instructions.push(message); }
  const tail = list.slice(Math.max(Number(keepStart) || 1, 1));
  const at = meta.at || new Date().toISOString();
  const summaryMessage = {
    role: "user",
    compactionSummary: true,
    content: [
      `<context_compaction at="${at}" method="${meta.method || "auto"}" from_tokens="${meta.usage ?? ""}" to_tokens="${meta.projectedTokens ?? ""}">`,
      String(summary || "").trim(),
      "</context_compaction>"
    ].join("\n")
  };
  return [...instructions, summaryMessage, ...tail];
}

export async function compactSession(opts, session, hooks = {}) {
  if (!session || !Array.isArray(session.messages)) return null;
  const method = String(opts.compactMethod || "auto").toLowerCase();
  if (method === "off" || method === "detached") return null; // detached is handled by the wrapper/spawn path
  if (!["auto", "llm", "truncate"].includes(method)) throw new Error(`Unknown compaction method: ${method}`);

  const plan = computeCompactionPlan(session.messages, {
    limit: opts.contextLimit,
    threshold: opts.compactAt,
    force: opts.compactForce,
    toolTokens: opts.compactToolTokens,
    keepRecent: opts.compactKeepRecent,
    completionTokens: opts.maxTokens
  });
  if (!plan.needed) return null;

  if (typeof hooks.onStart === "function") hooks.onStart(plan, method);

  const at = new Date().toISOString();
  let summary;
  let usedMethod;
  if (method === "llm" || method === "auto") {
    try {
      const summaryOpts = summaryOptions({ ...opts, summaryBudget: plan.summaryBudget });
      const inputBudget = Math.max(128, Math.floor((summaryOpts.contextLimit - summaryOpts.maxTokens) / TOKEN_ESTIMATE_SAFETY) - estimateTokens(SUMMARIZER_SYSTEM_PROMPT) - 128);
      const transcript = truncateTranscriptForSummary(plan.prefix, Math.min(DEFAULT_SUMMARY_INPUT_TOKENS, inputBudget));
      summary = await summarizeWithLlm({ ...opts, summaryBudget: plan.summaryBudget }, transcript, hooks);
      if (estimateTokens(summary) > plan.summaryBudget) throw new Error("Summary exceeded its reserved budget");
      usedMethod = "llm";
    } catch (error) {
      summary = buildDeterministicSummary(session, plan.prefix);
      usedMethod = "truncate_fallback";
      hooks.onFallback?.(error);
    }
  } else {
    summary = buildDeterministicSummary(session, plan.prefix);
    usedMethod = "truncate";
  }

  summary = String(summary).slice(0, plan.summaryBudget * 4);
  const meta = {
    at,
    method: usedMethod,
    usage: plan.usage,
    usageScaled: plan.usageScaled,
    target: plan.target,
    limit: plan.limit,
    messagesBudget: plan.messagesBudget,
    threshold: plan.threshold,
    projectedTokens: plan.projectedTokens,
    foldedMessages: plan.prefix.filter((message) => message.role !== "system").length,
    keptMessages: plan.tail.length,
    keptTurns: plan.keptTurns,
    foldedTurns: plan.foldedTurns,
    activeTurn: plan.activeTurn,
    summaryProvider: summaryOptions(opts).provider,
    summaryModel: summaryOptions(opts).model,
    keptStartIndex: plan.keepStart
  };
  const nextMessages = applyCompaction(session.messages, { keepStart: plan.keepStart, summary, meta });
  meta.projectedTokens = Math.ceil((estimateContextTokens(nextMessages) + plan.toolTokens) * TOKEN_ESTIMATE_SAFETY);
  if (meta.projectedTokens > plan.messagesBudget) throw new Error("Compacted context still exceeds the input budget; session was not changed");
  conversationTurns(nextMessages); // Validate the retained call/result structure before committing.
  session.messages = nextMessages;
  if (!Array.isArray(session.compactions)) session.compactions = [];
  session.compactions.push(meta);
  session.updatedAt = at;
  return meta;
}

// ---------------------------------------------------------------------------
// Detached mode: spawn scripts/compact-session.mjs against a persisted copy
// of the session, then merge the compacted transcript back in-process.
// ---------------------------------------------------------------------------

export async function compactSessionDetached(opts, session) {
  if (!session || !Array.isArray(session.messages)) return null;
  if (opts.compactMethod !== "detached") return null;
  if (!opts.session) throw new Error("detached compaction requires --session (a persisted session file).");

  const plan = computeCompactionPlan(session.messages, {
    limit: opts.contextLimit,
    threshold: opts.compactAt,
    keepRecent: opts.compactKeepRecent,
    completionTokens: opts.maxTokens,
    toolTokens: opts.compactToolTokens
  });
  if (!plan.needed) return null;

  const script = fileURLToPath(new URL("../scripts/compact-session.mjs", import.meta.url));
  const tmpIn = `${opts.session}.compact-in-${process.pid}-${Date.now()}.json`;
  const tmpOut = `${opts.session}.compact-out-${process.pid}-${Date.now()}.json`;
  await mkdir(dirname(tmpIn), { recursive: true });
  await writeFile(tmpIn, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [
        script, tmpIn,
        "--out", tmpOut,
        "--at", String(opts.compactAt),
        "--limit", String(opts.contextLimit),
        "--keep-recent", String(opts.compactKeepRecent),
        "--method", "auto",
        "--provider", opts.provider,
        "--model", opts.model,
        "--base-url", opts.baseUrl,
        "--tool-tokens", String(opts.compactToolTokens || 0),
        ...(opts.compactProvider ? ["--compact-provider", opts.compactProvider] : []),
        ...(opts.compactModel ? ["--compact-model", opts.compactModel] : []),
        ...(opts.compactBaseUrl ? ["--compact-base-url", opts.compactBaseUrl] : []),
        "--completion", String(opts.maxTokens)
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), COMPACT_TIMEOUT_MS * 2 + 10_000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(null);
        else reject(new Error(`compactor process exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });

    const result = JSON.parse(await readFile(tmpOut, "utf8"));
    if (!result.compacted) return null;
    if (!Array.isArray(result.messages) || !result.messages.length) throw new Error("compactor returned an empty transcript.");
    session.messages = result.messages;
    session.compactions = Array.isArray(result.compactions) ? result.compactions : [];
    session.updatedAt = new Date().toISOString();
    return result.meta || session.compactions[session.compactions.length - 1] || null;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
