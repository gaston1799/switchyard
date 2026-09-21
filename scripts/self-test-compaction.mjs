// Self-test for src/context-compactor.js — dynamic detection + compaction.
import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONTEXT_LIMIT,
  applyCompaction,
  buildDeterministicSummary,
  compactSession,
  computeCompactionPlan,
  estimateContextTokens,
  truncateTranscriptForSummary
} from "../src/context-compactor.js";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

const LIMIT = 1_048_576;
const COMPLETION = 16_384;
const MESSAGES_BUDGET = LIMIT - COMPLETION; // 1,032,192

function bigMessages(count, content = "x".repeat(8000)) {
  const messages = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < count; i += 1) {
    messages.push({ role: "user", content: `question ${i}` });
    messages.push({ role: "assistant", content: content, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_text_file", arguments: JSON.stringify({ path: `file-${i}.txt` }) } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `tool result ${i}` });
  }
  return messages;
}

await check("estimators are sane", () => {
  assert.ok(estimateContextTokens([]) === 0);
  assert.ok(estimateContextTokens([{ role: "user", content: "abcd" }]) >= 4);
});

await check("no compaction below threshold", () => {
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  const plan = computeCompactionPlan(messages, { limit: LIMIT, threshold: 0.9, completionTokens: COMPLETION });
  assert.equal(plan.needed, false);
});

await check("budget math: messages budget reserves completion (your 400 repro)", () => {
  // Reproduce the observed failure: request was 1,032,492 messages + 16,384
  // completion = 1,048,876 > 1,048,576. A plan must consider that OVER and
  // trigger. Estimate is chars/4 so craft chars/4 tokens to cross the budget.
  const targetChars = (MESSAGES_BUDGET * 0.95) * 4; // 95% of the messages budget in chars
  const perMessage = 4000;
  const messages = [{ role: "system", content: "system prompt" }];
  let chars = messages[0].content.length;
  for (let i = 0; chars < targetChars; i += 1) {
    messages.push({ role: "user", content: "u".repeat(perMessage) });
    messages.push({ role: "assistant", content: "done" });
    chars += perMessage;
  }
  const rawUsage = estimateContextTokens(messages);
  assert.ok(rawUsage * 1.2 > MESSAGES_BUDGET * 0.9, "scaled usage crosses the 90% trigger");
  const plan = computeCompactionPlan(messages, { limit: LIMIT, threshold: 0.9, completionTokens: COMPLETION });
  assert.equal(plan.needed, true, "plan must trigger");
  assert.ok(plan.messagesBudget === MESSAGES_BUDGET, "messages budget = limit - completion");
  assert.ok(plan.projectedTokens < MESSAGES_BUDGET * 0.9, "projected fits with headroom");
});

await check("plan keeps recent tail and never starts on an orphaned tool message", () => {
  const messages = bigMessages(500); // 1501 messages ≈ 1M raw chars/4 tokens — crosses the 90% trigger
  const plan = computeCompactionPlan(messages, { limit: LIMIT, threshold: 0.9, completionTokens: COMPLETION, keepRecent: 10 });
  assert.equal(plan.needed, true);
  assert.ok(plan.keepStart > 0, "keeps at least system");
  assert.notEqual(messages[plan.keepStart]?.role, "tool", "tail starts on a non-tool message");
  const tailUsers = plan.tail.filter((m) => m.role === "user").length;
  assert.ok(tailUsers >= 1, "recent user turns preserved");
  assert.ok(plan.tail[0].role === "system" ? false : true, "tail excludes system");
  assert.ok(plan.tailTokens < plan.prefixTokens, "tail is much smaller than folded prefix");
});

await check("applyCompaction: system first, summary second, tail intact", () => {
  const messages = bigMessages(500);
  const plan = computeCompactionPlan(messages, { limit: LIMIT, threshold: 0.9, completionTokens: COMPLETION });
  assert.equal(plan.needed, true);
  const meta = { method: "llm", usage: plan.usage, projectedTokens: plan.projectedTokens };
  const compacted = applyCompaction(messages, { keepStart: plan.keepStart, summary: "## Summary\n- did things", meta });
  assert.equal(compacted[0].role, "system");
  assert.equal(compacted[1].role, "user");
  assert.ok(compacted[1].content.includes("<context_compaction"), "summary carries the marker");
  assert.ok(compacted[1].content.includes("did things"), "summary body present");
  const tail = messages.slice(plan.keepStart);
  assert.deepEqual(compacted.slice(2), tail, "tail preserved verbatim after the summary");
  const toolIds = tail.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  const keptCallIds = new Set(tail.flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c.id) : [])));
  for (const id of toolIds) assert.ok(keptCallIds.has(id), `tool result ${id} has its assistant call in tail`);
});

await check("deterministic summary rolls up goal/plan/checkpoints", () => {
  const summary = buildDeterministicSummary(
    { goal: { objective: "Fix the server", status: "active" }, plan: [{ step: "a", status: "completed" }, { step: "b", status: "pending" }], checkpoints: [{ createdAt: "2026-01-01", summary: "did a thing" }] },
    [{ role: "assistant", content: "last note" }]
  );
  assert.ok(summary.includes("Fix the server"), "goal present");
  assert.ok(summary.includes("1/2 steps completed"), "plan progress present");
  assert.ok(summary.includes("did a thing"), "checkpoint present");
});

await check("truncateTranscriptForSummary bounds the input", () => {
  const messages = bigMessages(80);
  const transcript = truncateTranscriptForSummary(messages, 4000);
  assert.ok(transcript.length <= 4000 * 4 + 2000, "input bounded to the token budget");
  assert.ok(transcript.includes("[tool_calls:"), "tool calls annotated");
});

await check("compactSession truncate: end-to-end shrink + audit trail", async () => {
  const messages = bigMessages(500);
  const session = { messages, goal: { objective: "o", status: "active" }, plan: [], checkpoints: [] };
  const meta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 10, maxTokens: COMPLETION }, session);
  assert.ok(meta, "compaction happened");
  assert.equal(meta.method, "truncate");
  assert.ok(estimateContextTokens(session.messages) < estimateContextTokens(messages), "context shrank");
  assert.equal(session.messages[0].role, "system");
  assert.ok(session.compactions.length === 1, "compaction recorded");
  assert.equal(session.compactions[0].foldedMessages > 0, true);
});

await check("compactSession off: no-op", async () => {
  const messages = bigMessages(60);
  const session = { messages };
  let started = 0;
  const meta = await compactSession({ compactMethod: "off", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 10 }, session, { onStart: () => { started += 1; } });
  assert.equal(meta, null);
  assert.equal(started, 0, "no onStart when compaction is off");
  assert.equal(session.messages.length, messages.length);
});

await check("compactSession onStart fires exactly when compaction happens", async () => {
  const started = [];
  const small = { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] };
  const smallMeta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 10 }, small, { onStart: (plan, method) => started.push({ plan, method }) });
  assert.equal(smallMeta, null);
  assert.equal(started.length, 0, "no onStart below threshold");

  const big = { messages: bigMessages(500) };
  const bigMeta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 10 }, big, { onStart: (plan, method) => started.push({ plan, method }) });
  assert.ok(bigMeta, "compaction happened");
  assert.equal(started.length, 1, "onStart fired once");
  assert.equal(started[0].method, "truncate");
  assert.equal(started[0].plan.needed, true);
  assert.ok(started[0].plan.usage > started[0].plan.target, "onStart carries the trigger numbers");
});

await check("compactSession force compacts below threshold (coordination hook)", async () => {
  // A moderately large session that would NOT trigger at 0.9 of 1M — but a
  // coordinator-initiated compact request forces the fold anyway.
  const messages = bigMessages(12); // ~24k raw tokens — far below threshold
  const session = { messages, goal: { objective: "o", status: "active" } };
  const autoMeta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 5 }, session);
  assert.equal(autoMeta, null, "no auto compaction below threshold");
  const forceMeta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 5, compactForce: true }, session);
  assert.ok(forceMeta, "forced compaction happens");
  assert.ok(forceMeta.foldedMessages > 0, "folded the old prefix");
  assert.ok(session.messages[0].role === "system" && session.messages[1].content.includes("<context_compaction"), "summary injected after system");
});

await check("compactSession force on tiny session: nothing to fold", async () => {
  const session = { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] };
  const meta = await compactSession({ compactMethod: "truncate", contextLimit: LIMIT, compactAt: 0.9, compactKeepRecent: 40, compactForce: true }, session);
  assert.equal(meta, null, "nothing to fold -> no compaction");
});

await check("compact-session.mjs CLI (truncate) writes a compacted result file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsw-compact-test-"));
  const sessionFile = join(dir, "session.json");
  const outFile = join(dir, "out.json");
  await writeFile(sessionFile, `${JSON.stringify({ messages: bigMessages(500), goal: { objective: "o", status: "active" } })}\n`, "utf8");
  const script = fileURLToPath(new URL("../scripts/compact-session.mjs", import.meta.url));
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, sessionFile, "--out", outFile, "--method", "truncate", "--limit", String(LIMIT), "--completion", String(COMPLETION)], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise(null) : reject(new Error(`exit ${code}: ${stderr}`))));
  });
  await result;
  const data = JSON.parse(await readFile(outFile, "utf8"));
  assert.equal(data.compacted, true);
  assert.ok(data.meta.method === "truncate");
  assert.equal(data.messages[0].role, "system");
  await rm(dir, { recursive: true, force: true });
});

console.log(`\nAll ${passed} compaction checks passed.`);
