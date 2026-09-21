#!/usr/bin/env node
import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync } from "node:fs";
import { platform, release, arch, userInfo } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deepSeekHttpError } from "./api-error.js";
import { isRetryableFetchError, retryBackoffMs } from "./fetch-retry.js";
import { configPath, getDeepSeekApiKey, getProviderApiKey, setProviderApiKey } from "./config.js";
import { contextLimitFor, fetchProviderModels, hasKnownContextLimit, normalizeProvider, PROVIDERS, providerConfig } from "./providers.js";
import { providerStream } from "./provider-transport.js";
import { DEEPSEEK_TOP_UP_URL, getProviderBalance, isBelowMinimum } from "./provider-balance.js";
import { listSessions, newSession, newSessionPath, readSession, sessionPath, touchSession, writeSession } from "./session-memory.js";
import { certLogs, classifyUrl, dnsLookup, fileAnalyze, trackSafetyState, verifyDownload, virusTotalLookup, watchDownloads, whoisLookup } from "./download-safety.js";
import { runSecurityTool, securityToolSchemas } from "./security_tools.js";
import { runOffensiveTool, offensiveToolSchemas } from "./offensive_tools.js";
import { runReTool, reToolSchemas } from "./re_tools.js";
import { runRuntimeTool, runtimeToolSchemas } from "./runtime_tools.js";
import { runFuzzTool, fuzzToolSchemas } from "./fuzz_tools.js";
import { runBountyTool, bountyToolSchemas } from "./bounty_tools.js";
import { runDockerTool, dockerToolSchemas } from "./docker_tools.js";
import { checkForUpdates, clearSkipped, isSkipped, performUpdate, setSkipped } from "./update-check.js";
import { createMarkdownWriter, formatDuration, ToolCallTracker } from "./tui.js";
import { TerminalUI } from "./terminal-ui.js";
import { runNativeChat } from "./native-chat.js";
import { nativeAuth } from "./native-process.js";
import { CONNECTIONS, chooseModel, applyApiModel, SLASH_HELP, parseSlash } from "./connection-picker.js";
let activeTerminalUi = null;
import { renderChatHistory, historyTitle } from "./history.js";
import { compactSession, compactSessionDetached, estimateContextTokens, estimateMessageTokens, estimateTokens } from "./context-compactor.js";
import {
  acknowledgeAgentMessages,
  claimTask,
  completeTask,
  coordinationRoot,
  createAgentRuntime,
  createTask,
  formatAgentMessages,
  generateAgentId,
  listAgents,
  listTasks,
  readAgentInbox,
  sendAgentMessage,
  validateAgentId,
  waitForAgentMessages
} from "./agent-coordination.js";
import { discoverSkills, formatSkillList, renderLoadedSkills, resolveSkill, runSkillCommand, skillRootsWithSources, skillUsage } from "./skills.js";
import { boundedSearch } from "./search.js";
import { getArtifact, getArtifactIndex, listArtifacts, readArtifactRange, searchArtifact, searchArtifacts, writeArtifact } from "./artifacts.js";
import { SANDBOX_ENVIRONMENTS, sandboxExecute, sandboxOperation } from "./sandbox.js";
import { addScopeAssets, checkScope, decideEscalation, getEscalationPolicy, getScope, recordHypothesis, recordRoi, recordViability, removeScopeAssets, requireScope, setEscalationPolicy, setScope } from "./task-state.js";
import { netCaptureStart, netCaptureStatus, netCaptureStop, netConversations, netExtractFields, netListInterfaces, netProtocolSummary, netQueryPcap, netStreamSummary } from "./net-tools.js";
import { peTriage } from "./triage.js";

const DEFAULT_PROVIDER = "deepseek";
// __SYSTEM_PROMPT__ is replaced with the file's content by the exe build step (esbuild --define).
// In normal dev/npm installs it is undefined and the file is read at runtime instead.
const EMBEDDED_SYSTEM_PROMPT = typeof __SYSTEM_PROMPT__ !== "undefined" ? __SYSTEM_PROMPT__ : null;
const DEFAULT_SYSTEM_PROMPT_FILE = EMBEDDED_SYSTEM_PROMPT ? null : new URL("../prompts/default-system.md", import.meta.url);
const EMBEDDED_UI_APP_DIR = typeof __UI_APP_DIR__ !== "undefined" ? __UI_APP_DIR__ : null;
const UI_APP_DIR = EMBEDDED_UI_APP_DIR || dirname(fileURLToPath(new URL("./ui/main.cjs", import.meta.url)));

function usage() {
  return `switchyard  (aliases: d, dsw, ds)

Usage:
  switchyard
  switchyard -ui [options]
  switchyard doctor
  switchyard login <codex|claude>
  switchyard auth <codex|claude>
  switchyard --backend codex --tui
  switchyard --backend claude --tui
  switchyard balance [--minimum <usd>] [--json]
  switchyard agents [--all] [--json] [-i|--interactive] [--coord-dir <dir>]
  switchyard message <agent-id> <message> [--from <agent-id>] [--coord-dir <dir>]
  switchyard wake <agent-id> [message] [--from <agent-id>] [--coord-dir <dir>]
  switchyard inbox <agent-id> [--coord-dir <dir>]
  switchyard tasks [--coord-dir <dir>]
  switchyard security allow <domain>
  switchyard security remove <domain>
  switchyard security list
  switchyard skill list [--json]
  switchyard skill read <name>
  switchyard skill install <name|repo|path> [--force]
  switchyard skill create <name> [--description <text>]
  switchyard skill remove <name>
  switchyard skill sync [--from-workspace|--to-workspace] [--force] [--migrate-from-codex]
  switchyard skill doctor
  switchyard config set-key <key>
  switchyard config set-glm-key <key>
  switchyard config set-anthropic-key <key>
  switchyard config set-openai-key <key>
  switchyard config set-google-search-key <key>
  switchyard config set-google-search-engine-id <engine-id>
  switchyard config path
  switchyard -p <prompt> [options]
  switchyard --prompt-file <file> [options]
  switchyard --stdin [options]

Options:
  -ui, --ui                   Launch the Electron desktop UI instead of the CLI/TUI.
  --ui-port <number>          UI control HTTP port. Default: 17891
  --ui-cdp-port <number>      Electron remote debugging/CDP port. Default: 9223
  -p, --prompt <text>          Prompt content.
  --prompt-file <file>         Read prompt content from a file.
  --stdin                      Read prompt content from stdin.
  --system <text>              System prompt text.
  --system-file <file>         System prompt file. Default: prompts/default-system.md
  --print-system               Print the rendered system prompt and exit.
  --skill <name-or-path>        Load a local skill's SKILL.md into the system prompt. Repeatable.
  --skills <a,b>               Comma-separated skills to load.
  --skill-root <dir>           Directory containing skill folders. Repeatable.
  --list-skills                List discovered local skills and exit.
  --skill-root also selects the canonical DeepSeek root for switchyard skill install/create/remove/sync.
  --backend <api|codex|claude>  Execution engine; codex/claude use signed-in CLI accounts.
  --provider <deepseek|glm|anthropic|openai>    Model provider. Default: deepseek
  --balance-fallback <provider> On HTTP 402, retry with this configured provider (for example: glm).
  --model <name>               Model (selected provider's default)
  --base-url <url>             Provider API base URL (provider default)
  --effort <high|max>          Reasoning effort. Default: high
  --thinking <enabled|disabled>
                               Provider thinking toggle. Default: enabled
  --max-tokens <number>        Max output tokens. Default: 16384
  --timeout <ms>               Request timeout per turn. Default: 600000
  --retry-attempts <number>    Max retries for transient fetch failures (0 = keep retrying forever). Default: 0
  --retry-delay <ms>           Initial retry backoff, doubles per attempt. Default: 1000
  --retry-max-delay <ms>       Retry backoff cap. Default: 30000
  --max-tool-turns <number>    Max tool call loops. Default: unlimited
  --tool-mode <parallel|sequential>
                               parallel runs tool calls concurrently; sequential runs in order. Default: parallel
  --permission <review|ask|full>
                               Session permission level. review=read-only, ask=prompt for shell, full=auto-run shell.
  --allow-target <asset>        Seed reviewed task scope with an allowed domain or URL. Repeatable.
  --scope-file <file>           Seed reviewed task scope from a JSON file with allowed/excluded assets/classes.
  --session <file>             Session memory JSON file. Default: new timestamped session.
  --resume                     Resume from --session, or pick a recent session if omitted.
  --new                        Start a fresh session for --agent-id instead of resuming its existing one.
  --agent-id <id>              Stable coordination identity. Default: generated and saved in the session.
  --agent-role <role>          Agent role, such as coordinator or worker. Default: worker
  --agent-mission <text>       Current mission shown to other agents.
  --coordinator-id <id>        Known coordinator to contact first (or DEEPSEEK_COORDINATOR_ID).
  --coord-dir <dir>            Shared coordination directory. Default: .deepseek-watch/coordination
  --no-save-session            Do not write session memory to disk.
  -o, --output <file>          Write a Markdown result file.
  --outfile <file>             Alias for --output.
  --no-output                  Suppress terminal output. Requires --output/--outfile.
  --full-chat                  Output the full chat transcript instead of final answer + touched files.
  --dangerously-auto-run-commands
                               Run requested cmd/PowerShell commands without prompting.
  --no-tools                   Disable built-in read-only workspace tools.
  --no-color                   Disable ANSI colors.
  --tui                       Interactive full-screen view (also with -p).
  --tui-quiet                  Clean-copy mode: no status line, no in-place line rewriting (text streams line-by-line).
  --compact-provider <name>    Separate summary provider (default: active provider).
  --compact-model <name>       Separate summary model (default: active model).
  --compact-base-url <url>     Separate summary endpoint.
  --compact-at <pct>           Auto-compact when estimated context hits this fraction of the limit. Default: 0.9
  --compact-method <method>    auto|llm|truncate|detached|off. Default: auto (LLM summary, truncate fallback on error)
  --compact-limit <tokens|auto> Total context window; auto follows provider/model. Default: auto
  --compact-keep-recent <n>    Complete turns kept after compaction. Default: 15
  --no-compact                 Disable automatic context compaction (alias for --compact-method off).
  -h, --help                   Show help.
`;
}

function parseArgs(argv) {
  const initialProvider = normalizeProvider(process.env.DSW_PROVIDER || process.env.DEEPSEEK_PROVIDER || DEFAULT_PROVIDER);
  const initialConfig = providerConfig(initialProvider);
  const opts = {
    backend: process.env.SWITCHYARD_BACKEND || null,
    provider: initialProvider,
    balanceFallbackProvider: process.env.DSW_BALANCE_FALLBACK_PROVIDER || null,
    model: process.env.DSW_MODEL || process.env[`${initialProvider.toUpperCase()}_MODEL`] || initialConfig.model,
    baseUrl: process.env.DSW_BASE_URL || process.env[`${initialProvider.toUpperCase()}_BASE_URL`] || initialConfig.baseUrl,
    effort: "high",
    thinking: "enabled",
    maxTokens: 16384,
    timeout: 600000,
    retryAttempts: Number.parseInt(process.env.DEEPSEEK_RETRY_ATTEMPTS || "0", 10),
    retryDelay: Number.parseInt(process.env.DEEPSEEK_RETRY_DELAY || "1000", 10),
    retryMaxDelay: Number.parseInt(process.env.DEEPSEEK_RETRY_MAX_DELAY || "30000", 10),
    maxToolTurns: null,
    toolMode: "parallel",
    permission: null,
    session: null,
    explicitSession: false,
    saveSession: true,
    output: null,
    noOutput: false,
    fullChat: false,
    resume: false,
    newSession: false,
    dangerouslyAutoRunCommands: false,
    tools: true,
    skills: [],
    skillRoots: [],
    listSkills: false,
    color: process.env.NO_COLOR ? false : process.stdout.isTTY,
    tuiQuiet: process.env.DEEPSEEK_TUI_QUIET === "1",
    agentId: process.env.DEEPSEEK_AGENT_ID || null,
    agentRole: process.env.DEEPSEEK_AGENT_ROLE || null,
    agentMission: process.env.DEEPSEEK_AGENT_MISSION || "",
    coordinatorId: process.env.DEEPSEEK_COORDINATOR_ID || null,
    coordDir: process.env.DEEPSEEK_COORD_DIR || null,
    compactProvider: process.env.DSW_COMPACT_PROVIDER || null,
    compactModel: process.env.DSW_COMPACT_MODEL || null,
    compactBaseUrl: process.env.DSW_COMPACT_BASE_URL || null,
    compactAt: Number.parseFloat(process.env.DEEPSEEK_COMPACT_AT || "0.9"),
    compactMethod: process.env.DEEPSEEK_COMPACT_METHOD || "auto",
    contextLimit: process.env.DEEPSEEK_CONTEXT_LIMIT ? Number.parseInt(process.env.DEEPSEEK_CONTEXT_LIMIT, 10) : null,
    compactKeepRecent: Number.parseInt(process.env.DSW_COMPACT_KEEP_RECENT || process.env.DEEPSEEK_COMPACT_KEEP_RECENT || "15", 10),
    allowedTargets: [],
    scopeFile: null
  };
  let modelExplicit = false;
  let baseUrlExplicit = false;
  opts.modelExplicit = false;
  opts.baseUrlExplicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-p" || arg === "--prompt") opts.prompt = next();
    else if (arg === "--prompt-file") opts.promptFile = next();
    else if (arg === "--stdin") opts.stdin = true;
    else if (arg === "--system") opts.system = next();
    else if (arg === "--system-file") opts.systemFile = next();
    else if (arg === "--print-system") opts.printSystem = true;
    else if (arg === "--skill") opts.skills.push(next());
    else if (arg === "--skills") opts.skills.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--skill-root") opts.skillRoots.push(next());
    else if (arg === "--list-skills") opts.listSkills = true;
    else if (arg === "--backend") { opts.backend = next(); opts.backendExplicit = true; }
    else if (arg === "--provider") {
      opts.provider = normalizeProvider(next());
      opts.providerExplicit = true;
      if (!modelExplicit) opts.model = process.env.DSW_MODEL || process.env[`${opts.provider.toUpperCase()}_MODEL`] || providerConfig(opts.provider).model;
      if (!baseUrlExplicit) opts.baseUrl = process.env.DSW_BASE_URL || process.env[`${opts.provider.toUpperCase()}_BASE_URL`] || providerConfig(opts.provider).baseUrl;
    }
    else if (arg === "--balance-fallback") opts.balanceFallbackProvider = normalizeProvider(next());
    else if (arg === "--model") { opts.model = next(); modelExplicit = true; opts.modelExplicit = true; }
    else if (arg === "--base-url") { opts.baseUrl = next(); baseUrlExplicit = true; opts.baseUrlExplicit = true; }
    else if (arg === "--effort") opts.effort = next();
    else if (arg === "--thinking") opts.thinking = next();
    else if (arg === "--max-tokens") opts.maxTokens = Number.parseInt(next(), 10);
    else if (arg === "--timeout") opts.timeout = Number.parseInt(next(), 10);
    else if (arg === "--retry-attempts") opts.retryAttempts = Number.parseInt(next(), 10);
    else if (arg === "--retry-delay") opts.retryDelay = Number.parseInt(next(), 10);
    else if (arg === "--retry-max-delay") opts.retryMaxDelay = Number.parseInt(next(), 10);
    else if (arg === "--max-tool-turns") opts.maxToolTurns = Number.parseInt(next(), 10);
    else if (arg === "--tool-mode") opts.toolMode = next();
    else if (arg === "--permission") opts.permission = next();
    else if (arg === "--allow-target") opts.allowedTargets.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--scope-file") opts.scopeFile = next();
    else if (arg === "--session") {
      opts.session = next();
      opts.explicitSession = true;
    }
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--new") opts.newSession = true;
    else if (arg === "--agent-id") opts.agentId = next();
    else if (arg === "--agent-role") opts.agentRole = next();
    else if (arg === "--agent-mission") opts.agentMission = next();
    else if (arg === "--coordinator-id") opts.coordinatorId = next();
    else if (arg === "--coord-dir") opts.coordDir = next();
    else if (arg === "--no-save-session") opts.saveSession = false;
    else if (arg === "-o" || arg === "--output" || arg === "--outfile") opts.output = next();
    else if (arg === "--no-output") opts.noOutput = true;
    else if (arg === "--no-update-check") opts.noUpdateCheck = true;
    else if (arg === "--full-chat") opts.fullChat = true;
    else if (arg === "--dangerously-auto-run-commands") opts.dangerouslyAutoRunCommands = true;
    else if (arg === "--no-tools") opts.tools = false;
    else if (arg === "--no-color") opts.color = false;
    else if (arg === "--tui") opts.interactiveChat = true;
    else if (arg === "--tui-quiet") opts.tuiQuiet = true;
    else if (arg === "--compact-provider") opts.compactProvider = normalizeProvider(next());
    else if (arg === "--compact-model") opts.compactModel = next();
    else if (arg === "--compact-base-url") opts.compactBaseUrl = next();
    else if (arg === "--compact-at") opts.compactAt = Number.parseFloat(next());
    else if (arg === "--compact-method") opts.compactMethod = next();
    else if (arg === "--compact-limit") {
      const value = next();
      opts.contextLimit = value.toLowerCase() === "auto" ? null : Number.parseInt(value, 10);
    }
    else if (arg === "--compact-keep-recent") { opts.compactKeepRecent = Number.parseInt(next(), 10); opts.compactKeepRecentExplicit = true; }
    else if (arg === "--no-compact") opts.compactMethod = "off";
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function validateOpts(opts) {
  if (opts.backend && !["api", "codex", "claude"].includes(opts.backend)) throw new Error("--backend must be api, codex, or claude.");
  if (opts.help || opts.printSystem || opts.listSkills) return;
  const promptSources = [opts.prompt, opts.promptFile, opts.stdin].filter(Boolean).length;
  if (promptSources === 0) {
    if (!process.stdin.isTTY) throw new Error("Provide --prompt, --prompt-file, or --stdin when stdin is not interactive.");
    opts.interactiveChat = true;
  }
  if (promptSources > 1) throw new Error("Use only one prompt source.");
  if (!["enabled", "disabled"].includes(opts.thinking)) throw new Error("--thinking must be enabled or disabled.");
  if (!["high", "max"].includes(opts.effort)) throw new Error("--effort must be high or max.");
  if (!["parallel", "sequential"].includes(opts.toolMode)) throw new Error("--tool-mode must be parallel or sequential.");
  if (!Number.isInteger(opts.retryAttempts) || opts.retryAttempts < 0) throw new Error("--retry-attempts must be a non-negative integer (0 = retry forever).");
  if (!Number.isInteger(opts.retryDelay) || opts.retryDelay < 100) throw new Error("--retry-delay must be at least 100 ms.");
  if (!Number.isInteger(opts.retryMaxDelay) || opts.retryMaxDelay < opts.retryDelay) throw new Error("--retry-max-delay must be >= --retry-delay.");
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("--timeout must be a positive number.");
  if (opts.permission && !["review", "ask", "full"].includes(opts.permission)) throw new Error("--permission must be review, ask, or full.");
  if (opts.balanceFallbackProvider && opts.balanceFallbackProvider === opts.provider) throw new Error("--balance-fallback must name a different provider.");
  if (opts.resume && !opts.saveSession) throw new Error("--resume cannot be combined with --no-save-session.");
  if (opts.resume && opts.newSession) throw new Error("--resume and --new cannot be combined.");
  if (opts.scopeFile && opts.allowedTargets.length) throw new Error("Use --scope-file or --allow-target, not both.");
  if (opts.noOutput && !opts.output) throw new Error("--no-output requires --output <file> or --outfile <file>.");
  if (opts.fullChat && !opts.output) throw new Error("--full-chat requires --output <file> or --outfile <file>.");
  if (!Number.isFinite(opts.compactAt) || opts.compactAt <= 0 || opts.compactAt > 1) throw new Error("--compact-at must be a fraction in (0, 1].");
  if (!["auto", "llm", "truncate", "detached", "off"].includes(opts.compactMethod)) throw new Error("--compact-method must be auto, llm, truncate, detached, or off.");
  if (!Number.isInteger(opts.compactKeepRecent) || opts.compactKeepRecent < 1) throw new Error("--compact-keep-recent must be an integer >= 1.");
  if (opts.contextLimit !== null && (!Number.isFinite(opts.contextLimit) || opts.contextLimit < 2000)) throw new Error("--compact-limit must be auto or at least 2000 tokens.");
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolvePromise(text));
  });
}

async function loadPrompt(opts) {
  if (opts.promptFile) return readFile(resolve(opts.promptFile), "utf8");
  if (opts.stdin) return readStdin();
  if (opts.interactiveChat && !opts.prompt) {
    const prompt = await promptLine("Prompt> ");
    if (!prompt.trim()) opts.quit = true;
    return prompt;
  }
  return opts.prompt;
}

// Skills discovery, storage, and the `switchyard skill` command group live in
// ./skills.js (import-safe so the self-tests can unit-test them directly).

function normalizeList(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function updateSystemMessage(session, systemPrompt) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const index = messages.findIndex((message) => message.role === "system");
  if (index >= 0) {
    messages[index] = { ...messages[index], content: systemPrompt };
  } else {
    messages.unshift({ role: "system", content: systemPrompt });
  }
  session.messages = messages;
}

function gitBranch() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function runtimeContext() {
  const branch = gitBranch();
  const openAiConfigured = Boolean(await getProviderApiKey("openai"));
  const openAiModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  const searchProviders = configuredSearchProviders();
  return [
    `date: ${new Date().toISOString()}`,
    `device_os: ${platform()} ${release()} ${arch()}`,
    `user: ${userInfo().username}`,
    `workspace: ${process.cwd()}`,
    `shell: ${process.env.ComSpec || process.env.SHELL || "unknown"}`,
    `node: ${process.version}`,
    `openai_vision: ${openAiConfigured ? "configured" : "not_configured"}`,
    `openai_vision_model: ${openAiModel}`,
    "openai_api_key_setup: https://platform.openai.com/api-keys",
    `web_search_default: ${selectedSearchProvider()}`,
    `web_search_providers: ${searchProviders.join(", ")}`,
    "google_search_setup: https://programmablesearchengine.google.com/controlpanel/all",
    branch ? `git_branch: ${branch}` : "git_branch: none"
  ].join("\n");
}

function agentIdentityContext(opts) {
  if (!opts.agentId) return "";
  return [
    "",
    "---",
    "",
    "## Agent coordination identity",
    "",
    `You are agent ${opts.agentId}. Keep this identity for the entire session and include it when communicating with other agents.`,
    `agent_id: ${opts.agentId}`,
    `agent_role: ${opts.agentRole || "worker"}`,
    `agent_mission: ${opts.agentMission || "(not assigned)"}`,
    `coordinator_id: ${opts.coordinatorId || "(unknown)"}`,
    `context_limit: ${opts.contextLimit || "auto"}`,
    `coordination_directory: ${opts.coordDir || "(not initialized)"}`,
    "At the start of a worker session, announce yourself and your mission to coordinator_id with agent_send (type=status) before other coordination discovery. Do not call agent_list merely to announce when coordinator_id is known. If coordinator_id is unknown, use agent_list once to find the coordinator, then send the direct announcement. Use agent_task_list/agent_claim for bounded work, agent_handoff for results, and agent_wait only when you are ready to park until a message arrives. Treat scopes claimed by other agents as read-only unless they explicitly hand them off."
  ].join("\n");
}

async function loadSystemPrompt(opts) {
  if (opts.system) return `${opts.system.replace("{{context}}", await runtimeContext())}${agentIdentityContext(opts)}${await renderLoadedSkills(opts)}`;
  let template;
  if (opts.systemFile) {
    template = await readFile(resolve(opts.systemFile), "utf8");
  } else if (EMBEDDED_SYSTEM_PROMPT) {
    template = EMBEDDED_SYSTEM_PROMPT;
  } else {
    template = await readFile(DEFAULT_SYSTEM_PROMPT_FILE, "utf8");
  }
  return `${template.replace("{{context}}", await runtimeContext())}${agentIdentityContext(opts)}${await renderLoadedSkills(opts)}`;
}

function color(opts, code, text) {
  return opts.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const ICONS = {
  thinking: "◌",
  final: "▸",
  tools: "◆",
  session: "◉",
  warn: "✕",
  ok: "✓"
};

function dim(opts, text) {
  return color(opts, "2", text);
}

function cyan(opts, text) {
  return color(opts, "36", text);
}

function green(opts, text) {
  return color(opts, "32", text);
}

function yellow(opts, text) {
  return color(opts, "33", text);
}

function red(opts, text) {
  return color(opts, "31", text);
}

function bold(opts, text) {
  return color(opts, "1", text);
}

function supportsTerminalLinks(opts) {
  return !opts.noOutput && process.stdout.isTTY && process.env.DEEPSEEK_NO_FILE_LINKS !== "1";
}

function setTerminalTitle(title) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\x1b]0;${String(title).replace(/[\x07\x1b]/g, "")}\x07`);
}

function terminalLink(opts, text, target) {
  if (!supportsTerminalLinks(opts)) return text;
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function workspaceFileLink(opts, relPath, display = relPath) {
  const text = String(display || relPath || "");
  if (!text) return text;
  try {
    const abs = assertInsideWorkspace(String(relPath));
    return terminalLink(opts, text, pathToFileURL(abs).href);
  } catch {
    return text;
  }
}

function collectPathLikeValues(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /(^|_)(path|file)$|^(path|file_path|prompt_file|output_file|log_file)$/i.test(key)) {
      out.add(item);
    } else {
      collectPathLikeValues(item, out);
    }
  }
  return out;
}

function applyKnownFileLinks(opts, text, paths) {
  if (!supportsTerminalLinks(opts)) return text;
  let linked = String(text || "");
  const known = [...paths].filter(Boolean).sort((a, b) => String(b).length - String(a).length);
  for (const value of known) {
    const pathText = String(value);
    linked = linked.replace(new RegExp(escapeRegex(pathText), "g"), workspaceFileLink(opts, pathText));
    if (pathText.includes("\\")) {
      const jsonEscapedPath = pathText.replace(/\\/g, "\\\\");
      linked = linked.replace(new RegExp(escapeRegex(jsonEscapedPath), "g"), workspaceFileLink(opts, pathText, jsonEscapedPath));
    }
  }
  return linked;
}

function formatCompactCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  if (count < 1000) return String(count);
  const units = [
    [1_000_000_000, "b"],
    [1_000_000, "m"],
    [1_000, "k"]
  ];
  for (const [size, suffix] of units) {
    if (count >= size) return `${(count / size).toFixed(2)}${suffix}`;
  }
  return String(count);
}

const STREAM_STATUS_PHRASES = [
  "Generating",
  "Thinking",
  "Working",
  "Preparing",
  "Drafting"
];

function randomStatusPhrase(phrases = STREAM_STATUS_PHRASES) {
  return phrases[Math.floor(Math.random() * phrases.length)] || "Working";
}

let activeStatusLine = null;

function createStatusLine(opts, phrase = "Working", initialTokens = 0) {
  if (opts.ui) return opts.ui.status(phrase, initialTokens);
  if (opts.noOutput || opts.tuiQuiet || !process.stdout.isTTY) {
    return {
      isActive() { return false; },
      addTokens() {},
      setTokens() {},
      setPhrase() {},
      setBlocked() {},
      refresh() {},
      clear() {},
      stop() {}
    };
  }

  let tokens = initialTokens;
  let currentPhrase = phrase;
  let active = true;
  let visible = false;
  let blocked = false;
  let frame = 0;
  let lastRenderAt = 0;
  // When a streaming markdown writer attaches, it becomes the sole owner of the
  // bottom terminal row: this status stops drawing to stdout directly and hands
  // the writer its formatted line() via the attached redraw() on each tick. That
  // single-writer discipline is what stopped stale status lines leaking into the
  // scrollback outside VS Code's terminal.
  let attached = null;
  const started = Date.now();

  const modelLabel = String(opts?.model || "").split("/").pop() || "";
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const format = () => {
    const spinner = SPINNER[frame % SPINNER.length];
    const elapsed = formatDuration(Date.now() - started);
    const parts = [spinner, currentPhrase, `${tokens} tokens`, elapsed];
    if (modelLabel) parts.splice(1, 0, modelLabel);
    return parts.join(" · ");
  };
  // Standalone draw (no writer attached): clear the row and redraw in place.
  const drawStandalone = () => {
    if (blocked) return;
    const now = Date.now();
    // Throttle: redraw at most every 250ms so terminal selection/copy is not
    // flooded with near-identical status lines.
    if (now - lastRenderAt < 250) return;
    lastRenderAt = now;
    let text = `  ${format()}`;
    const columns = Math.max(process.stdout.columns || 120, 1);
    if ([...text].length > columns - 1) text = `${[...text].slice(0, columns - 2).join("")}…`;
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(dim(opts, text));
    visible = true;
  };
  const render = () => {
    if (!active) return;
    frame += 1;
    if (attached) { attached.redraw?.(); return; }
    drawStandalone();
  };

  // Animated spinner: redraws are throttled and skipped while content streams
  // (blocked), so the ⠋ keeps spinning during thinking/tool phases without
  // flooding terminal copies with status lines.
  render();
  const timer = setInterval(render, 120);

  const status = {
    isActive() {
      return active;
    },
    addTokens(value) {
      // Update the counter silently; the visible redraw happens at line
      // completions (finalize) and phase changes, so copies don't fill up
      // with per-token status lines.
      tokens += estimateTokens(value);
    },
    setTokens(value) {
      tokens = Math.max(0, Math.ceil(Number(value) || 0));
      if (!blocked) render();
    },
    setPhrase(value) {
      currentPhrase = value || currentPhrase;
      if (!blocked) render();
    },
    setBlocked(value) {
      blocked = Boolean(value);
      if (!blocked && active) render();
    },
    refresh() {
      if (active) render();
    },
    // The formatted status string for the owning writer to render as its bottom
    // row; null when there is nothing to show (inactive or blocked).
    line() {
      if (!active || blocked) return null;
      return dim(opts, format());
    },
    // Hand bottom-row ownership to a streaming writer. Erase any status this
    // object drew standalone so the writer can re-park it in its own region.
    attach(hooks) {
      attached = hooks || null;
      if (attached && visible) {
        clearLine(process.stdout, 0);
        cursorTo(process.stdout, 0);
        visible = false;
      }
    },
    detach() { attached = null; },
    // Erase whatever the owning writer has at the bottom (status or partial)
    // before some other code writes directly to stdout (e.g. a section heading),
    // so the pinned status is never stranded above that output.
    clearRegion() {
      if (attached) { attached.clearRegion?.(); visible = false; return; }
      this.clear();
    },
    clear() {
      if (attached) { visible = false; return; }
      if (!visible) return;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      visible = false;
    },
    stop() {
      active = false;
      attached = null;
      clearInterval(timer);
      if (activeStatusLine === status) activeStatusLine = null;
      this.clear();
    }
  };
  activeStatusLine = status;
  return status;
}

function toolStatusPhrase(name) {
  if (name === "write_text_file") return "Writing file";
  if (name === "patch_text_file" || name === "patch_files") return "Patching files";
  if (name === "run_cmd" || name === "run_bash" || name === "run_powershell" || name === "functions_shell_command" || name === "functions.shell_command") return "Running command";
  if (name === "web_search" || name === "web_fetch") return "Reading web";
  if (name === "analyze_image_openai" || name === "view_image") return "Reading image";
  return randomStatusPhrase(["Running tool", "Working", "Processing"]);
}

// ── Workspace traversal helpers ────────────────────────────────────────────

const DEFAULT_TRAVERSE_EXCLUDES = [
  ".git", ".deepseek-watch", "node_modules", "dist", "build", "out", ".next", ".nuxt",
  ".cache", "__pycache__", "coverage", ".nyc_output", ".tsbuildinfo"
];

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".db", ".sqlite", ".sqlite3", ".wasm",
  ".ttf", ".otf", ".woff", ".woff2",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg", ".mkv",
  ".class", ".jar", ".pyc"
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern) {
  let re = "";
  let i = 0;
  const norm = pattern.replace(/\\/g, "/");
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*" && norm[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (norm[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = norm.indexOf("}", i);
      if (end === -1) { re += "\\{"; i++; }
      else {
        const alts = norm.slice(i + 1, end).split(",").map(escapeRegex);
        re += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (/[.+^$|()[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

async function isBinaryFile(absPath) {
  if (BINARY_EXTS.has(extname(absPath).toLowerCase())) return true;
  try {
    const fh = await open(absPath, "r");
    try {
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fh.read(buf, 0, 512, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function* walkDir(root, dir, { excludeDirNames = DEFAULT_TRAVERSE_EXCLUDES, excludeGlobRxs = [], type = "all", depth = 0, maxDepth = Infinity } = {}) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (excludeDirNames.includes(entry.name)) continue;
      if (excludeGlobRxs.some((rx) => rx.test(rel))) continue;
      if (type !== "file") yield { absPath: abs, relPath: rel, isDir: true };
      if (depth < maxDepth) yield* walkDir(root, abs, { excludeDirNames, excludeGlobRxs, type, depth: depth + 1, maxDepth });
    } else if (entry.isFile()) {
      if (excludeGlobRxs.some((rx) => rx.test(rel))) continue;
      if (type !== "dir") yield { absPath: abs, relPath: rel, isDir: false };
    }
  }
}

async function runGit(gitArgs, cwd = process.cwd()) {
  return new Promise((resolvePromise) => {
    const child = spawn("git", gitArgs, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); resolvePromise({ ok: false, out: "", err: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, out: stdout, err: stderr }); });
  });
}

async function buildTreeLines(absDir, prefix, depth, maxDepth) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return []; }
  const visible = entries.filter((e) => !DEFAULT_TRAVERSE_EXCLUDES.includes(e.name));
  const lines = [];
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const isLast = i === visible.length - 1;
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory() && depth < maxDepth) {
      const sub = await buildTreeLines(join(absDir, entry.name), prefix + (isLast ? "    " : "│   "), depth + 1, maxDepth);
      lines.push(...sub);
    }
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────────

function label(opts, icon, text, code = "1;36") {
  return color(opts, code, `${icon} ${text}`);
}

function heading(opts, text, kind = "info") {
  if (opts.ui) { if (!["thinking", "final", "tools"].includes(kind)) opts.ui.add(kind, text); return; }
  if (opts.noOutput) return;
  const styles = {
    thinking: ["2;36", ICONS.thinking],
    final: ["1;32", ICONS.final],
    tools: ["1;33", ICONS.tools],
    session: ["2;35", ICONS.session],
    warn: ["1;31", ICONS.warn],
    info: ["1;36", "·"]
  };
  const [code, icon] = styles[kind] || styles.info;
  const prefix = `${icon} ${text} `;
  const fill = Math.max(0, 72 - prefix.length);
  if (activeStatusLine) activeStatusLine.clearRegion();
  process.stdout.write(`\n${color(opts, code, prefix)}${dim(opts, "─".repeat(fill))}\n`);
  if (activeStatusLine) activeStatusLine.refresh();
}

function writeSessionNotice(opts, path) {
  if (opts.ui) return;
  if (opts.noOutput) return;
  process.stderr.write(`  ${color(opts, "2;35", `${ICONS.session} session`)}  ${dim(opts, terminalLink(opts, path, pathToFileURL(resolve(path)).href))}\n`);
}

function compactDisplayString(value, max = 700) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(80, max - head - 80);
  return `${text.slice(0, head)}\n... [truncated ${text.length - max} chars] ...\n${text.slice(-tail)}`;
}

function compactToolArgsForDisplay(value) {
  if (Array.isArray(value)) return value.map(compactToolArgsForDisplay);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && ["content", "old_string", "new_string"].includes(key)) {
      out[key] = compactDisplayString(item);
      out[`${key}_display_note`] = `truncated for terminal display; original length ${item.length} chars`;
    } else {
      out[key] = compactToolArgsForDisplay(item);
    }
  }
  return out;
}

function formatJsonish(raw, name = "") {
  try {
    const parsed = JSON.parse(raw || "{}");
    const shouldCompact = ["write_text_file", "patch_text_file", "patch_files"].includes(name);
    return JSON.stringify(shouldCompact ? compactToolArgsForDisplay(parsed) : parsed, null, 2);
  } catch {
    return compactDisplayString(raw, 1600);
  }
}

function writeToolCall(opts, name, rawArgs) {
  if (opts.noOutput) return;
  process.stdout.write(`  ${yellow(opts, "▹")} ${bold(opts, name)}\n`);
  let display = formatJsonish(rawArgs, name);
  try {
    display = applyKnownFileLinks(opts, display, collectPathLikeValues(JSON.parse(rawArgs || "{}")));
  } catch {}
  process.stdout.write(`${dim(opts, display).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
}

function writeToolResult(opts, result, knownPaths = []) {
  if (opts.ui) return;
  if (opts.noOutput) return;
  const text = String(result);
  const display = text.length > 4000 ? `${text.slice(0, 4000)}\n  …` : text;
  const isError = text === "blocked by user" || text.startsWith("Tool error:") || text.startsWith("command error:");
  const code = isError ? "31" : "2";
  const paths = new Set([...(knownPaths || []), ...(opts.touchedFiles || [])]);
  const linked = applyKnownFileLinks(opts, display, paths);
  process.stdout.write(`${color(opts, code, linked.split("\n").map((line) => `    ${line}`).join("\n"))}\n`);
}

function readTextFileDisplay(args, result) {
  const path = args?.path || "(unknown)";
  const text = String(result);
  if (text.startsWith("File too large:")) return `read_text_file ${path}\n${text}`;
  const offset = Number(args?.offset) || 0;
  const suffix = offset > 0 ? ` from offset ${offset}` : "";
  return `read_text_file ${path}${suffix}`;
}

function toolDisplayResult(name, args, result) {
  if (name === "read_text_file") return readTextFileDisplay(args, result);
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function jsonResult(value) {
  const text = JSON.stringify(value, null, 2);
  const max = 24000;
  if (text.length <= max) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, max), total_chars: text.length, note: "Tool result exceeded the context limit; use the referenced artifact, pagination, or a narrower query." }, null, 2);
}

function parseCommandLineArgs(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in cli_args.");
  if (current) args.push(current);
  return args;
}

function compactMessageForSummary(message, max = 500) {
  const role = message.role || "message";
  if (role === "tool") return `[tool ${message.tool_call_id || ""}] ${compactText(message.content, max)}`;
  if (message.tool_calls?.length) {
    const names = message.tool_calls.map((call) => call.function?.name || "tool").join(", ");
    const content = compactText(message.content || "", max);
    return content ? `[assistant tools: ${names}] ${content}` : `[assistant tools: ${names}]`;
  }
  return `[${role}] ${compactText(message.content || "", max)}`;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const radix = key[1] === "x" ? 16 : 10;
      const codePoint = Number.parseInt(key.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function htmlToText(value) {
  const html = String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|aside|nav|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(html)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlTitle(value) {
  const match = String(value || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : "";
}

function unwrapDuckDuckGoUrl(rawUrl) {
  const decoded = decodeHtmlEntities(rawUrl);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg || url.href;
  } catch {
    return decoded;
  }
}

function formatSearchResults(provider, query, results) {
  if (!results.length) return `No ${provider} results for: ${query}`;
  const lines = [`${provider} results for: ${query}`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function googleSearchConfigured() {
  return Boolean(process.env.GOOGLE_SEARCH_API_KEY && (process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID));
}

function configuredSearchProviders() {
  const providers = [];
  if (googleSearchConfigured()) providers.push("google");
  if (process.env.BRAVE_SEARCH_API_KEY) providers.push("brave");
  providers.push("duckduckgo");
  return providers;
}

function selectedSearchProvider() {
  const provider = String(process.env.WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
  if (provider && provider !== "auto") return provider;
  return configuredSearchProviders()[0] || "duckduckgo";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoHtml(html, maxResults) {
  const results = [];
  const blockPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  const blocks = html.match(blockPattern) || [];
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = unwrapDuckDuckGoUrl(anchor[1]);
    const title = stripHtml(anchor[2]);
    if (!url || !title) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = stripHtml(snippetMatch?.[1] || snippetMatch?.[2] || "");
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function parseDuckDuckGoLiteHtml(html, maxResults) {
  const results = [];
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) && results.length < maxResults) {
    const title = stripHtml(match[2]);
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (!title || !url) continue;
    if (/duckduckgo\.com\/(html|lite)/i.test(url)) continue;
    if (results.some((result) => result.url === url)) continue;
    results.push({ title, url, snippet: "" });
  }
  return results;
}

async function duckDuckGoSearch(query, maxResults, timeRange) {
  const params = new URLSearchParams({ q: query });
  const timeMap = { day: "d", week: "w", month: "m", year: "y" };
  if (timeMap[timeRange]) params.set("df", timeMap[timeRange]);
  const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 deepseek-detached-agent"
    },
    body: params.toString()
  });
  if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  const html = await response.text();
  const results = parseDuckDuckGoHtml(html, maxResults);
  if (results.length) return formatSearchResults("DuckDuckGo", query, results);

  const liteUrl = new URL("https://lite.duckduckgo.com/lite/");
  liteUrl.searchParams.set("q", query);
  if (timeMap[timeRange]) liteUrl.searchParams.set("df", timeMap[timeRange]);
  const liteResponse = await fetchWithTimeout(liteUrl, {
    headers: { "User-Agent": "Mozilla/5.0 deepseek-detached-agent" }
  });
  if (!liteResponse.ok) throw new Error(`DuckDuckGo Lite search failed: HTTP ${liteResponse.status}`);
  const liteHtml = await liteResponse.text();
  return formatSearchResults("DuckDuckGo Lite", query, parseDuckDuckGoLiteHtml(liteHtml, maxResults));
}

async function braveSearch(query, maxResults) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": key
    }
  });
  if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
  const data = await response.json();
  const results = (data.web?.results || []).slice(0, maxResults).map((item) => ({
    title: stripHtml(item.title),
    url: item.url,
    snippet: stripHtml(item.description)
  }));
  return formatSearchResults("Brave Search", query, results);
}

async function googleSearch(query, maxResults) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return null;
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(Math.min(maxResults, 10)));
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "deepseek-detached-agent"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `HTTP ${response.status}`;
    throw new Error(`Google Custom Search failed: ${message}`);
  }
  const results = (data.items || []).slice(0, maxResults).map((item) => ({
    title: stripHtml(item.title),
    url: item.link,
    snippet: stripHtml(item.snippet)
  }));
  return formatSearchResults("Google Custom Search", query, results);
}

async function webSearch(args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query must be a non-empty string.");
  const maxResults = Math.min(Math.max(Number(args.max_results) || 5, 1), 10);
  const site = String(args.site || "").trim();
  const scopedQuery = site ? `${query} site:${site}` : query;
  const requestedProvider = String(args.provider || process.env.WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
  if (requestedProvider === "google") {
    const google = await googleSearch(scopedQuery, maxResults);
    if (!google) throw new Error("Google search is not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID, or run switchyard config set-google-search-key and switchyard config set-google-search-engine-id.");
    return google;
  }
  if (requestedProvider === "brave") {
    const brave = await braveSearch(scopedQuery, maxResults);
    if (!brave) throw new Error("Brave search is not configured. Set BRAVE_SEARCH_API_KEY.");
    return brave;
  }
  if (requestedProvider !== "auto" && requestedProvider !== "duckduckgo") {
    throw new Error("provider must be one of: auto, google, brave, duckduckgo.");
  }
  if (requestedProvider === "auto") {
    const fallbackNotes = [];
    try {
      const google = await googleSearch(scopedQuery, maxResults);
      if (google) return google;
    } catch (error) {
      fallbackNotes.push(`Google Custom Search unavailable: ${error.message}`);
    }
    try {
      const brave = await braveSearch(scopedQuery, maxResults);
      if (brave) {
        return fallbackNotes.length ? `${fallbackNotes.join("\n")}\n\n${brave}` : brave;
      }
    } catch (error) {
      fallbackNotes.push(`Brave Search unavailable: ${error.message}`);
    }
    const duck = await duckDuckGoSearch(scopedQuery, maxResults, args.time_range);
    return fallbackNotes.length ? `${fallbackNotes.join("\n")}\n\n${duck}` : duck;
  }
  return duckDuckGoSearch(scopedQuery, maxResults, args.time_range);
}

async function fetchReadableUrl(rawUrl, timeoutMs = 20000) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must use http or https.");
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html, text/plain, application/xhtml+xml, application/xml;q=0.9, */*;q=0.5",
      "User-Agent": "Mozilla/5.0 deepseek-detached-agent"
    }
  }, Math.min(Number(timeoutMs) || 20000, 60000));
  if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  const text = /html|xml|xhtml/i.test(contentType) || /<html|<!doctype html/i.test(raw)
    ? htmlToText(raw)
    : raw.replace(/\r\n/g, "\n").trim();
  const title = /html|xhtml/i.test(contentType) ? htmlTitle(raw) : "";
  return { url, contentType, raw, text, title };
}

async function webFetch(args) {
  const rawUrl = String(args.url || "").trim();
  if (!rawUrl) throw new Error("url must be a non-empty string.");
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 12000, 1000), 50000);
  const offset = Math.max(Number(args.offset) || 0, 0);
  const { url, contentType, text, title } = await fetchReadableUrl(rawUrl, args.timeout_ms);
  const chunk = text.slice(offset, offset + maxChars);
  const nextOffset = offset + maxChars < text.length ? offset + maxChars : null;

  if (args.structured) {
    return JSON.stringify({
      url: url.href,
      title,
      content_type: contentType,
      content: chunk,
      next_offset: nextOffset,
      total_chars: text.length
    }, null, 2);
  }

  const lines = [`URL: ${url.href}`];
  if (title) lines.push(`Title: ${title}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);
  lines.push("", chunk || "(no readable text)");
  if (nextOffset != null) lines.push("", `[chunk ${offset}-${offset + chunk.length} of ${text.length} chars; continue with offset ${nextOffset}]`);
  return lines.join("\n");
}

async function webFind(args) {
  const rawUrl = String(args.url || "").trim();
  if (!rawUrl) throw new Error("url must be a non-empty string.");
  const pattern = String(args.pattern || "");
  if (!pattern) throw new Error("pattern must be a non-empty regex pattern string.");
  const flags = String(args.flags || "i").replace(/[^dgimsuvy]/g, "");
  const safeFlags = flags.includes("g") ? flags : `${flags}g`;
  const contextChars = Math.min(Math.max(Number(args.context_chars) || 160, 0), 1000);
  const maxResults = Math.min(Math.max(Number(args.max_results) || 20, 1), 100);
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 50000, 1000), 250000);
  const { url, contentType, text, title } = await fetchReadableUrl(rawUrl, args.timeout_ms);
  const haystack = text.slice(0, maxChars);
  let regex;
  try {
    regex = new RegExp(pattern, safeFlags);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error.message}`);
  }
  const matches = [];
  let match;
  while ((match = regex.exec(haystack)) && matches.length < maxResults) {
    const start = match.index;
    const end = start + match[0].length;
    const before = haystack.slice(Math.max(0, start - contextChars), start);
    const after = haystack.slice(end, Math.min(haystack.length, end + contextChars));
    matches.push({
      match: match[0],
      offset: start,
      context: `${before}${match[0]}${after}`.replace(/\s+/g, " ").trim()
    });
    if (match[0] === "") regex.lastIndex += 1;
  }
  return JSON.stringify({
    url: url.href,
    title,
    content_type: contentType,
    pattern,
    flags: safeFlags,
    searched_chars: haystack.length,
    total_chars: text.length,
    matches
  }, null, 2);
}

const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"]
]);

function imageMime(path) {
  return IMAGE_MIME_BY_EXT.get(extname(path).toLowerCase()) || "application/octet-stream";
}

function imageDimensions(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/bmp" && buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
    return { width: buffer.readUInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (mime === "image/webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  if (mime === "image/svg+xml") {
    const text = buffer.subarray(0, Math.min(buffer.length, 5000)).toString("utf8");
    const svg = text.match(/<svg\b[^>]*>/i)?.[0] || "";
    const width = Number.parseFloat(svg.match(/\bwidth=["']?([0-9.]+)/i)?.[1] || "");
    const height = Number.parseFloat(svg.match(/\bheight=["']?([0-9.]+)/i)?.[1] || "");
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
    const viewBox = svg.match(/\bviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)/i);
    if (viewBox) return { width: Number.parseFloat(viewBox[1]), height: Number.parseFloat(viewBox[2]) };
  }
  if (mime === "image/jpeg" && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function viewImage(args) {
  const target = assertInsideWorkspace(args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Path is not a file.");
  const mime = imageMime(args.path);
  if (!mime.startsWith("image/")) throw new Error(`Unsupported image extension: ${extname(args.path) || "(none)"}`);
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 4000000, 1), 12000000);
  const includeData = args.include_data_url !== false;
  const buffer = await readFile(target);
  const dimensions = imageDimensions(buffer, mime);
  const result = {
    path: args.path,
    mime,
    size_bytes: info.size,
    dimensions,
    vision_available: false,
    note: "This tool does not visually interpret image content. Use analyze_image_openai for real image understanding when OPENAI_API_KEY is configured.",
    data_url_included: includeData && buffer.length <= maxBytes
  };
  if (includeData && buffer.length <= maxBytes) {
    result.data_url = `data:${mime};base64,${buffer.toString("base64")}`;
  } else if (includeData) {
    result.data_url_note = `Image is ${buffer.length} bytes, above max_bytes=${maxBytes}; raise max_bytes or set include_data_url=false for metadata only.`;
  }
  return JSON.stringify(result, null, 2);
}

function extractOpenAiOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

async function analyzeImageOpenAI(args) {
  const apiKey = await getProviderApiKey("openai");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Create an OpenAI API key, then set $env:OPENAI_API_KEY before running d/dsw.");

  const target = assertInsideWorkspace(args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Path is not a file.");
  const mime = imageMime(args.path);
  if (!mime.startsWith("image/")) throw new Error(`Unsupported image extension: ${extname(args.path) || "(none)"}`);
  const buffer = await readFile(target);
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 12000000, 1), 20000000);
  if (buffer.length > maxBytes) {
    throw new Error(`Image is ${buffer.length} bytes, above max_bytes=${maxBytes}. Crop/compress it or raise max_bytes.`);
  }

  const prompt = String(args.prompt || "Describe the image precisely. If it contains text or code, transcribe it exactly before summarizing.").trim();
  const model = String(args.model || process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini").trim();
  const maxOutputTokens = Math.min(Math.max(Number(args.max_output_tokens) || 1200, 100), 8000);
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    })
  }, Math.min(Number(args.timeout_ms) || 60000, 180000));

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: HTTP ${response.status}${text ? ` ${compactText(text, 800)}` : ""}`);
  }

  const data = await response.json();
  const output = extractOpenAiOutputText(data);
  if (!output) return JSON.stringify({ path: args.path, model, output: "", raw_status: data.status || null }, null, 2);
  return output;
}

function compactText(value, max = 900) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n...`;
}

function sessionLabel(item, index) {
  const prompt = item.firstUserPrompt.replace(/\s+/g, " ").slice(0, 70);
  const when = item.updatedAt || item.createdAt || "unknown";
  const permission = `${item.backend && item.backend !== "api" ? `[${item.backend}] ` : ""}${item.permission ? `[${item.permission}]` : ""}`;
  const agent = item.agentId ? ` ${item.agentId}` : "";
  return `${String(index + 1).padStart(2, " ")}  ${when}${agent} ${permission}  ${prompt || "(no prompt)"}`;
}

async function pickMenu(opts, title, hint, items) {
  if (opts.startupUi) return (await opts.startupUi.select(title, hint, items)) ?? "quit";
  process.stdout.write(`\n  ${bold(opts, title)}\n`);
  process.stdout.write(`  ${dim(opts, hint)}\n\n`);
  items.forEach((item, i) => {
    process.stdout.write(`  ${dim(opts, `${i + 1}.`)} ${item.label}\n`);
  });
  process.stdout.write("\n");
  while (true) {
    const answer = await promptLine(`  Enter choice (1-${items.length}, q to quit): `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "") return "quit";
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= items.length) return items[n - 1].id;
    process.stdout.write(`  Invalid. Enter 1-${items.length} or q.\n`);
  }
}

async function pickDashboardAction(opts) {
  return pickMenu(opts, "Switchyard", "Choose your next step. Use arrows or a number.", [
    { id: "new", label: "New run" },
    { id: "resume", label: "Resume session" },
    { id: "agents", label: "Agents - send messages, wake parked" },
    { id: "config", label: "Show config path" },
    { id: "help", label: "Show help" },
    { id: "quit", label: "Quit" }
  ]);
}

function promptLine(question) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.resume();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(0);
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function pickPermission(opts) {
  return pickMenu(opts, "Permission level", "Choose what this session may do.", [
    { id: "review", label: (["codex", "claude"].includes(opts.backend) ? "Review - native read-only tools/sandbox" : "Review only - read files, no shell commands") },
    { id: "ask", label: (["codex", "claude"].includes(opts.backend) ? "Ask - native approval requests appear in Switchyard" : "Ask before commands - prompt for cmd/PowerShell") },
    { id: "full", label: "Full access - auto-run cmd/PowerShell" }
  ]);
}

async function dashboardOpts() {
  const opts = parseArgs([]);
  if (!process.stdin.isTTY) { opts.help = true; return opts; }
  const open = () => {
    if (process.stdout.isTTY && !opts.tuiQuiet && process.env.TERM !== "dumb") {
      opts.startupUi = new TerminalUI({ ...opts, provider: "Welcome", model: "Choose a connection" }).start();
      opts.startupUi.busy = false; opts.startupUi.phase = "Set up your session";
    }
  };
  open();
  const notice = text => opts.startupUi ? opts.startupUi.add("notice", text) : process.stdout.write(`${text}\n`);
  const ask = question => opts.startupUi ? opts.startupUi.ask(question) : promptLine(`${question}> `);
  const choose = async (title, hint, items) => { const result = await pickMenu(opts, title, hint, items); return result === "quit" ? null : result; };
  try {
    for (;;) {
      const action = await pickDashboardAction(opts);
      if (action === "quit") { opts.quit = true; return opts; }
      if (action === "help") { opts.help = true; return opts; }
      if (action === "config") { await ask(`Configuration: ${configPath()}\nPress Enter to return`); continue; }
      if (action === "agents") {
        opts.startupUi?.close(); opts.startupUi = null;
        await runCoordinationCommand("agents", ["--interactive"]); open(); continue;
      }
      if (action === "resume") {
        opts.resume = true;
        let picked;
        try { picked = await pickSession(opts); } catch (error) { notice(error.message); opts.resume = false; continue; }
        opts.session = picked.path;
        opts.providerExplicit = false; opts.modelExplicit = false; opts.baseUrlExplicit = false;
        const session = await readSession(opts.session);
        opts.backend = session.config?.backend || "api";
        opts.provider = session.provider || session.config?.provider || "deepseek";
        opts.model = session.model;
        opts.baseUrl = session.baseUrl || (opts.backend === "api" ? providerConfig(opts.provider).baseUrl : undefined);
        opts.permission = session.config?.permission;
        if (picked.agentId) opts.agentId = picked.agentId;
        const decision = await choose("Resume session", `${opts.backend} · ${opts.model || "CLI default"}`, [
          { id: "keep", label: "Continue with the saved model" },
          { id: "model", label: "Choose another model", description: "Keep this conversation" },
          ...(opts.backend === "api" ? [{ id: "provider", label: "Choose another API provider", description: "Keep conversation; use the selected provider's credentials" }] : []),
          { id: "back", label: "Back" }
        ]);
        if (!decision || decision === "back") { opts.resume = false; opts.session = null; opts.agentId = null; continue; }
        if (decision === "provider") {
          const provider = await choose("API provider", "This will send the saved context to the selected provider.", CONNECTIONS.filter(c => !["codex", "claude"].includes(c.id)));
          if (!provider) continue;
          opts.provider = provider; opts.providerExplicit = true; opts.baseUrl = providerConfig(provider).baseUrl;
        }
        if (decision !== "keep") {
          const model = await chooseModel(opts, choose, ask, notice);
          if (!model) continue;
          opts.model = model; opts.modelExplicit = true;
        }
      } else {
        opts.resume = false; opts.session = null; opts.agentId = null;
        const connection = await choose("Choose a connection", "Use a subscription login or an API key.", CONNECTIONS);
        if (!connection) continue;
        opts.backend = ["codex", "claude"].includes(connection) ? connection : "api";
        if (opts.backend === "api") {
          opts.provider = connection; opts.providerExplicit = true;
          opts.baseUrl = providerConfig(connection).baseUrl; opts.model = providerConfig(connection).model;
        } else { opts.providerExplicit = false; opts.model = null; }
        const model = await chooseModel(opts, choose, ask, notice);
        if (!model) continue;
        opts.model = model; opts.modelExplicit = true;
        opts.permission = await pickPermission(opts);
        if (opts.permission === "quit") continue;
      }
      opts.interactiveChat = true;
      return opts;
    }
  } finally { opts.startupUi?.close(); opts.startupUi = null; process.stdin.pause(); }
}

// Coordination agent records (all states) for resume/spawn decisions.
async function coordinationAgentRecords(opts) {
  const root = coordinationRoot(opts.coordDir);
  try {
    await stat(join(root, "agents"));
  } catch {
    return [];
  }
  return listAgents(root, { includeStopped: true });
}

async function pickSession(opts) {
  const agents = await coordinationAgentRecords(opts);
  const items = await listSessions();
  const entries = [
    ...agents.filter((agent) => agent.session).map((agent) => ({
      label: `${agent.agentId}  [${agent.state}${agent.live ? " LIVE" : ""}]  ${String(agent.session).split(/[\\/]/).pop()}`,
      path: agent.session,
      agentId: agent.agentId
    })),
    ...items.map((item) => ({
      label: `${item.agentId ? `${item.agentId} · ` : ""}${sessionLabel(item, 0).replace(/^\s*\d+\s+/, "")}`,
      path: item.path,
      agentId: item.agentId || null
    }))
  ].filter((entry) => entry.path);

  if (entries.length === 0) throw new Error("No saved sessions or coordination agents found.");
  if (!process.stdin.isTTY) {
    return { path: items.length ? items[0].path : entries[0].path, agentId: items.length ? (items[0].agentId || null) : entries[0].agentId };
  }

  if (opts.startupUi) {
    const index = await opts.startupUi.select("Resume a session", "Choose saved work. Model changes are available next.", entries.map((entry, i) => ({ id: String(i), label: entry.label, description: entry.path })));
    if (index === null) throw new Error("Resume selection cancelled.");
    return entries[Number(index)];
  }
  process.stdout.write(`\n  ${bold(opts, "Resume")}\n\n`);
  entries.forEach((entry, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2, " ")}  ${entry.label}\n`);
  });
  process.stdout.write("\n");
  while (true) {
    const answer = await promptLine(`  Choose 1-${entries.length}, q to cancel: `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "") throw new Error("Resume selection cancelled.");
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= entries.length) return { path: entries[n - 1].path, agentId: entries[n - 1].agentId };
    process.stdout.write(`  Invalid. Enter 1-${entries.length} or q.\n`);
  }
}

// Sessions persist config.agentId, so a stable agent id can be tied to a
// single session file: find the agent's most recently updated session.
async function findSessionForAgent(agentId) {
  if (!agentId) return null;
  const sessions = await listSessions();
  const match = sessions.find((entry) => entry.agentId === agentId);
  return match ? match.path : null;
}

function toolSchemas(opts) {
  const schemas = [
    {
      type: "function",
      function: {
        name: "get_runtime_context",
        description: "Return OS, shell, workspace, date, Node, and git branch context.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "list_workspace_files",
        description: "List files and directories under the workspace. Supports recursive listing, glob filtering, and metadata. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:             { type: "string",  description: "Workspace-relative directory. Defaults to workspace root." },
            recursive:        { type: "boolean", description: "Recurse into subdirectories. Default false (flat listing for backwards compat)." },
            glob:             { type: "string",  description: "Glob pattern to filter entries, e.g. '**/*.ts'." },
            exclude_glob:     { type: "string",  description: "Glob pattern to exclude entries, e.g. '**/*.min.js'." },
            exclude_patterns: { type: "array",   items: { type: "string" }, description: "Additional directory names to exclude beyond the default set." },
            max:              { type: "number",  description: "Max entries to return. Default 200." },
            offset:           { type: "number",  description: "Pagination cursor. Default 0." },
            type:             { type: "string",  enum: ["file", "dir", "all"], description: "Filter by entry type. Default all." },
            include_metadata: { type: "boolean", description: "Include size_bytes and modified_iso per entry. Default false." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_text_file",
        description: "Read a UTF-8 text file inside the workspace. Prefer start_line/end_line for targeted reads; use offset/max_bytes for chunked byte reads of large files.",
        parameters: {
          type: "object",
          properties: {
            path:       { type: "string",  description: "Workspace-relative file path." },
            start_line: { type: "number",  description: "First line to read (1-based, inclusive). Returns line text instead of raw bytes." },
            end_line:   { type: "number",  description: "Last line to read (1-based, inclusive). Use with start_line. Defaults to start_line + 99." },
            max_bytes:  { type: "number",  description: "Max bytes to read in byte mode. Defaults to 20000." },
            offset:     { type: "number",  description: "Byte offset to start from in byte mode. Defaults to 0." },
            structured: { type: "boolean", description: "Return JSON {content, next_offset, total_bytes} instead of plain text. Enables cursor-based chained reads." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "view_image",
        description: "Read a workspace image file and return JSON metadata, dimensions when detectable, and a base64 data URL when small enough. Does not visually interpret content. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative image path." },
            include_data_url: { type: "boolean", description: "Include a data:image/... base64 URL. Default true." },
            max_bytes: { type: "number", description: "Maximum image bytes to include in data_url. Default 4000000, max 12000000." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "analyze_image_openai",
        description: "Use OpenAI vision to visually inspect a workspace image and return text analysis or exact transcription. Requires OPENAI_API_KEY. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative image path." },
            prompt: { type: "string", description: "Vision prompt. For screenshots/code, ask to transcribe text exactly before summarizing." },
            model: { type: "string", description: "OpenAI vision-capable model. Defaults to OPENAI_VISION_MODEL or gpt-4.1-mini." },
            max_output_tokens: { type: "number", description: "Maximum OpenAI output tokens. Default 1200, max 8000." },
            max_bytes: { type: "number", description: "Maximum image bytes to send. Default 12000000, max 20000000." },
            timeout_ms: { type: "number", description: "OpenAI request timeout. Default 60000, max 180000." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_skills",
        description: "List local skills discovered from --skill-root, DEEPSEEK_SKILLS_DIR, ~/.deepseek/skills, ~/.codex/skills (fallback), and .deepseek-watch/skills, in precedence order. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "read_skill",
        description: "Read a local skill's SKILL.md by skill name, folder name, or path. Use this before following a skill that was not loaded with --skill. Read-only.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name, skill folder name, SKILL.md path, or skill directory path." }
          },
          required: ["name"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current or external information. Read-only. Uses Google Custom Search when configured, then Brave when configured, otherwise DuckDuckGo HTML/Lite results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            max_results: { type: "number", description: "Number of results to return, 1-10. Defaults to 5." },
            site: { type: "string", description: "Optional domain to restrict results, e.g. github.com." },
            provider: { type: "string", enum: ["auto", "google", "brave", "duckduckgo"], description: "Optional search provider override. Defaults to WEB_SEARCH_PROVIDER or auto." },
            time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Optional freshness hint for DuckDuckGo fallback." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_find",
        description: "Fetch a URL, extract readable text, and run a JavaScript regular expression over the page text. Use for exact terms, dates, errors, API names, code symbols, or citations inside a page. Read-only.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to fetch and search." },
            pattern: { type: "string", description: "JavaScript regular expression pattern." },
            flags: { type: "string", description: "JavaScript regex flags. Defaults to i; g is added automatically." },
            context_chars: { type: "number", description: "Characters of context around each match. Default 160, max 1000." },
            max_results: { type: "number", description: "Maximum matches to return. Default 20, max 100." },
            max_chars: { type: "number", description: "Maximum page text characters to search. Default 50000, max 250000." },
            timeout_ms: { type: "number", description: "Fetch timeout in milliseconds. Default 20000, max 60000." }
          },
          required: ["url", "pattern"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and return readable page text. Use after web_search when snippets are not enough. Read-only.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
            max_chars: { type: "number", description: "Maximum text characters to return. Default 12000, max 50000." },
            offset: { type: "number", description: "Character offset for reading the next chunk of a long page. Default 0." },
            timeout_ms: { type: "number", description: "Fetch timeout in milliseconds. Default 20000, max 60000." },
            structured: { type: "boolean", description: "Return JSON with content, next_offset, total_chars, title, and content_type." }
          },
          required: ["url"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_goal",
        description: "Create or replace the current persistent session goal. Stored in the session JSON.",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "Concrete objective for the session." },
            token_budget: { type: "number", description: "Optional positive token budget." }
          },
          required: ["objective"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_goal",
        description: "Return the current persistent session goal, or null if none exists.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "update_goal",
        description: "Mark the current goal complete or blocked and optionally add a note.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "blocked"], description: "Final goal status." },
            note: { type: "string", description: "Optional note explaining the status." }
          },
          required: ["status"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Replace the visible persistent session plan with explicit step statuses.",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: "string", description: "Optional plan update note." },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string", description: "Task step." },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Step status." }
                },
                required: ["step", "status"],
                additionalProperties: false
              }
            }
          },
          required: ["plan"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_plan",
        description: "Return the current persistent session plan.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "session_health",
        description: "Report saved-session health, goal status, plan progress, checkpoints, touched files, and tool-call repair needs.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "checkpoint_session",
        description: "Append a compact checkpoint to the session JSON.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "Optional checkpoint label." },
            summary: { type: "string", description: "Optional checkpoint summary." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "summarize_session",
        description: "Return a compact recent session summary without dumping the full transcript.",
        parameters: {
          type: "object",
          properties: {
            max_messages: { type: "number", description: "Number of recent non-system messages to summarize. Default 12, max 50." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_status",
        description: "Inspect a handoff output file and optional log tail. Read-only.",
        parameters: {
          type: "object",
          properties: {
            output_file: { type: "string", description: "Workspace-relative handoff output file." },
            log_file: { type: "string", description: "Optional workspace-relative handoff log file." },
            tail_lines: { type: "number", description: "Optional log tail line count. Default 40, max 200." }
          },
          required: ["output_file"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_wait",
        description: "Wait for a handoff output file to appear and optionally print its content. Read-only.",
        parameters: {
          type: "object",
          properties: {
            output_file: { type: "string", description: "Workspace-relative handoff output file." },
            timeout_seconds: { type: "number", description: "Timeout in seconds. Default 300, max 7200." },
            poll_ms: { type: "number", description: "Polling interval in milliseconds. Default 1000." },
            print_content: { type: "boolean", description: "Include output file content when found. Default false." }
          },
          required: ["output_file"],
          additionalProperties: false
        }
      }
    }
  ];

  schemas.push(
    {
      type: "function",
      function: {
        name: "search_code",
        description: "Search workspace files for a regex or literal pattern. Skips binary files and common build/dep dirs. Read-only.",
        parameters: {
          type: "object",
          properties: {
            pattern:          { type: "string",  description: "Regex or literal string to search for." },
            path:             { type: "string",  description: "Workspace-relative file or subdirectory to scope the search." },
            glob:             { type: "string",  description: "File filter glob, e.g. '*.ts' or 'src/**/*.js'." },
            ignore_case:      { type: "boolean", description: "Case-insensitive match. Default false." },
            max_results:      { type: "number",  description: "Max matches to return. Default 200." },
            context_lines:    { type: "number",  description: "Lines of surrounding context per match (0–5). Default 0." },
            max_matches:      { type: "number",  description: "Hard maximum matches. Default 200, max 2000." },
            max_result_chars: { type: "number",  description: "Hard maximum characters per match result. Default 1200." },
            max_total_chars:  { type: "number",  description: "Hard maximum characters returned by this call. Default 24000." },
            context_chars:    { type: "number",  description: "Characters around each match. Default 160." },
            regex_timeout_ms: { type: "number",  description: "Regex worker timeout per file. Default 750ms." },
            page_token:       { type: "string",  description: "Continuation token from a previous search." },
            respect_gitignore:{ type: "boolean", description: "Apply default excludes (.git, node_modules, dist, …). Default true." }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "artifact_list",
        description: "List bounded analysis artifacts for this task.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "artifact_read_range",
        description: "Read a bounded character/byte range from a saved artifact.",
        parameters: { type: "object", properties: { artifact: { type: "string" }, offset: { type: "number" }, max_bytes: { type: "number" } }, required: ["artifact"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "artifact_search",
        description: "Search a saved artifact and return bounded snippets around matches.",
        parameters: { type: "object", properties: { artifact: { type: "string" }, pattern: { type: "string" }, max_matches: { type: "number" }, context_chars: { type: "number" } }, required: ["artifact", "pattern"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "artifact_index",
        description: "Return the task-wide artifact index: metadata, tags, byte size, and searchability.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "artifact_search_all",
        description: "Search all indexed text artifacts and return bounded snippets with artifact references.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, max_matches: { type: "number" }, context_chars: { type: "number" } }, required: ["pattern"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "sandbox_execute",
        description: "Execute a bounded command in a named ephemeral Docker environment. Output is capped and stored as an artifact.",
        parameters: { type: "object", properties: { environment: { type: "string", enum: Object.keys(SANDBOX_ENVIRONMENTS) }, command: { type: "string" }, timeout_ms: { type: "number" }, working_directory: { type: "string" }, cpu: { type: "number" }, memory_mb: { type: "number" }, network_policy: { type: "string", enum: ["none", "allowlisted"] }, target: { type: "string", description: "Required when allowlisted network access is requested; checked against task scope." }, vulnerability_class: { type: "string" }, persistence: { type: "string", enum: ["ephemeral", "persistent"] }, env: { type: "object" } }, required: ["environment", "command"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "sandbox_manage",
        description: "Create, inspect, execute, copy, retrieve logs, stop, destroy, or list Docker sandbox environments/containers.",
        parameters: { type: "object", properties: { operation: { type: "string", enum: ["create", "exec", "copy_in", "copy_out", "inspect", "logs", "stop", "destroy", "cleanup_orphans", "list_environments", "list_containers"] }, environment: { type: "string", enum: Object.keys(SANDBOX_ENVIRONMENTS) }, container: { type: "string" }, command: { type: "string" }, source: { type: "string" }, destination: { type: "string" }, target: { type: "string", description: "Required when creating the web-testing environment." }, vulnerability_class: { type: "string" }, timeout_ms: { type: "number" } }, required: ["operation"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scope_get",
        description: "Read the current task authorization scope and restrictions.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scope_set",
        description: "Set reviewed task scope state. Network/target tools must consult this state.",
        parameters: { type: "object", properties: { allowed_assets: { type: "array", items: { type: "string" } }, excluded_assets: { type: "array", items: { type: "string" } }, allowed_classes: { type: "array", items: { type: "string" } }, excluded_classes: { type: "array", items: { type: "string" } }, restrictions: { type: "array", items: { type: "string" } }, source_artifact: { type: "string" } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scope_check",
        description: "Check whether a target and vulnerability class are in the task scope.",
        parameters: { type: "object", properties: { target: { type: "string" }, vulnerability_class: { type: "string" } }, required: ["target"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scope_add_assets",
        description: "Add authorized assets to the current task scope without replacing existing scope state. Use for a new in-scope HackerOne asset in the same session.",
        parameters: { type: "object", properties: { assets: { type: "array", items: { type: "string" } } }, required: ["assets"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scope_remove_assets",
        description: "Remove authorized assets from the current task scope without changing other policy fields.",
        parameters: { type: "object", properties: { assets: { type: "array", items: { type: "string" } } }, required: ["assets"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "hypothesis_record",
        description: "Persist a tested hypothesis, evidence, outcome, rejection reason, and artifact references.",
        parameters: { type: "object", properties: { hypothesis: { type: "string" }, evidence: { type: "string" }, test: { type: "string" }, outcome: { type: "string" }, rejected_reason: { type: "string" }, artifacts: { type: "array", items: { type: "string" } } }, required: ["hypothesis", "test", "outcome"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "viability_set",
        description: "Record the target viability decision: CONTINUE, ESCALATE, or DROP.",
        parameters: { type: "object", properties: { decision: { type: "string", enum: ["CONTINUE", "ESCALATE", "DROP"] }, factors: { type: "object" }, notes: { type: "string" } }, required: ["decision"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "roi_record",
        description: "Record model/tool/runtime/cost/result economics for the current task.",
        parameters: { type: "object", properties: { model: { type: "string" }, input_tokens: { type: "number" }, output_tokens: { type: "number" }, api_cost: { type: "number" }, runtime_ms: { type: "number" }, workers: { type: "number" }, result: { type: "string" }, severity: { type: "string" }, bounty: { type: "number" } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "model_escalation_get",
        description: "Read the configurable cheap-worker, specialist, and verifier escalation policy for this task.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "model_escalation_set",
        description: "Set a task-local model escalation policy. This chooses recommendations; it does not invoke an external model automatically.",
        parameters: { type: "object", properties: { cheap_models: { type: "array", items: { type: "string" } }, specialist_models: { type: "array", items: { type: "string" } }, verifier_models: { type: "array", items: { type: "string" } }, max_cheap_passes: { type: "number" }, escalate_on: { type: "array", items: { type: "string" } } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "model_escalation_decide",
        description: "Recommend cheap, specialist, or verifier model based on task complexity, evidence confidence, and cheap-worker passes.",
        parameters: { type: "object", properties: { complexity: { type: "string", enum: ["low", "medium", "high"] }, finding_confidence: { type: "string", enum: ["none", "ambiguous", "credible", "high", "validated"] }, cheap_passes: { type: "number" } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "pe_triage",
        description: "Perform bounded first-pass PE triage and route indicators to specialist analysis.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_list_interfaces",
        description: "List capture interfaces inside the network-analysis environment.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_capture_start",
        description: "Start a bounded, ring-buffered packet capture in the isolated network-analysis environment. Capture is local to that environment and stored as an artifact when stopped.",
        parameters: { type: "object", properties: { interface: { type: "string" }, duration_seconds: { type: "number", description: "1-600; default 60." }, max_file_mb: { type: "number", description: "1-250; default 50." }, ring_files: { type: "number", description: "1-10; default 2." }, name: { type: "string" } }, required: ["interface"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_capture_stop",
        description: "Stop a named isolated packet capture, register its PCAPNG artifact, and destroy the capture container.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_capture_status",
        description: "List active bounded packet captures for this task.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_protocol_summary",
        description: "Return a bounded protocol summary from an indexed PCAP artifact.",
        parameters: { type: "object", properties: { artifact: { type: "string" } }, required: ["artifact"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_conversations",
        description: "Return bounded network conversations from a PCAP artifact.",
        parameters: { type: "object", properties: { artifact: { type: "string" } }, required: ["artifact"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_query_pcap",
        description: "Run a bounded display-filter/field query against a PCAP artifact.",
        parameters: { type: "object", properties: { artifact: { type: "string" }, filter: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["artifact"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "net_stream_summary",
        description: "Return bounded TCP stream/conversation summaries from a PCAP artifact.",
        parameters: { type: "object", properties: { artifact: { type: "string" } }, required: ["artifact"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "read_text_files",
        description: "Batch-read multiple workspace files in one call. Returns a JSON object keyed by path. Per-file errors don't fail the batch. Read-only.",
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "List of files to read.",
              items: {
                type: "object",
                properties: {
                  path:       { type: "string", description: "Workspace-relative file path." },
                  start_line: { type: "number", description: "First line (1-based, inclusive)." },
                  end_line:   { type: "number", description: "Last line (1-based, inclusive)." },
                  max_bytes:  { type: "number", description: "Max bytes to read. Default 20000." }
                },
                required: ["path"],
                additionalProperties: false
              }
            }
          },
          required: ["files"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "Show git working-tree status (short format). Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to scope." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show git diff. Defaults to unstaged changes. Read-only.",
        parameters: {
          type: "object",
          properties: {
            staged:        { type: "boolean", description: "Show staged (indexed) changes. Default false." },
            target_branch: { type: "string",  description: "Compare against this branch/ref, e.g. 'main'." },
            path:          { type: "string",  description: "Scope diff to this workspace-relative path." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_log",
        description: "Show git commit log (one-line format). Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:        { type: "string", description: "Scope log to this workspace-relative path." },
            max_entries: { type: "number", description: "Max commits to return. Default 20." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_blame",
        description: "Show git blame for a file (who last changed each line). Read-only.",
        parameters: {
          type: "object",
          properties: {
            file_path:  { type: "string", description: "Workspace-relative file path." },
            start_line: { type: "number", description: "First line to blame (1-based)." },
            end_line:   { type: "number", description: "Last line to blame (1-based)." }
          },
          required: ["file_path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "stat_file",
        description: "Return metadata for a file or directory: size, modification time, type, binary flag. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Discover workspace files matching a glob pattern (no shell). Read-only.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern, e.g. 'packages/*/package.json' or 'src/**/*.ts'." },
            max:     { type: "number", description: "Max paths to return. Default 100." }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "cache_set",
        description: "Store a string value in the session cache under a key. Saved with the session JSON for resumed runs.",
        parameters: {
          type: "object",
          properties: {
            key:   { type: "string", description: "Cache key." },
            value: { type: "string", description: "String value to store." }
          },
          required: ["key", "value"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "cache_get",
        description: "Retrieve a value from the session cache by key. Returns the string value or 'null' if not set.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Cache key to look up." }
          },
          required: ["key"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "path_exists",
        description: "Check whether a workspace path exists. Returns JSON {exists, type}. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "is_text_file",
        description: "Sniff first 512 bytes to determine whether a file is text or binary. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_related_files",
        description: "Scan a file for import/require/include statements and return the referenced module paths. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "tree",
        description: "Print a visual directory tree (like the 'tree' command). Skips common build/dep directories. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:      { type: "string", description: "Workspace-relative root. Defaults to workspace root." },
            max_depth: { type: "number", description: "Maximum tree depth. Default 3, max 8." }
          },
          additionalProperties: false
        }
      }
    }
  );

  const reviewSchemaCount = schemas.length;

  schemas.push(...securityToolSchemas());
  schemas.push(...offensiveToolSchemas());
  schemas.push(...reToolSchemas());
  schemas.push(...runtimeToolSchemas());
  schemas.push(...fuzzToolSchemas());
  schemas.push(...bountyToolSchemas());
  schemas.push(...dockerToolSchemas());

  schemas.push(
    {
      type: "function",
      function: {
        name: "write_text_file",
        description: "Write or overwrite a UTF-8 file inside the workspace. Creates parent directories. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            path:    { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full file content to write." }
          },
          required: ["path", "content"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "patch_files",
        description: "Apply multiple old_string→new_string replacements across one or more files atomically. All old_strings must match before any file is written. Edits to the same file apply in order. CRLF/LF line endings are normalized for matching; inserted text uses the file's dominant line ending. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              description: "List of edits to apply.",
              items: {
                type: "object",
                properties: {
                  path:        { type: "string",  description: "Workspace-relative file path." },
                  old_string:  { type: "string",  description: "Exact text to find." },
                  new_string:  { type: "string",  description: "Replacement text." },
                  replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first." }
                },
                required: ["path", "old_string", "new_string"],
                additionalProperties: false
              }
            }
          },
          required: ["edits"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "patch_text_file",
        description: "Replace the first occurrence of old_string with new_string in a workspace file. Fails if old_string is not found. CRLF/LF line endings are normalized for matching; inserted text uses the file's dominant line ending. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            path:        { type: "string",  description: "Workspace-relative file path." },
            old_string:  { type: "string",  description: "Exact text to find." },
            new_string:  { type: "string",  description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first. Defaults to false." }
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_cmd",
        description: "Request execution of a Windows cmd.exe command in the workspace. The user is prompted unless dangerous auto-run mode is enabled.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command text to pass to cmd.exe /d /s /c." },
            path: { type: "string", description: "Working directory for the command. Absolute paths are used as-is; relative paths resolve against the workspace root. Defaults to the workspace root." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 60000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_bash",
        description: "Request execution of a Bash command through bash.exe (WSL or Git Bash on Windows). The user is prompted unless dangerous auto-run mode is enabled.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Bash command text passed to bash -lc." },
            path: { type: "string", description: "Working directory. Absolute paths are used as-is; relative paths resolve against the workspace root." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 60000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_powershell",
        description: "Request execution of a PowerShell command in the workspace. The user is prompted unless dangerous auto-run mode is enabled.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "PowerShell command text." },
            path: { type: "string", description: "Working directory for the command. Absolute paths are used as-is; relative paths resolve against the workspace root. Defaults to the workspace root." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 60000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "functions_shell_command",
        description: "Execute a shell command in the workspace using PowerShell on Windows. Supports an optional working directory (absolute, or relative to the workspace root). Blocked in review permission mode. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            command:    { type: "string", description: "Command to run." },
            workdir:    { type: "string", description: "Working directory for the command: absolute path used as-is, or relative to the workspace root. Defaults to the workspace root." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 120000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_start",
        description: "Start a bounded delegated LLM handoff. Writes CLI output to a log file and rejects stale output files.",
        parameters: {
          type: "object",
          properties: {
            prompt_file: { type: "string", description: "Workspace-relative prompt file to read." },
            output_file: { type: "string", description: "Workspace-relative output file expected from the handoff." },
            log_file: { type: "string", description: "Workspace-relative log file for CLI stdout/stderr." },
            cli: { type: "string", description: "CLI executable. Default claude." },
            cli_args: { type: "string", description: "Optional CLI arguments, shell-like quoted string." },
            timeout_seconds: { type: "number", description: "Timeout hint included in status output. Default 7200." }
          },
          required: ["prompt_file", "output_file", "log_file"],
          additionalProperties: false
        }
      }
    }
  );

  schemas.push(
    {
      type: "function",
      function: {
        name: "classify_url",
        description: "Classify an HTTP(S) URL using known deceptive-download, tracker, wall, executable, and shortener signatures. Read-only; does not open the URL.",
        parameters: { type: "object", properties: { url: { type: "string", description: "URL to classify." } }, required: ["url"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "verify_download",
        description: "Copy a local workspace/Downloads file or download a non-flagged HTTP(S) URL to quarantine, then calculate SHA-256 and static file-risk indicators. Never executes the file.",
        parameters: { type: "object", properties: { input: { type: "string", description: "HTTP(S) URL or local file path under the workspace or Downloads." }, quarantine_dir: { type: "string", description: "Optional quarantine directory." } }, required: ["input"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "watch_downloads",
        description: "List recent Downloads files and mark .crdownload files as in-progress. Read-only.",
        parameters: { type: "object", properties: { since: { type: "string", description: "Optional ISO timestamp cutoff." } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "track_bypass_state",
        description: "Persist safety research state such as suspicious domains, wall notes, and verified download hashes across sessions. This does not bypass access controls.",
        parameters: { type: "object", properties: { key: { type: "string" }, value: { description: "Optional JSON-compatible value to store." } }, required: ["key"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "scan_download_hash",
        description: "Look up a SHA-256 hash in VirusTotal when VT_API_KEY is configured. Read-only.",
        parameters: { type: "object", properties: { hash: { type: "string" } }, required: ["hash"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "virus_total",
        description: "Look up a SHA-256 hash or URL in VirusTotal when VT_API_KEY is configured. Read-only.",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "whois_lookup",
        description: "Look up public domain-registration metadata through RDAP. Read-only.",
        parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "dns_lookup",
        description: "Resolve A, AAAA, and MX records for a domain. Read-only.",
        parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "cert_logs",
        description: "Search public Certificate Transparency logs for a domain via crt.sh. Read-only.",
        parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "file_analyze",
        description: "Perform static PE/file inspection: SHA-256, entropy, strings, and packer heuristics. Never executes the file.",
        parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path." } }, required: ["path"], additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "process_manage",
        description: "Start, stop, list, or inspect named detached local processes. Started processes write stdout/stderr to .deepseek-watch/processes and can wait for an HTTP readiness URL. Start/stop require command permission.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "stop", "status", "list"], description: "Process operation." },
            name: { type: "string", description: "Required except for action=list; stable local process name." },
            command: { type: "string", description: "Required for action=start; command passed to the selected shell." },
            shell: { type: "string", enum: ["powershell", "cmd"], description: "Shell for start. Defaults to powershell." },
            workdir: { type: "string", description: "Optional workspace-relative working directory." },
            ready_url: { type: "string", description: "Optional HTTP(S) endpoint that must respond successfully before start returns." },
            ready_timeout_ms: { type: "number", description: "Readiness deadline, 1000-300000ms. Defaults to 30000." }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "file_watch",
        description: "Record and compare a workspace file or directory snapshot. First call initializes the watch; later calls return created, modified, and deleted files since the last call. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file or directory path." },
            recursive: { type: "boolean", description: "Recurse into subdirectories. Defaults to true." },
            reset: { type: "boolean", description: "Discard the prior snapshot and initialize a new one." },
            max_changes: { type: "number", description: "Maximum changes to return. Defaults to 200, max 2000." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "project_memory",
        description: "Read or maintain workspace memory in .deepseek-watch/project-memory.json. Store durable project conventions and decisions, never credentials. Set/delete require write permission.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "set", "delete", "list"], description: "Memory operation." },
            key: { type: "string", description: "Memory key; required except for list." },
            value: { description: "JSON-compatible value for action=set." }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "diagnostics",
        description: "Run configured workspace lint/type-check scripts safely through npm. Uses lint, typecheck, and check when present. Requires command permission.",
        parameters: {
          type: "object",
          properties: { timeout_ms: { type: "number", description: "Per-script deadline. Defaults to 120000, max 600000." } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the workspace npm test script if configured. Requires command permission.",
        parameters: {
          type: "object",
          properties: { timeout_ms: { type: "number", description: "Test deadline. Defaults to 120000, max 600000." } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "semantic_search",
        description: "Rank workspace text files by relevance to several search terms. This is local lexical relevance ranking, not an embeddings service. Read-only.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language phrase or technical terms to locate." },
            max_results: { type: "number", description: "Maximum ranked files. Defaults to 20, max 100." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "plan_review",
        description: "Run a compact pre-handoff review: git status, diff stat, whitespace validation, and a behavior/verification checklist. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    }
  );
  schemas.push(
    {
      type: "function",
      function: {
        name: "agent_identity",
        description: "Return this agent's stable ID, role, mission, state, session, workspace, and coordination directory.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_list",
        description: "Discover agents registered in the shared coordination directory and inspect their current missions and states.",
        parameters: {
          type: "object",
          properties: { include_stopped: { type: "boolean", description: "Include completed, failed, stopped, and stale agents. Default false." } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_send",
        description: "Send a durable message to another agent. A parked recipient wakes; a working recipient receives it at a safe turn boundary.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient agent ID." },
            message: { type: "string", description: "Message body." },
            type: { type: "string", enum: ["message", "task", "status_request", "status", "handoff", "wake"], description: "Message type. Default message." },
            priority: { type: "string", enum: ["low", "normal", "high"], description: "Message priority. Default normal." },
            task_id: { type: "string", description: "Optional related task ID." },
            reply_to: { type: "string", description: "Optional message ID being answered." }
          },
          required: ["to", "message"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_check_inbox",
        description: "Peek at pending agent messages without consuming them. Messages are consumed automatically when injected into a turn.",
        parameters: { type: "object", properties: { max: { type: "number", description: "Maximum messages. Default 100." } }, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_task_create",
        description: "Create a bounded shared task. Reserved for an agent launched with --agent-role coordinator.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            scope: { type: "array", items: { type: "string" }, description: "Paths/components exclusively owned by the task." },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            depends_on: { type: "array", items: { type: "string" } }
          },
          required: ["task_id", "title"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_task_list",
        description: "List shared tasks, ownership claims, scopes, dependencies, and status.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_claim",
        description: "Atomically claim a shared task lease so another agent cannot claim the same work.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            lease_seconds: { type: "number", description: "Lease duration. Default 1800; range 30-86400." }
          },
          required: ["task_id"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_handoff",
        description: "Mark a claimed task ready for review and optionally message another agent with the result.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            summary: { type: "string" },
            to: { type: "string", description: "Optional recipient, usually the coordinator." },
            status: { type: "string", enum: ["ready_for_review", "blocked", "complete"] }
          },
          required: ["task_id", "summary"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "compact_session",
        description: "Compact THIS agent's own session transcript now: fold the old message prefix into one summary (LLM via the session's compact method, or deterministic), keep the recent tail verbatim. Returns before/after token estimates. Use when context is large or when the coordinator reports your session near the limit.",
        parameters: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "Compact even below the auto threshold. Default false." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_compact",
        description: "Compact another agent's session transcript (coordination-level). If the target is live (running or parked), sends it an inbox compact request it applies on its next wake/turn and replies with the result. If the target is stopped/failed, compacts its session file directly so its next launch resumes compacted.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            method: { type: "string", enum: ["auto", "truncate"], description: "truncate = free deterministic roll-up (default for stopped targets); auto = LLM summary with truncate fallback." }
          },
          required: ["agent_id"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_models",
        description: "List the models each provider will serve for the configured keys, with the context window this wrapper assumes for each. Use before spawn_agent when choosing a model other than your own.",
        parameters: {
          type: "object",
          properties: {
            provider: { type: "string", enum: Object.keys(PROVIDERS), description: "Omit to list every configured provider." }
          },
          required: [],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "spawn_agent",
        description: "COORDINATOR-ONLY. Spawn a NEW agent as a detached background process (non-blocking; this agent keeps working). Pulls the current working directory and the shared --coord-dir. FAILS if agent_id already exists — use resume_agent to resume an existing id instead.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "New stable id. Must NOT already exist in coordination." },
            role: { type: "string", enum: ["coordinator", "worker"], description: "Default worker." },
            mission: { type: "string" },
            prompt: { type: "string", description: "Initial prompt for the new agent." },
            provider: { type: "string", enum: Object.keys(PROVIDERS), description: "Model provider for the new agent. Defaults to this agent's own provider. A model from one provider spawned against another's endpoint fails immediately, so set this whenever `model` is not from your own provider." },
            model: { type: "string", description: "Any model the chosen provider serves. Call list_models to see what is available; omitting it uses the provider default." },
            permission: { type: "string", enum: ["review", "ask", "full"], description: "Default full." }
          },
          required: ["agent_id", "prompt"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "resume_agent",
        description: "COORDINATOR-ONLY. Spawn an EXISTING agent id as a detached background process, resuming that agent's saved session (state, mission, claims). FAILS if the id has no coordination record (use spawn_agent) or is currently live (PID).",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            prompt: { type: "string", description: "Prompt appended to the resumed session." },
            mission: { type: "string", description: "Optional mission override for this launch." },
            provider: { type: "string", enum: Object.keys(PROVIDERS), description: "Provider for the resumed agent. Defaults to this agent's own provider." },
            model: { type: "string", description: "Any model the chosen provider serves. Call list_models to see what is available." },
            permission: { type: "string", enum: ["review", "ask", "full"] }
          },
          required: ["agent_id", "prompt"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "agent_wait",
        description: "Park this wrapper after the current tool batch until another agent sends a message. No model request remains active while parked.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the agent is waiting." },
            timeout_seconds: { type: "number", description: "Optional timeout. Omit or use 0 to wait indefinitely." }
          },
          additionalProperties: false
        }
      }
    }
  );
  if (opts.permission === "review") {
    return schemas.filter((schema, index) => index < reviewSchemaCount || schema.function?.name?.startsWith("agent_"));
  }
  return schemas;
}

async function atomicWriteFile(absPath, content) {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, absPath);
}

async function writeAtomicMarkdown(path, content) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  await writeFile(tmp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await rename(tmp, out);
}

function markdownFence(value) {
  const text = String(value || "");
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}\n${text}\n${fence}`;
}

function finalAssistantContent(session) {
  const messages = session.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

function formatTouchedFiles(session) {
  const files = [...new Set(session.touchedFiles || [])].sort();
  if (!files.length) return "- None";
  return files.map((file) => `- ${file}`).join("\n");
}

function formatOutputMarkdown(opts, session) {
  if (opts.fullChat) {
    const lines = ["# Switchyard Transcript", ""];
    for (const message of session.messages || []) {
      if (message.role === "system") continue;
      lines.push(`## ${historyTitle(message)}`, "");
      if (message.reasoning_content) {
        lines.push("### Thinking", "", message.reasoning_content.trim(), "");
      }
      if (message.tool_calls?.length) {
        lines.push("### Tool Calls", "");
        for (const call of message.tool_calls) {
          lines.push(`#### ${call.function?.name || "tool"}`, "", markdownFence(call.function?.arguments || "{}"), "");
        }
        lines.push("");
      }
      lines.push(message.content ? message.content.trim() : "(empty)", "");
    }
    lines.push("## Files Touched", "", formatTouchedFiles(session), "");
    return lines.join("\n");
  }

  return [
    "# Switchyard Result",
    "",
    "## Final Response",
    "",
    finalAssistantContent(session) || "(no final response)",
    "",
    "## Files Touched",
    "",
    formatTouchedFiles(session),
    ""
  ].join("\n");
}

async function maybeWriteOutput(opts, session) {
  if (!opts.output) return;
  await writeAtomicMarkdown(opts.output, formatOutputMarkdown(opts, session));
}

/**
 * Where to run git, and what to scope it to.
 *
 * The git tools used to run at the workspace root always, and pass the caller's
 * path only as a pathspec. That works when the workspace IS the repository and
 * fails confusingly when it merely CONTAINS one: a status scoped to a repo
 * subdirectory, run from a workspace root that is not itself a repo, reports
 * "fatal: not a git repository" about a repository that is perfectly healthy,
 * and git_log reports "(no commits)". A worker hit exactly that and correctly
 * reported it as a tool defect rather than working around it silently.
 *
 * So the repository is discovered from the path the caller actually named: walk
 * up from it until a .git appears, and run git there. The pathspec is kept,
 * absolute, so scoping still behaves as before for a workspace that is itself a
 * repo -- git accepts an absolute pathspec inside its own tree.
 *
 * The workspace escape guard still runs first, so this cannot be used to reach
 * a repository outside the workspace.
 */
function resolveGitScope(rawPath) {
  const pathspec = rawPath ? assertInsideWorkspace(rawPath) : null;
  let probe = pathspec ?? resolve(process.cwd());
  for (;;) {
    if (existsSync(join(probe, ".git"))) return { cwd: probe, pathspec };
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  // No repository found above the given path: behave exactly as before, so a
  // genuine "not a git repository" is still reported rather than hidden.
  return { cwd: process.cwd(), pathspec };
}

function assertInsideWorkspace(path) {
  const root = resolve(process.cwd());
  const localPath = path === "/" || path === "\\" ? "." : path;
  const target = resolve(root, localPath || ".");
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Path escapes workspace.");
  }
  return target;
}

function askYesNo(question) {
  if (activeTerminalUi) return activeTerminalUi.confirm(question);
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    process.stdout.write(`\n${question} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolvePromise(["y", "yes"].includes(data.trim().toLowerCase()));
    });
  });
}

// Reload PATH from the registry (like Chocolatey's refreshenv) so a relaunch
// picks up any PATH changes an update may have made. Best-effort and silent.
function refreshEnvFromRegistry() {
  if (process.platform !== "win32") return;
  try {
    const ps = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "$m=[Environment]::GetEnvironmentVariable('Path','Machine');$u=[Environment]::GetEnvironmentVariable('Path','User');\"$m;$u\""],
      { encoding: "utf8", windowsHide: true, timeout: 8000 }
    );
    if (ps.status === 0 && ps.stdout && ps.stdout.trim()) process.env.Path = ps.stdout.trim();
  } catch { /* leave the inherited PATH in place */ }
}

// Re-exec the current binary with the same arguments so freshly-pulled source
// is loaded. Only meaningful for a source run (dev mode); a compiled exe would
// just re-launch the stale bundle, so callers gate on info.isSource.
function relaunchSelf() {
  refreshEnvFromRegistry();
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", windowsHide: false });
  process.exit(child.status ?? 0);
}

// Codex-style pre-session update gate. Silent unless origin is ahead of the
// local checkout; then offers update-now / skip-until-next. Never blocks the
// session on network errors.
async function maybePromptUpdate(opts) {
  if (opts.noUpdateCheck || process.env.DSW_NO_UPDATE_CHECK === "1") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY || opts.noOutput) return;

  let info;
  try { info = await checkForUpdates({ timeoutMs: 6000 }); } catch { return; }
  if (!info || info.status !== "update-available") return;
  if (await isSkipped(info.remoteSha)) return;

  const arrow = `${info.shortCurrent} → ${info.shortRemote} (origin/${info.branch})`;
  process.stdout.write(`\n${label(opts, "⇪", "Update available", "1;33")}  ${dim(opts, arrow)}\n`);

  if (info.dirty) {
    // Never touch a checkout with uncommitted work — just inform.
    process.stdout.write(`  ${color(opts, "1;31", "You have local changes")} in ${dim(opts, info.repoDir)}.\n`);
    process.stdout.write(`  ${dim(opts, "Commit or stash them, then update with: git pull --ff-only")}\n`);
    const ans = await promptLine(`  Continue this session on the current version? [Y/n] `);
    if (["n", "no"].includes(ans.trim().toLowerCase())) opts.quit = true;
    return;
  }

  const ans = await promptLine(`  ${bold(opts, "[U]")}pdate now   ${bold(opts, "[S]")}kip until next update   ${bold(opts, "[Enter]")} not now: `);
  const choice = ans.trim().toLowerCase();

  if (choice === "u" || choice === "update") {
    process.stdout.write(`  ${dim(opts, "Fetching and fast-forwarding…")}\n`);
    const res = await performUpdate(info.repoDir, info.branch);
    if (!res.ok) {
      process.stdout.write(`  ${color(opts, "1;31", "Update failed")} (${res.phase}): ${res.message}\n  ${dim(opts, "Continuing on the current version.")}\n`);
      return;
    }
    await clearSkipped();
    process.stdout.write(`  ${color(opts, "1;32", "Updated")} to ${res.newSha.slice(0, 9)}.\n`);
    if (info.isSource) {
      process.stdout.write(`  ${dim(opts, "Restarting to load the update…")}\n`);
      relaunchSelf(); // replaces this process
      return;
    }
    // Compiled exe: the pulled source needs a rebuild to take effect.
    process.stdout.write(`  ${color(opts, "1;33", "Rebuild required")}: ${dim(opts, "run 'npm run build:exe' (or install.ps1) so the exe picks it up. Continuing on the current version for now.")}\n`);
    return;
  }

  if (choice === "s" || choice === "skip") {
    try { await setSkipped(info.remoteSha); } catch {}
    process.stdout.write(`  ${dim(opts, "Skipped — you'll be prompted again when a newer update lands.")}\n`);
  }
}

function runLocalCommand(exe, args, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const maxOutput = 24000;
    let stdout = "";
    let stderr = "";
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let settled = false;
    let timer;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parts = [`exit_code=${code ?? "unknown"}`];
      if (timedOut) parts.push("timed_out=true");
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}${stdoutChars > stdout.length ? `\n…[truncated ${stdoutChars - stdout.length} chars]` : ""}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}${stderrChars > stderr.length ? `\n…[truncated ${stderrChars - stderr.length} chars]` : ""}`);
      resolvePromise(parts.join("\n"));
    };
    timer = setTimeout(() => {
      timedOut = true;
      // A background process launched by the shell can inherit stdout/stderr.
      // Do not wait for those streams to close: report the timeout immediately.
      try { child.kill(); } catch {}
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutChars += chunk.length; if (stdout.length < maxOutput) stdout += chunk.slice(0, maxOutput - stdout.length); });
    child.stderr.on("data", (chunk) => { stderrChars += chunk.length; if (stderr.length < maxOutput) stderr += chunk.slice(0, maxOutput - stderr.length); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(`command error: ${error.message}`);
    });
    // `close` waits for stdio to close. On Windows, Start-Process descendants
    // may keep those inherited handles open after PowerShell itself has exited.
    child.on("exit", finish);
    child.on("close", finish);
  });
}

const managedProcesses = new Map();
const fileWatchSnapshots = new Map();

function managedProcessName(name) {
  const normalized = String(name || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(normalized)) {
    throw new Error("Process name must use 1-64 letters, numbers, dots, underscores, or hyphens.");
  }
  return normalized;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function managedProcessStorePath() {
  return join(resolve(process.cwd()), ".deepseek-watch", "processes.json");
}

function normalizeManagedProcessRecord(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return null;
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!["cmd", "powershell"].includes(value.shell)) return null;
  if (typeof value.command !== "string" || typeof value.workdir !== "string") return null;
  if (typeof value.stdout_log !== "string" || typeof value.stderr_log !== "string") return null;
  if (typeof value.started_at !== "string") return null;
  return { name, pid, shell: value.shell, command: value.command, workdir: value.workdir, stdout_log: value.stdout_log, stderr_log: value.stderr_log, started_at: value.started_at };
}

async function loadManagedProcesses() {
  const storePath = managedProcessStorePath();
  managedProcesses.clear();
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    const records = Array.isArray(parsed?.processes) ? parsed.processes : [];
    for (const value of records) {
      const record = normalizeManagedProcessRecord(value);
      if (record) managedProcesses.set(record.name, record);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Could not read managed process store: ${error.message}`);
  }
}

async function saveManagedProcesses() {
  const processes = [...managedProcesses.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  await atomicWriteFile(managedProcessStorePath(), `${JSON.stringify({ version: 1, processes }, null, 2)}\n`);
}

function processRecordWithStatus(record) {
  return { ...record, running: processIsAlive(record.pid) };
}

function waitForHttpReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const check = async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(3000, timeoutMs));
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) return resolvePromise({ ready: true, status: response.status });
      } catch {}
      if (Date.now() >= deadline) return resolvePromise({ ready: false });
      setTimeout(check, 250);
    };
    check();
  });
}

async function manageProcess(args) {
  // Processes outlive a wrapper invocation. Reload before every operation so
  // a later `d` session can inspect or stop a server started by an earlier one.
  await loadManagedProcesses();
  const action = String(args.action || "list").toLowerCase();
  if (action === "list") {
    return [...managedProcesses.values()].map(processRecordWithStatus);
  }

  const name = managedProcessName(args.name);
  const existing = managedProcesses.get(name);
  if (action === "status") {
    if (!existing) return { name, found: false };
    return { ...processRecordWithStatus(existing), found: true };
  }

  if (action === "stop") {
    if (!existing) return { name, found: false, stopped: false };
    if (processIsAlive(existing.pid)) {
      if (process.platform === "win32") {
        await new Promise((resolvePromise) => {
          const killer = spawn("taskkill.exe", ["/pid", String(existing.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", resolvePromise);
          killer.once("exit", resolvePromise);
        });
      } else {
        try { process.kill(-existing.pid, "SIGTERM"); } catch { try { process.kill(existing.pid, "SIGTERM"); } catch {} }
      }
    }
    managedProcesses.delete(name);
    await saveManagedProcesses();
    return { name, found: true, stopped: true };
  }

  if (action !== "start") throw new Error("action must be start, stop, status, or list.");
  if (existing && processIsAlive(existing.pid)) throw new Error(`Managed process '${name}' is already running (pid ${existing.pid}).`);
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command is required when action is start.");
  const shell = args.shell === "cmd" ? "cmd" : "powershell";
  const cwd = args.workdir ? assertInsideWorkspace(args.workdir) : resolve(process.cwd());
  const logDir = join(resolve(process.cwd()), ".deepseek-watch", "processes");
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, `${name}.stdout.log`);
  const stderrPath = join(logDir, `${name}.stderr.log`);
  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  const child = spawn(
    shell === "cmd" ? "cmd.exe" : "powershell.exe",
    shell === "cmd" ? ["/d", "/s", "/c", command] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd, detached: true, windowsHide: true, stdio: ["ignore", stdoutFd, stderrFd] }
  );
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();
  const record = {
    name,
    pid: child.pid,
    shell,
    command,
    workdir: relative(resolve(process.cwd()), cwd).replaceAll("\\", "/") || ".",
    stdout_log: relative(resolve(process.cwd()), stdoutPath).replaceAll("\\", "/"),
    stderr_log: relative(resolve(process.cwd()), stderrPath).replaceAll("\\", "/"),
    started_at: nowIso()
  };
  managedProcesses.set(name, record);
  await saveManagedProcesses();
  const readyUrl = String(args.ready_url || "").trim();
  const readiness = readyUrl ? await waitForHttpReady(readyUrl, Math.min(Math.max(Number(args.ready_timeout_ms) || 30000, 1000), 300000)) : null;
  return { ...record, started: true, running: processIsAlive(child.pid), ...(readiness ? { readiness } : {}) };
}

async function snapshotWatchedPath(absPath, recursive) {
  const entries = new Map();
  const addEntry = async (target, relPath) => {
    const info = await stat(target);
    if (!info.isFile()) return;
    entries.set(relPath.replaceAll("\\", "/"), { size: info.size, mtime_ms: Math.trunc(info.mtimeMs) });
  };
  const info = await stat(absPath);
  if (info.isFile()) {
    await addEntry(absPath, ".");
    return entries;
  }
  if (!info.isDirectory()) throw new Error("file_watch path must be a file or directory.");
  const visit = async (dir, prefix = "") => {
    const children = await readdir(dir, { withFileTypes: true });
    for (const child of children) {
      if ([".git", "node_modules", ".deepseek-watch"].includes(child.name)) continue;
      const childPath = join(dir, child.name);
      const relPath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isFile()) await addEntry(childPath, relPath);
      else if (recursive && child.isDirectory()) await visit(childPath, relPath);
    }
  };
  await visit(absPath);
  return entries;
}

async function checkFileWatch(absPath, key, recursive, reset, maxChanges) {
  const current = await snapshotWatchedPath(absPath, recursive);
  const previous = fileWatchSnapshots.get(key);
  fileWatchSnapshots.set(key, current);
  if (reset || !previous) return { initialized: true, changes: [], tracked_files: current.size };
  const changes = [];
  for (const [path, details] of current) {
    const before = previous.get(path);
    if (!before) changes.push({ type: "created", path, ...details });
    else if (before.size !== details.size || before.mtime_ms !== details.mtime_ms) changes.push({ type: "modified", path, ...details });
  }
  for (const path of previous.keys()) if (!current.has(path)) changes.push({ type: "deleted", path });
  return { initialized: false, changes: changes.slice(0, maxChanges), total_changes: changes.length, tracked_files: current.size };
}

async function projectMemory(action, key, value) {
  const memoryPath = join(resolve(process.cwd()), ".deepseek-watch", "project-memory.json");
  let memory = { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(memoryPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") memory = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not read project memory: ${error.message}`);
  }
  const operation = String(action || "get").toLowerCase();
  if (operation === "list") return Object.entries(memory.entries).map(([entryKey, entry]) => ({ key: entryKey, updated_at: entry.updated_at || "" }));
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) throw new Error("key is required unless action is list.");
  if (operation === "get") return memory.entries[normalizedKey] || null;
  if (operation === "set") {
    memory.entries[normalizedKey] = { value, updated_at: nowIso() };
    await atomicWriteFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);
    return { key: normalizedKey, ...memory.entries[normalizedKey] };
  }
  if (operation === "delete") {
    const existed = Object.prototype.hasOwnProperty.call(memory.entries, normalizedKey);
    delete memory.entries[normalizedKey];
    await atomicWriteFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);
    return { key: normalizedKey, deleted: existed };
  }
  throw new Error("action must be get, set, delete, or list.");
}

async function packageScriptNames() {
  try {
    const pkg = JSON.parse(await readFile(join(resolve(process.cwd()), "package.json"), "utf8"));
    return Object.keys(pkg.scripts || {});
  } catch {
    return [];
  }
}

async function runNamedPackageScripts(preferredNames, timeoutMs) {
  const available = await packageScriptNames();
  const selected = preferredNames.filter((name) => available.includes(name));
  if (!selected.length) return { found: false, available_scripts: available, results: [] };
  const results = [];
  for (const script of selected) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(script)) throw new Error(`Unsupported npm script name: ${script}`);
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run ${script}`]
      : ["run", script];
    results.push({ script, result: await runLocalCommand(command, commandArgs, timeoutMs, process.cwd()) });
  }
  return { found: true, results };
}

async function semanticSearchWorkspace(query, maxResults) {
  const terms = [...new Set(String(query || "").toLowerCase().match(/[a-z0-9_./-]{2,}/g) || [])].slice(0, 12);
  if (!terms.length) throw new Error("query must include at least one searchable term.");
  const results = [];
  let scanned = 0;
  const workspace = resolve(process.cwd());
  for await (const item of walkDir(workspace, workspace, { type: "file" })) {
    if (++scanned > 2000) break;
    if (await isBinaryFile(item.absPath)) continue;
    let text;
    try { text = (await readFile(item.absPath, "utf8")).slice(0, 1_000_000); } catch { continue; }
    const lower = text.toLowerCase();
    let score = 0;
    const matches = [];
    for (const term of terms) {
      const count = lower.split(term).length - 1;
      if (count) {
        score += Math.min(count, 20);
        if (item.relPath.toLowerCase().includes(term)) score += 8;
        matches.push({ term, count });
      }
    }
    if (!score) continue;
    const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
    results.push({ path: item.relPath, score, matches, snippet: text.slice(Math.max(0, first - 120), first + 360).replace(/\s+/g, " ").trim() });
  }
  return { query, terms, scanned_files: scanned, results: results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, maxResults) };
}

async function planReview() {
  const repository = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (!repository.ok || repository.out.trim() !== "true") {
    return {
      git_repository: false,
      git_status: "",
      diff_stat: "",
      whitespace_clean: null,
      whitespace_findings: "Skipped: workspace is not a Git repository.",
      review_checklist: [
        "Confirm changed files are in scope and no unrelated edits are included.",
        "Run diagnostics or tests appropriate to the touched code.",
        "Check error paths, timeouts, and permission boundaries for behavior changes.",
        "Summarize user-visible behavior and any remaining risks before handoff."
      ]
    };
  }
  const [status, statSummary, whitespace] = await Promise.all([
    runGit(["status", "--short", "--branch"]),
    runGit(["diff", "--stat"]),
    runGit(["diff", "--check"])
  ]);
  return {
    git_repository: true,
    git_status: status.out.trim(),
    diff_stat: statSummary.out.trim(),
    whitespace_clean: whitespace.ok,
    whitespace_findings: whitespace.ok ? "" : (whitespace.out || whitespace.err).trim(),
    review_checklist: [
      "Confirm changed files are in scope and no unrelated edits are included.",
      "Run diagnostics or tests appropriate to the touched code.",
      "Check error paths, timeouts, and permission boundaries for behavior changes.",
      "Summarize user-visible behavior and any remaining risks before handoff."
    ]
  };
}

function commandStatus(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || ""
  };
}

function maskedSecretStatus(value) {
  if (!value) return "not set";
  const text = String(value);
  if (text.length <= 10) return "set";
  return `set (${text.slice(0, 7)}...${text.slice(-4)})`;
}

function setUserEnvironmentVariable(name, value) {
  const key = String(value || "").trim();
  if (!key) throw new Error(`${name} cannot be empty.`);
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Environment]::SetEnvironmentVariable('${name}', $env:DSW_SECRET_VALUE, 'User')`
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, DSW_SECRET_VALUE: key }
      }
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `Failed to set ${name}`).trim());
    }
    return `${name} saved to the Windows user environment. Open a new terminal for it to appear automatically.`;
  }
  throw new Error(`Automatic persistent ${name} setup is only implemented on Windows. Add export ${name}="..." to your shell profile.`);
}

async function doctor() {
  const deepSeekKey = await getDeepSeekApiKey();
  const openAiKey = await getProviderApiKey("openai");
  const googleSearchKey = process.env.GOOGLE_SEARCH_API_KEY || "";
  const googleSearchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID || "";
  const braveSearchKey = process.env.BRAVE_SEARCH_API_KEY || "";
  const skills = await discoverSkills({});
  const skillRootsText = skillRootsWithSources({})
    .map(({ root, source }) => `${source}: ${root}`)
    .join("\n           ");
  const dswStatus = commandStatus("dsw", ["--help"]);
  const pbcStatus = commandStatus("pbc", ["--help"]);
  const lines = [
    "Switchyard Doctor",
    "",
    `Workspace: ${process.cwd()}`,
    `Node: ${process.version}`,
    `Config path: ${configPath()}`,
    `DeepSeek API key: ${deepSeekKey ? "configured" : "not_configured"}`,
    `GLM API key: ${(await getProviderApiKey("glm")) ? "configured" : "not_configured"}`,
    `Claude API key: ${(await getProviderApiKey("anthropic")) ? "configured" : "not_configured"}`,
    `OpenAI API key: ${openAiKey ? "configured" : "not_configured"}`,
    "",
    "DeepSeek",
    `  API key: ${deepSeekKey ? maskedSecretStatus(deepSeekKey) : "not set"}`,
    `  Setup: switchyard config set-key <deepseek-key>`,
    "",
    "OpenAI vision",
    `  OPENAI_API_KEY: ${maskedSecretStatus(openAiKey)}`,
    `  OPENAI_VISION_MODEL: ${process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini (default)"}`,
    `  Tool: analyze_image_openai ${openAiKey ? "available" : "blocked until OPENAI_API_KEY is set"}`,
    "  Create key: https://platform.openai.com/api-keys",
    "  Billing/limits: https://platform.openai.com/settings/organization/billing/overview",
    "  Current terminal: $env:OPENAI_API_KEY = \"sk-proj-...\"",
    "  Persist for new terminals: switchyard config set-openai-key <openai-key>",
    "",
    "Web search",
    `  default provider: ${selectedSearchProvider()}`,
    `  available providers: ${configuredSearchProviders().join(", ")}`,
    `  GOOGLE_SEARCH_API_KEY: ${maskedSecretStatus(googleSearchKey)}`,
    `  GOOGLE_SEARCH_ENGINE_ID: ${googleSearchEngineId ? "set" : "not set"}`,
    `  BRAVE_SEARCH_API_KEY: ${maskedSecretStatus(braveSearchKey)}`,
    "  Google setup: https://programmablesearchengine.google.com/controlpanel/all",
    "  Persist Google key: switchyard config set-google-search-key <google-api-key>",
    "  Persist Google engine: switchyard config set-google-search-engine-id <engine-id>",
    "",
    "CLI",
    `  dsw on PATH: ${dswStatus.ok ? "yes" : "no"}`,
    `  pbc on PATH: ${pbcStatus.ok ? "yes" : "no"}`,
    "",
    "Skills",
    `  roots: ${skillRootsText}`,
    `  discovered: ${skills.length}${skills.some((skill) => !skill.enabled) ? ` (${skills.filter((skill) => !skill.enabled).length} disabled)` : ""}`,
    ...skills.slice(0, 8).map((skill) => `  - ${skill.name} [${skill.source}${skill.enabled ? "" : ", disabled"}]: ${skill.path}`),
    skills.length > 8 ? `  ... ${skills.length - 8} more` : ""
  ].filter((line) => line !== "");
  return lines.join("\n");
}

async function runBalanceCommand(args) {
  let minimum = null;
  let currency = "USD";
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[i];
    };
    if (arg === "--minimum") minimum = Number.parseFloat(next());
    else if (arg === "--currency") currency = String(next()).trim().toUpperCase();
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown balance option: ${arg}`);
  }

  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) {
    throw new Error("--minimum must be a non-negative amount.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("--currency must be a three-letter currency code.");

  const status = await getProviderBalance("deepseek", {
    apiKey: await getDeepSeekApiKey(),
    timeoutMs: 10_000
  });
  const checkedAt = new Date().toISOString();
  const belowMinimum = minimum === null ? null : isBelowMinimum(status, minimum, currency);
  const result = { ...status, checkedAt, minimum, minimumCurrency: currency, belowMinimum };

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = ["DeepSeek balance", `Checked: ${checkedAt}`, `API available: ${status.available ? "yes" : "no"}`];
    for (const balance of status.balances) {
      lines.push(`${balance.currency}: ${balance.total.toFixed(2)} total (${balance.toppedUp.toFixed(2)} topped up, ${balance.granted.toFixed(2)} granted)`);
    }
    if (minimum !== null) lines.push(`Minimum ${currency} ${minimum.toFixed(2)}: ${belowMinimum ? "BELOW" : "ok"}`);
    if (belowMinimum) lines.push(`Top up manually: ${DEEPSEEK_TOP_UP_URL}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  if (!status.available || belowMinimum) process.exitCode = 2;
}

// Shell tools accept a working directory: absolute paths are used as-is,
// relative paths resolve against the workspace root.
function resolveShellCwd(value) {
  if (!value) return resolve(process.cwd());
  const text = String(value).trim();
  if (!text) return resolve(process.cwd());
  return isAbsolute(text) ? resolve(text) : assertInsideWorkspace(text);
}

async function maybeRunShellTool(opts, shellName, command, timeoutMs, cwd = process.cwd()) {
  const timeout = Math.min(Number(timeoutMs) || 60000, 600000);
  if (!command || typeof command !== "string") return "command error: command must be a non-empty string";
  if (opts.permission === "review") return "blocked by session permission: review only";

  if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const ok = await askYesNo(`Allow ${shellName} command?\n${command}\n`);
    if (!ok) return "blocked by user";
  }

  if (shellName === "cmd") return runLocalCommand("cmd.exe", ["/d", "/s", "/c", command], timeout, cwd);
  if (shellName === "bash") return runLocalCommand(resolveBashExecutable(), ["-lc", command], timeout, cwd);
  return runLocalCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], timeout, cwd);
}

function resolveBashExecutable() {
  if (process.env.DSW_BASH_PATH) return process.env.DSW_BASH_PATH;
  if (platform() === "win32") {
    for (const candidate of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bash.exe";
}

function activeSession(opts) {
  if (!opts.sessionObject) throw new Error("No active session object.");
  return opts.sessionObject;
}

function activeAgentRuntime(opts) {
  if (!opts.agentRuntime) throw new Error("Agent coordination is not initialized for this session.");
  return opts.agentRuntime;
}

function validatePlanItems(plan) {
  if (!Array.isArray(plan)) throw new Error("plan must be an array.");
  const allowed = new Set(["pending", "in_progress", "completed"]);
  return plan.map((item, index) => {
    const step = String(item?.step || "").trim();
    const status = String(item?.status || "").trim();
    if (!step) throw new Error(`plan[${index}].step must be non-empty.`);
    if (!allowed.has(status)) throw new Error(`plan[${index}].status must be pending, in_progress, or completed.`);
    return { step, status };
  });
}

function planProgress(plan = []) {
  const counts = { pending: 0, in_progress: 0, completed: 0, total: plan.length };
  for (const item of plan) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

async function pathExistsAbs(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readTail(absPath, tailLines) {
  try {
    const text = await readFile(absPath, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(-tailLines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function handoffCliArgs(cli, prompt, promptFile, cliArgs) {
  const parsed = parseCommandLineArgs(cliArgs);
  const lower = String(cli || "").toLowerCase();
  if (lower.includes("claude")) return ["-p", prompt, ...parsed];
  const hasPrompt = parsed.some((arg) => ["-p", "--prompt", "--prompt-file", "--stdin"].includes(arg));
  if (hasPrompt) return parsed;
  return ["--prompt-file", promptFile, ...parsed];
}

async function runTool(opts, name, args) {
  if (name === "get_runtime_context") return runtimeContext();

  if (name === "agent_identity") {
    return jsonResult(activeAgentRuntime(opts).record);
  }

  if (name === "agent_list") {
    return jsonResult(await listAgents(opts.coordDir, { includeStopped: args.include_stopped === true }));
  }

  if (name === "agent_send") {
    const message = await sendAgentMessage(opts.coordDir, {
      from: opts.agentId,
      to: args.to,
      body: args.message,
      type: args.type,
      priority: args.priority,
      taskId: args.task_id,
      replyTo: args.reply_to
    });
    return jsonResult(message);
  }

  if (name === "agent_check_inbox") {
    return jsonResult(await readAgentInbox(opts.coordDir, opts.agentId, { max: args.max }));
  }

  if (name === "agent_task_create") {
    if (opts.agentRole !== "coordinator") throw new Error("agent_task_create requires --agent-role coordinator.");
    return jsonResult(await createTask(opts.coordDir, {
      taskId: args.task_id,
      title: args.title,
      description: args.description,
      scope: args.scope,
      acceptanceCriteria: args.acceptance_criteria,
      dependsOn: args.depends_on,
      createdBy: opts.agentId
    }));
  }

  if (name === "agent_task_list") {
    return jsonResult(await listTasks(opts.coordDir));
  }

  if (name === "agent_claim") {
    const claim = await claimTask(opts.coordDir, {
      taskId: args.task_id,
      agentId: opts.agentId,
      leaseSeconds: args.lease_seconds
    });
    await activeAgentRuntime(opts).addClaim(args.task_id);
    return jsonResult(claim);
  }

  if (name === "agent_handoff") {
    const task = await completeTask(opts.coordDir, {
      taskId: args.task_id,
      agentId: opts.agentId,
      summary: args.summary,
      status: args.status
    });
    await activeAgentRuntime(opts).removeClaim(args.task_id);
    let message = null;
    if (args.to) {
      message = await sendAgentMessage(opts.coordDir, {
        from: opts.agentId,
        to: args.to,
        body: args.summary,
        type: "handoff",
        taskId: args.task_id,
        priority: "normal"
      });
    }
    return jsonResult({ task, message });
  }

  if (name === "agent_wait") {
    const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds) || 0, 0), 604800);
    opts.agentWaitRequest = {
      reason: String(args.reason || "Waiting for another agent."),
      timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0,
      requestedAt: nowIso()
    };
    return timeoutSeconds > 0
      ? `Agent ${opts.agentId} will park after this tool batch for up to ${timeoutSeconds} seconds.`
      : `Agent ${opts.agentId} will park after this tool batch until a message arrives.`;
  }

  if (name === "compact_session") {
    const session = activeSession(opts);
    const meta = await compactSession({ ...opts, compactMethod: opts.compactMethod === "detached" ? "auto" : opts.compactMethod, compactForce: Boolean(args.force) }, session);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    return jsonResult(meta || { compacted: false, usage: estimateContextTokens(session.messages) });
  }

  if (name === "agent_compact") {
    return jsonResult(await compactAgentSession(opts, args));
  }

  if (name === "list_models") return jsonResult(await listProviderModels(args));
  if (name === "spawn_agent") return jsonResult(await spawnSwarmAgent(opts, args, { resume: false }));
  if (name === "resume_agent") return jsonResult(await spawnSwarmAgent(opts, args, { resume: true }));

  if (name === "classify_url") return jsonResult(classifyUrl(args.url));

  if (name === "verify_download") {
    return jsonResult(await verifyDownload(args.input, { quarantineDir: args.quarantine_dir }));
  }

  if (name === "watch_downloads") return jsonResult(await watchDownloads(args.since));

  if (name === "track_bypass_state") {
    const hasValue = Object.prototype.hasOwnProperty.call(args, "value");
    return jsonResult({ key: String(args.key), value: await trackSafetyState(args.key, hasValue ? args.value : undefined) });
  }

  if (name === "scan_download_hash") return jsonResult(await virusTotalLookup(args.hash));
  if (name === "virus_total") return jsonResult(await virusTotalLookup(args.value));
  if (name === "whois_lookup") return jsonResult(await whoisLookup(args.domain));
  if (name === "dns_lookup") return jsonResult(await dnsLookup(args.domain));
  if (name === "cert_logs") return jsonResult(await certLogs(args.domain));

  if (name === "file_analyze") {
    const target = assertInsideWorkspace(args.path);
    return jsonResult(await fileAnalyze(target));
  }

  if (name === "file_watch") {
    const target = assertInsideWorkspace(args.path);
    const recursive = args.recursive !== false;
    const maxChanges = Math.min(Math.max(Number(args.max_changes) || 200, 1), 2000);
    return jsonResult(await checkFileWatch(target, `${target}|${recursive}`, recursive, args.reset === true, maxChanges));
  }

  if (name === "project_memory") {
    const action = String(args.action || "get").toLowerCase();
    if (["set", "delete"].includes(action)) {
      if (opts.permission === "review") return "blocked by session permission: review only";
      if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
        if (opts.noOutput) return "blocked by no-output mode";
        const ok = await askYesNo(`${action === "set" ? "Store" : "Delete"} project memory key '${String(args.key || "")}'?`);
        if (!ok) return "blocked by user";
      }
    }
    return jsonResult(await projectMemory(action, args.key, args.value));
  }

  if (name === "diagnostics" || name === "run_tests") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const scripts = name === "diagnostics" ? "lint, typecheck, and check" : "test";
      const ok = await askYesNo(`Run configured npm ${scripts} script(s)?`);
      if (!ok) return "blocked by user";
    }
    const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000);
    const scripts = name === "diagnostics" ? ["lint", "typecheck", "check"] : ["test"];
    return jsonResult(await runNamedPackageScripts(scripts, timeout));
  }

  if (name === "semantic_search") {
    const maxResults = Math.min(Math.max(Number(args.max_results) || 20, 1), 100);
    return jsonResult(await semanticSearchWorkspace(args.query, maxResults));
  }

  if (name === "plan_review") return jsonResult(await planReview());

  if (name === "process_manage") {
    const action = String(args.action || "list").toLowerCase();
    if (["start", "stop"].includes(action)) {
      if (opts.permission === "review") return "blocked by session permission: review only";
      if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
        if (opts.noOutput) return "blocked by no-output mode";
        const detail = action === "start" ? `\nCommand: ${String(args.command || "")}` : "";
        const ok = await askYesNo(`${action === "start" ? "Start" : "Stop"} managed process '${String(args.name || "")}'?${detail}`);
        if (!ok) return "blocked by user";
      }
    }
    return jsonResult(await manageProcess(args));
  }

  if (name === "create_goal") {
    const session = activeSession(opts);
    const objective = String(args.objective || "").trim();
    if (!objective) throw new Error("objective must be non-empty.");
    const budget = args.token_budget == null ? undefined : Number(args.token_budget);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error("token_budget must be positive when provided.");
    const now = nowIso();
    session.goal = {
      objective,
      status: "active",
      ...(budget !== undefined ? { token_budget: budget } : {}),
      createdAt: now,
      updatedAt: now,
      notes: []
    };
    return jsonResult(session.goal);
  }

  if (name === "get_goal") {
    return jsonResult(activeSession(opts).goal || null);
  }

  if (name === "update_goal") {
    const session = activeSession(opts);
    if (!session.goal) throw new Error("No active goal. Use create_goal first.");
    const status = String(args.status || "");
    if (!["complete", "blocked"].includes(status)) throw new Error("status must be complete or blocked.");
    const now = nowIso();
    session.goal.status = status;
    session.goal.updatedAt = now;
    if (!Array.isArray(session.goal.notes)) session.goal.notes = [];
    if (args.note) session.goal.notes.push({ at: now, note: String(args.note) });
    return jsonResult(session.goal);
  }

  if (name === "update_plan") {
    const session = activeSession(opts);
    session.plan = validatePlanItems(args.plan);
    if (args.explanation) {
      session.planExplanation = String(args.explanation);
      session.planUpdatedAt = nowIso();
    }
    return jsonResult({ plan: session.plan, explanation: session.planExplanation || "", progress: planProgress(session.plan) });
  }

  if (name === "get_plan") {
    const session = activeSession(opts);
    return jsonResult({ plan: session.plan || [], explanation: session.planExplanation || "", progress: planProgress(session.plan || []) });
  }

  if (name === "session_health") {
    const session = activeSession(opts);
    const repaired = repairToolCallHistory(session.messages || []);
    return jsonResult({
      version: session.version || null,
      createdAt: session.createdAt || "",
      updatedAt: session.updatedAt || "",
      workspace: session.workspace || process.cwd(),
      message_count: (session.messages || []).length,
      non_system_message_count: (session.messages || []).filter((message) => message.role !== "system").length,
      tool_history_repairs_needed: repaired.repairs,
      touched_files: session.touchedFiles || [],
      goal: session.goal || null,
      plan_progress: planProgress(session.plan || []),
      checkpoint_count: Array.isArray(session.checkpoints) ? session.checkpoints.length : 0,
      latest_checkpoint: Array.isArray(session.checkpoints) && session.checkpoints.length ? session.checkpoints[session.checkpoints.length - 1] : null
    });
  }

  if (name === "checkpoint_session") {
    const session = activeSession(opts);
    if (!Array.isArray(session.checkpoints)) session.checkpoints = [];
    const checkpoint = {
      label: String(args.label || `checkpoint ${session.checkpoints.length + 1}`),
      summary: String(args.summary || finalAssistantContent(session) || "(no summary)"),
      createdAt: nowIso()
    };
    session.checkpoints.push(checkpoint);
    return jsonResult(checkpoint);
  }

  if (name === "summarize_session") {
    const session = activeSession(opts);
    const maxMessages = Math.min(Math.max(Number(args.max_messages) || 12, 1), 50);
    const messages = (session.messages || []).filter((message) => message.role !== "system").slice(-maxMessages);
    return [
      `Session summary (${messages.length} recent messages)`,
      session.goal ? `Goal: ${session.goal.objective} [${session.goal.status}]` : "Goal: none",
      `Plan: ${planProgress(session.plan || []).completed}/${planProgress(session.plan || []).total} completed`,
      "",
      ...messages.map((message) => compactMessageForSummary(message))
    ].join("\n");
  }

  if (name === "handoff_status") {
    const outputPath = assertInsideWorkspace(args.output_file);
    const logPath = args.log_file ? assertInsideWorkspace(args.log_file) : null;
    const tailLines = Math.min(Math.max(Number(args.tail_lines) || 40, 1), 200);
    const outputExists = await pathExistsAbs(outputPath);
    const logExists = logPath ? await pathExistsAbs(logPath) : false;
    const result = {
      output_file: args.output_file,
      output_exists: outputExists,
      log_file: args.log_file || null,
      log_exists: logExists,
      output: outputExists ? compactText(await readFile(outputPath, "utf8"), 4000) : "",
      log_tail: logExists ? await readTail(logPath, tailLines) : ""
    };
    return jsonResult(result);
  }

  if (name === "handoff_wait") {
    const outputPath = assertInsideWorkspace(args.output_file);
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 300, 1), 7200) * 1000;
    const pollMs = Math.min(Math.max(Number(args.poll_ms) || 1000, 100), 30000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pathExistsAbs(outputPath)) {
        if (args.print_content) return await readFile(outputPath, "utf8");
        return `Handoff output ready: ${args.output_file}`;
      }
      await sleep(pollMs);
    }
    return `Timed out waiting for handoff output: ${args.output_file}`;
  }

  if (name === "handoff_start") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const promptPath = assertInsideWorkspace(args.prompt_file);
    const outputPath = assertInsideWorkspace(args.output_file);
    const logPath = assertInsideWorkspace(args.log_file);
    const promptInfo = await stat(promptPath);
    if (!promptInfo.isFile()) throw new Error("prompt_file is not a file.");
    if (await pathExistsAbs(outputPath)) throw new Error("output_file already exists; remove it or choose a fresh output file.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const ok = await askYesNo(`Start handoff?\nPrompt: ${args.prompt_file}\nOutput: ${args.output_file}\nLog: ${args.log_file}`);
      if (!ok) return "blocked by user";
    }
    await mkdir(dirname(logPath), { recursive: true });
    const prompt = await readFile(promptPath, "utf8");
    const cli = String(args.cli || "claude");
    const childArgs = handoffCliArgs(cli, prompt, promptPath, args.cli_args);
    await appendFile(logPath, `[${nowIso()}] starting ${cli} ${childArgs.map((arg) => JSON.stringify(arg)).join(" ")}\n`, "utf8");
    const logFd = openSync(logPath, "a");
    const child = spawn(cli, childArgs, {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", logFd, logFd]
    });
    closeSync(logFd);
    child.on("error", (error) => {
      appendFile(logPath, `\n[${nowIso()}] spawn error: ${error.message}\n`, "utf8").catch(() => {});
    });
    child.unref();
    return jsonResult({
      started: true,
      pid: child.pid,
      cli,
      output_file: args.output_file,
      log_file: args.log_file,
      timeout_seconds: Math.min(Math.max(Number(args.timeout_seconds) || 7200, 1), 7200)
    });
  }

  if (name === "list_workspace_files") {
    const workspaceRoot = resolve(process.cwd());
    const target = assertInsideWorkspace(args.path || ".");
    const max = Math.min(Number(args.max) || 200, 2000);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const typeFilter = args.type || "all";
    const includeMetadata = args.include_metadata === true;
    const globRx = args.glob ? globToRegex(args.glob) : null;
    const excludeGlobRxs = args.exclude_glob ? [globToRegex(args.exclude_glob)] : [];
    const userExcludes = Array.isArray(args.exclude_patterns) ? args.exclude_patterns : [];
    const excludeDirNames = [...DEFAULT_TRAVERSE_EXCLUDES, ...userExcludes];

    if (!args.recursive) {
      const entries = await readdir(target, { withFileTypes: true });
      let list = entries;
      if (typeFilter === "file") list = list.filter((e) => e.isFile());
      else if (typeFilter === "dir") list = list.filter((e) => e.isDirectory());
      if (globRx) list = list.filter((e) => globRx.test(e.name));
      const page = list.slice(offset, offset + max);
      if (!includeMetadata) {
        return page.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n");
      }
      const lines = [];
      for (const e of page) {
        try {
          const info = await stat(join(target, e.name));
          const size = e.isFile() ? ` ${info.size}B` : "";
          const mtime = info.mtime.toISOString().slice(0, 19) + "Z";
          lines.push(`${e.isDirectory() ? "dir " : "file"} ${e.name}${size} modified=${mtime}`);
        } catch {
          lines.push(`${e.isDirectory() ? "dir " : "file"} ${e.name}`);
        }
      }
      return lines.join("\n");
    }

    const items = [];
    for await (const item of walkDir(workspaceRoot, target, { excludeDirNames, excludeGlobRxs, type: typeFilter })) {
      if (globRx && !globRx.test(item.relPath) && !globRx.test(item.relPath.split("/").pop())) continue;
      items.push(item);
    }
    const page = items.slice(offset, offset + max);
    const hasMore = items.length > offset + max;

    if (!includeMetadata) {
      const lines = page.map((item) => `${item.isDir ? "dir " : "file"} ${item.relPath}`);
      if (hasMore) lines.push(`[${items.length - offset - max} more; use offset=${offset + max}]`);
      return lines.join("\n");
    }
    const lines = [];
    for (const item of page) {
      try {
        const info = await stat(item.absPath);
        const size = !item.isDir ? ` ${info.size}B` : "";
        const mtime = info.mtime.toISOString().slice(0, 19) + "Z";
        lines.push(`${item.isDir ? "dir " : "file"} ${item.relPath}${size} modified=${mtime}`);
      } catch {
        lines.push(`${item.isDir ? "dir " : "file"} ${item.relPath}`);
      }
    }
    if (hasMore) lines.push(`[${items.length - offset - max} more; use offset=${offset + max}]`);
    return lines.join("\n");
  }

  if (name === "read_text_file") {
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Path is not a file.");

    if (args.start_line != null) {
      const text = await readFile(target, "utf8");
      const lines = text.split("\n");
      const total = lines.length;
      const start = Math.max(1, Number(args.start_line));
      const end = args.end_line != null ? Math.min(Number(args.end_line), total) : Math.min(start + 99, total);
      return `[lines ${start}–${end} of ${total} in ${args.path}]\n${lines.slice(start - 1, end).join("\n")}`;
    }

    const maxBytes = Math.min(Number(args.max_bytes) || 20000, 200000);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const explicitOffset = Object.prototype.hasOwnProperty.call(args, "offset");
    if (info.size > maxBytes && !explicitOffset) {
      return [
        `File too large: ${args.path} is ${info.size} bytes; max_bytes is ${maxBytes}.`,
        "Use start_line/end_line for targeted reads, or offset/max_bytes for byte chunks:",
        `read_text_file {"path":"${args.path}","start_line":1,"end_line":100}`,
        `read_text_file {"path":"${args.path}","offset":0,"max_bytes":${maxBytes}}`
      ].join("\n");
    }
    const data = await readFile(target);
    const dataEnd = Math.min(offset + maxBytes, data.length);
    const chunk = data.subarray(offset, dataEnd).toString("utf8");
    if (args.structured) {
      return JSON.stringify({
        content: chunk,
        next_offset: dataEnd < data.length ? dataEnd : null,
        total_bytes: data.length
      });
    }
    const more = dataEnd < data.length ? `\n\n[chunk ${offset}-${dataEnd} of ${data.length} bytes; continue with offset ${dataEnd}]` : "";
    return `${chunk}${more}`;
  }

  if (name === "web_search") {
    return webSearch(args);
  }

  if (name === "web_fetch") {
    return webFetch(args);
  }

  if (name === "web_find") {
    return webFind(args);
  }

  if (name === "view_image") {
    return viewImage(args);
  }

  if (name === "analyze_image_openai") {
    return analyzeImageOpenAI(args);
  }

  if (name === "list_skills") {
    return formatSkillList(await discoverSkills(opts));
  }

  if (name === "read_skill") {
    const skill = await resolveSkill(opts, args.name);
    return [
      `Skill: ${skill.name}`,
      `Path: ${skill.path}`,
      "",
      skill.content
    ].join("\n");
  }

  if (name === "write_text_file") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const target = assertInsideWorkspace(args.path);
    if (typeof args.content !== "string") throw new Error("content must be a string.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      let exists = false;
      try { await stat(target); exists = true; } catch {}
      const ok = await askYesNo(`${exists ? "Overwrite" : "Create"} file: ${args.path}?`);
      if (!ok) return "blocked by user";
    }
    await atomicWriteFile(target, args.content);
    opts.touchedFiles?.add(args.path);
    return `Wrote ${args.path} (${args.content.length} chars)`;
  }

// ── EOL-tolerant exact patching ──────────────────────────────────────────────
// patch_text_file / patch_files historically required byte-exact old_string
// matches, including CRLF vs LF. On Windows checkouts that produces the
// classic "old_string not found" loop. These helpers try the byte-exact match
// first, then fall back to a CRLF/LF-insensitive match, and write inserted
// text using the file's dominant line ending so the rest of the file is
// untouched.

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeEolMap(content) {
  const normChars = [];
  const origStart = [];
  const origEnd = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 13 && content.charCodeAt(i + 1) === 10) {
      normChars.push("\n");
      origStart.push(i);
      origEnd.push(i + 2);
      i += 1;
    } else {
      normChars.push(content[i]);
      origStart.push(i);
      origEnd.push(i + 1);
    }
  }
  return { norm: normChars.join(""), origStart, origEnd };
}

function normIncludes(content, needle) {
  if (content.includes(needle)) return true;
  return content.replace(/\r\n/g, "\n").includes(String(needle).replace(/\r\n/g, "\n"));
}

function patchEolTolerant(content, oldString, newString, { replaceAll = false } = {}) {
  newString = String(newString == null ? "" : newString);
  // NOTE: split/join for the literal path — String.replace() interprets
  // dollar-special sequences (dollar-quote, dollar-backtick, dollar-amp,
  // dollar-dollar, dollar-digit) inside the REPLACEMENT as special patterns,
  // which silently corrupts patches containing those sequences (e.g.
  // PowerShell dollar-quote syntax). split/join is literal.
  const literalReplace = (haystack, needle, replacement) => {
    const parts = haystack.split(needle);
    if (parts.length === 1) return null;
    return { content: parts.join(replacement), count: parts.length - 1 };
  };
  if (content.includes(oldString)) {
    return literalReplace(content, oldString, newString) || { content, count: 0 };
  }
  // CRLF/LF tolerant fallback: match on normalized text, splice the original.
  const fileEol = detectEol(content);
  const { norm, origStart, origEnd } = normalizeEolMap(content);
  const normOld = oldString.replace(/\r\n/g, "\n");
  const indices = [];
  let from = 0;
  while (true) {
    const idx = norm.indexOf(normOld, from);
    if (idx === -1) break;
    indices.push(idx);
    from = idx + Math.max(normOld.length, 1);
  }
  if (!indices.length) return null;
  const normNew = newString.replace(/\r\n/g, "\n").replace(/\n/g, fileEol);
  const targets = replaceAll ? indices : indices.slice(0, 1);
  let out = content;
  for (let i = targets.length - 1; i >= 0; i--) {
    const idx = targets[i];
    const start = origStart[idx];
    const end = origEnd[idx + normOld.length - 1];
    out = out.slice(0, start) + normNew + out.slice(end);
  }
  return { content: out, count: targets.length };
}

  if (name === "patch_text_file") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Path is not a file.");
    const content = await readFile(target, "utf8");
    const replaceAll = args.replace_all === true;
    const patched = patchEolTolerant(content, args.old_string, args.new_string, { replaceAll });
    if (!patched) throw new Error("old_string not found in file.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const preview = args.old_string.slice(0, 120);
      const ok = await askYesNo(`Patch ${args.path}?\nReplace: ${preview}${args.old_string.length > 120 ? "…" : ""}`);
      if (!ok) return "blocked by user";
    }
    const count = patched.count;
    await atomicWriteFile(target, patched.content);
    opts.touchedFiles?.add(args.path);
    return `Patched ${args.path} (${count} replacement${count !== 1 ? "s" : ""})`;
  }

  if (name === "run_cmd") {
    return maybeRunShellTool(opts, "cmd", args.command, args.timeout_ms, resolveShellCwd(args.path));
  }

  if (name === "run_bash") {
    return maybeRunShellTool(opts, "bash", args.command, args.timeout_ms, resolveShellCwd(args.path));
  }

  if (name === "run_powershell") {
    return maybeRunShellTool(opts, "powershell", args.command, args.timeout_ms, resolveShellCwd(args.path));
  }

  if (name === "functions_shell_command" || name === "functions.shell_command") {
    const cwd = resolveShellCwd(args.workdir);
    return maybeRunShellTool(opts, "powershell", args.command, args.timeout_ms ?? 120000, cwd);
  }

  if (name === "artifact_list") return jsonResult(await listArtifacts({ cwd: process.cwd(), taskId: opts.agentId || opts.session }));
  if (name === "artifact_read_range") return jsonResult(await readArtifactRange({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact, offset: args.offset, maxBytes: args.max_bytes }));
  if (name === "artifact_search") return jsonResult(await searchArtifact({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact, pattern: args.pattern, maxMatches: args.max_matches, contextChars: args.context_chars }));
  if (name === "artifact_index") return jsonResult(await getArtifactIndex({ cwd: process.cwd(), taskId: opts.agentId || opts.session }));
  if (name === "artifact_search_all") return jsonResult(await searchArtifacts({ cwd: process.cwd(), taskId: opts.agentId || opts.session, pattern: args.pattern, maxMatches: args.max_matches, contextChars: args.context_chars }));
  const taskKey = opts.agentId || opts.session;
  if (name === "pe_triage") return jsonResult(await peTriage({ cwd: process.cwd(), taskId: taskKey, path: args.path }));
  if (name === "net_list_interfaces") return jsonResult(await netListInterfaces({ cwd: process.cwd(), taskId: taskKey }));
  if (name === "net_capture_start") return jsonResult(await netCaptureStart({ cwd: process.cwd(), taskId: taskKey, interface: args.interface, durationSeconds: args.duration_seconds, maxFileMb: args.max_file_mb, ringFiles: args.ring_files, name: args.name }));
  if (name === "net_capture_stop") return jsonResult(await netCaptureStop({ cwd: process.cwd(), taskId: taskKey, name: args.name }));
  if (name === "net_capture_status") return jsonResult(await netCaptureStatus({ cwd: process.cwd(), taskId: taskKey }));
  if (name === "net_protocol_summary") return jsonResult(await netProtocolSummary({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact }));
  if (name === "net_conversations") return jsonResult(await netConversations({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact }));
  if (name === "net_query_pcap") return jsonResult(await netQueryPcap({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact, filter: args.filter, fields: args.fields }));
  if (name === "net_stream_summary") return jsonResult(await netStreamSummary({ cwd: process.cwd(), taskId: opts.agentId || opts.session, artifact: args.artifact }));
  if (name === "sandbox_execute") {
    if ((args.network_policy || SANDBOX_ENVIRONMENTS[args.environment]?.network) === "allowlisted") await requireScope(process.cwd(), taskKey, args.target, args.vulnerability_class);
    return jsonResult(await sandboxExecute({ cwd: process.cwd(), taskId: taskKey, environment: args.environment, command: args.command, timeoutMs: args.timeout_ms, workingDirectory: args.working_directory, cpu: args.cpu, memoryMb: args.memory_mb, networkPolicy: args.network_policy, persistence: args.persistence, env: args.env }));
  }
  if (name === "sandbox_manage") {
    if (args.environment === "web-testing") await requireScope(process.cwd(), taskKey, args.target, args.vulnerability_class);
    return jsonResult(await sandboxOperation({ cwd: process.cwd(), taskId: taskKey, ...args }));
  }
  if (name === "scope_get") return jsonResult(await getScope(process.cwd(), taskKey));
  if (name === "scope_check") return jsonResult(await checkScope(process.cwd(), taskKey, args.target, args.vulnerability_class));
  if (["scope_set", "scope_add_assets", "scope_remove_assets", "hypothesis_record", "viability_set", "roi_record", "model_escalation_set"].includes(name) && opts.permission === "review") return "blocked by session permission: review only";
  if (name === "scope_set") return jsonResult(await setScope(process.cwd(), taskKey, args));
  if (name === "scope_add_assets") return jsonResult(await addScopeAssets(process.cwd(), taskKey, args.assets));
  if (name === "scope_remove_assets") return jsonResult(await removeScopeAssets(process.cwd(), taskKey, args.assets));
  if (name === "hypothesis_record") return jsonResult(await recordHypothesis(process.cwd(), taskKey, args));
  if (name === "viability_set") return jsonResult(await recordViability(process.cwd(), taskKey, args));
  if (name === "roi_record") return jsonResult(await recordRoi(process.cwd(), taskKey, args));
  if (name === "model_escalation_get") return jsonResult(await getEscalationPolicy(process.cwd(), taskKey));
  if (name === "model_escalation_set") return jsonResult(await setEscalationPolicy(process.cwd(), taskKey, args));
  if (name === "model_escalation_decide") return jsonResult(await decideEscalation(process.cwd(), taskKey, args));

  if (name === "search_code") {
    return jsonResult(await boundedSearch({
      cwd: process.cwd(),
      taskId: opts.agentId || opts.session,
      pattern: args.pattern,
      path: args.path,
      glob: args.glob,
      ignoreCase: args.ignore_case,
      maxMatches: args.max_matches ?? args.max_results,
      maxResultChars: args.max_result_chars,
      maxTotalChars: args.max_total_chars,
      contextChars: args.context_chars,
      regexTimeoutMs: args.regex_timeout_ms,
      pageToken: args.page_token,
      allowExternal: opts.permission === "full"
    }));
  }

  if (name === "search_code") {
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    let searchRe;
    try { searchRe = new RegExp(pattern, args.ignore_case ? "i" : ""); }
    catch { searchRe = new RegExp(escapeRegex(pattern), args.ignore_case ? "i" : ""); }
    const workspaceRoot = resolve(process.cwd());
    const searchRoot = args.path ? assertInsideWorkspace(args.path) : workspaceRoot;
    let searchRootInfo;
    try {
      searchRootInfo = await stat(searchRoot);
    } catch {
      throw new Error(`search path does not exist: ${args.path}`);
    }
    const maxResults = Math.min(Number(args.max_results) || 200, 1000);
    const contextLines = Math.min(Math.max(Number(args.context_lines) || 0, 0), 5);
    const globRx = args.glob ? globToRegex(args.glob) : null;
    const userExcludes = Array.isArray(args.exclude_patterns) ? args.exclude_patterns : [];
    const excludeDirNames = args.respect_gitignore === false
      ? userExcludes
      : [...DEFAULT_TRAVERSE_EXCLUDES, ...userExcludes];
    const results = [];
    const searchItems = searchRootInfo.isFile()
      ? [{ absPath: searchRoot, relPath: relative(workspaceRoot, searchRoot).replace(/\\/g, "/"), isDir: false }]
      : walkDir(workspaceRoot, searchRoot, { excludeDirNames, type: "file" });
    outer: for await (const item of searchItems) {
      if (globRx && !globRx.test(item.relPath) && !globRx.test(item.relPath.split("/").pop())) continue;
      if (await isBinaryFile(item.absPath)) continue;
      let text;
      try { text = await readFile(item.absPath, "utf8"); } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (searchRe.test(lines[i])) {
          const s = Math.max(0, i - contextLines);
          const e = Math.min(lines.length - 1, i + contextLines);
          const snippet = lines.slice(s, e + 1).map((line, off) => {
            const ln = s + off + 1;
            const mark = s + off === i ? ">" : " ";
            return `${mark}${String(ln).padStart(5)}: ${line}`;
          }).join("\n");
          results.push(`${item.relPath}:${i + 1}\n${snippet}`);
          if (results.length >= maxResults) break outer;
        }
      }
    }
    if (!results.length) return `No matches for: ${pattern}`;
    const sep = "\n" + "─".repeat(60) + "\n";
    return results.join(sep) + (results.length >= maxResults ? `\n[capped at ${maxResults} results]` : "");
  }

  if (name === "read_text_files") {
    const files = Array.isArray(args.files) ? args.files : [];
    if (!files.length) return JSON.stringify({});
    const result = {};
    await Promise.all(files.map(async (spec) => {
      const filePath = typeof spec === "string" ? spec : spec?.path;
      if (!filePath) return;
      try {
        const target = assertInsideWorkspace(filePath);
        const info = await stat(target);
        if (!info.isFile()) { result[filePath] = { error: "not a file" }; return; }
        if (spec.start_line != null) {
          const text = await readFile(target, "utf8");
          const lines = text.split("\n");
          const total = lines.length;
          const start = Math.max(1, Number(spec.start_line));
          const end = spec.end_line != null ? Math.min(Number(spec.end_line), total) : Math.min(start + 99, total);
          result[filePath] = `[lines ${start}–${end} of ${total}]\n${lines.slice(start - 1, end).join("\n")}`;
        } else {
          const maxBytes = Math.min(Number(spec.max_bytes) || 20000, 200000);
          const data = await readFile(target);
          result[filePath] = data.subarray(0, maxBytes).toString("utf8");
        }
      } catch (e) {
        result[filePath] = { error: e.message };
      }
    }));
    return JSON.stringify(result, null, 2);
  }

  if (name === "git_status") {
    const scope = resolveGitScope(args.path);
    const gitArgs = ["status", "--short", "--branch"];
    if (scope.pathspec) gitArgs.push("--", scope.pathspec);
    const r = await runGit(gitArgs, scope.cwd);
    return r.out.trim() || r.err.trim() || "clean";
  }

  if (name === "git_diff") {
    const scope = resolveGitScope(args.path);
    const gitArgs = ["diff"];
    if (args.staged) gitArgs.push("--staged");
    if (args.target_branch) gitArgs.push(String(args.target_branch));
    if (scope.pathspec) gitArgs.push("--", scope.pathspec);
    const r = await runGit(gitArgs, scope.cwd);
    return r.out || "(no diff)";
  }

  if (name === "git_log") {
    const max = Math.min(Number(args.max_entries) || 20, 100);
    const scope = resolveGitScope(args.path);
    const gitArgs = ["log", `--max-count=${max}`, "--oneline", "--decorate"];
    if (scope.pathspec) gitArgs.push("--", scope.pathspec);
    const r = await runGit(gitArgs, scope.cwd);
    return r.out.trim() || "(no commits)";
  }

  if (name === "git_blame") {
    const target = assertInsideWorkspace(args.file_path);
    const gitArgs = ["blame"];
    if (args.start_line != null && args.end_line != null) {
      gitArgs.push("-L", `${args.start_line},${args.end_line}`);
    } else if (args.start_line != null) {
      gitArgs.push("-L", `${args.start_line},${args.start_line}`);
    }
    gitArgs.push(target);
    const r = await runGit(gitArgs);
    return r.out || r.err || "(no output)";
  }

  if (name === "stat_file") {
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    const type = info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
    const is_binary = info.isFile() ? await isBinaryFile(target) : false;
    return JSON.stringify({ path: args.path, type, size_bytes: info.size, modified_iso: info.mtime.toISOString(), is_binary }, null, 2);
  }

  if (name === "patch_files") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!edits.length) return "No edits provided.";

    // Group edits by resolved target path, preserving input order within each group,
    // so multiple edits to the SAME file apply sequentially instead of clobbering
    // each other with stale preflight content (last-edit-wins bug).
    const groups = new Map();
    const failures = [];
    for (const edit of edits) {
      let target;
      try {
        target = assertInsideWorkspace(edit.path);
        const info = await stat(target);
        if (!info.isFile()) { failures.push({ path: edit.path, error: "not a file" }); continue; }
      } catch (e) {
        failures.push({ path: edit.path, error: e.message });
        continue;
      }
      let group = groups.get(target);
      if (!group) {
        let content;
        try { content = await readFile(target, "utf8"); } catch (e) { failures.push({ path: edit.path, error: e.message }); continue; }
        group = { path: edit.path, target, content, edits: [] };
        groups.set(target, group);
      }
      group.edits.push(edit);
      if (!normIncludes(group.content, edit.old_string)) {
        failures.push({ path: edit.path, error: "old_string not found" });
      }
    }
    if (failures.length) {
      return `Preflight failed — no files written:\n${failures.map((f) => `  ${f.path}: ${f.error}`).join("\n")}`;
    }
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const preview = edits.map((e) => `  ${e.path}: ${e.old_string.slice(0, 60)}${e.old_string.length > 60 ? "…" : ""}`).join("\n");
      const ok = await askYesNo(`Patch ${edits.length} file${edits.length !== 1 ? "s" : ""}?\n${preview}`);
      if (!ok) return "blocked by user";
    }

    // Apply edits per file in memory first; only write files when every edit succeeds.
    const applied = [];
    for (const group of groups.values()) {
      let content = group.content;
      let count = 0;
      for (const edit of group.edits) {
        const result = patchEolTolerant(content, edit.old_string, edit.new_string, { replaceAll: edit.replace_all === true });
        if (!result) {
          return `Preflight failed — no files written:\n  ${group.path}: old_string no longer matches after an earlier edit to the same file`;
        }
        content = result.content;
        count += result.count;
      }
      applied.push({ path: group.path, target: group.target, newContent: content, count });
    }

    for (const item of applied) {
      await atomicWriteFile(item.target, item.newContent);
      opts.touchedFiles?.add(item.path);
    }
    const fileCount = applied.length;
    const editCount = edits.length;
    return `Patched ${fileCount} file${fileCount !== 1 ? "s" : ""} (${editCount} edit${editCount !== 1 ? "s" : ""}):\n${applied.map((a) => `  ${a.path} (${a.count} replacement${a.count !== 1 ? "s" : ""})`).join("\n")}`;
  }

  if (name === "cache_set") {
    if (!opts.sessionCache) opts.sessionCache = {};
    opts.sessionCache[String(args.key)] = String(args.value);
    return `Cached key: ${args.key}`;
  }

  if (name === "cache_get") {
    const val = opts.sessionCache?.[String(args.key)];
    return val !== undefined ? val : "null";
  }

  if (name === "glob") {
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    const max = Math.min(Number(args.max) || 100, 1000);
    const workspaceRoot = resolve(process.cwd());
    const globRx = globToRegex(pattern);
    const results = [];
    for await (const item of walkDir(workspaceRoot, workspaceRoot, { excludeDirNames: DEFAULT_TRAVERSE_EXCLUDES })) {
      if (globRx.test(item.relPath)) {
        results.push(item.relPath);
        if (results.length >= max) break;
      }
    }
    return results.join("\n") || "(no matches)";
  }

  if (name === "path_exists") {
    const target = assertInsideWorkspace(args.path);
    try {
      const info = await stat(target);
      return JSON.stringify({ exists: true, type: info.isDirectory() ? "dir" : "file" });
    } catch {
      return JSON.stringify({ exists: false });
    }
  }

  if (name === "is_text_file") {
    const target = assertInsideWorkspace(args.path);
    try {
      const info = await stat(target);
      if (!info.isFile()) return JSON.stringify({ is_text: false, reason: "not a file" });
      const binary = await isBinaryFile(target);
      return JSON.stringify({ is_text: !binary });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  if (name === "get_related_files") {
    const target = assertInsideWorkspace(args.path);
    const text = await readFile(target, "utf8");
    const importPatterns = [
      /import\s+(?:[\w*{},\s]+from\s+)?['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /#include\s+[<"]([^>"]+)[>"]/g,
      /from\s+['"]([^'"]+)['"]/g
    ];
    const refs = new Set();
    for (const pattern of importPatterns) {
      for (const match of text.matchAll(pattern)) refs.add(match[1]);
    }
    return [...refs].join("\n") || "(no imports found)";
  }

  if (name === "tree") {
    const target = assertInsideWorkspace(args.path || ".");
    const maxDepth = Math.min(Number(args.max_depth) || 3, 8);
    const relLabel = relative(process.cwd(), target).replace(/\\/g, "/") || ".";
    const lines = [`${relLabel}/`];
    const sub = await buildTreeLines(target, "", 0, maxDepth);
    lines.push(...sub);
    return lines.join("\n");
  }

  if (name.startsWith("sec_")) {
    const target = args.url || args.domain || args.host || "";
    if (target) await requireScope(process.cwd(), taskKey, target, args.vulnerability_class);
    return runSecurityTool(name, args, { ...opts, askYesNo });
  }

  if (name.startsWith("atk_")) {
    const target = args.url || args.jwt || "";
    if (target && !args.jwt) await requireScope(process.cwd(), taskKey, target, args.vulnerability_class);
    return runOffensiveTool(name, args, { ...opts, askYesNo });
  }

  if (name.startsWith("re_")) {
    for (const key of ["path", "before", "after"]) {
      if (args[key]) assertInsideWorkspace(args[key]);
    }
    return runReTool(name, args, { ...opts, askYesNo }, { cwd: process.cwd(), taskId: taskKey });
  }

  if (name.startsWith("sys_") || name === "re_frida") {
    if (args.path) assertInsideWorkspace(args.path);
    return runRuntimeTool(name, args, { ...opts, askYesNo }, { cwd: process.cwd(), taskId: taskKey });
  }

  if (name === "net_mitm") {
    if (args.url) await requireScope(process.cwd(), taskKey, args.url, args.vulnerability_class);
    return runRuntimeTool(name, args, { ...opts, askYesNo }, { cwd: process.cwd(), taskId: taskKey });
  }

  if (name.startsWith("fz_")) {
    for (const key of ["source", "seed_file", "seeds_dir", "crash", "crashes_dir"]) {
      if (args[key]) assertInsideWorkspace(args[key]);
    }
    return runFuzzTool(name, args, { ...opts, askYesNo }, { cwd: process.cwd(), taskId: taskKey });
  }

  if (name.startsWith("docker_") && name !== "docker_cleanup") {
    return runDockerTool(name, args, { ...opts, askYesNo });
  }

  if (name.startsWith("h1_") || name.startsWith("bounty_") || name === "docker_cleanup") {
    return runBountyTool(name, args, { ...opts, askYesNo }, { cwd: process.cwd(), taskId: taskKey });
  }

  throw new Error(`Unknown tool: ${name}`);
}

function mergeToolDelta(toolCalls, deltas) {
  for (const delta of deltas || []) {
    const index = delta.index ?? toolCalls.length;
    toolCalls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
    if (delta.id) toolCalls[index].id += delta.id;
    if (delta.type) toolCalls[index].type = delta.type;
    if (delta.function?.name) toolCalls[index].function.name += delta.function.name;
    if (delta.function?.arguments) toolCalls[index].function.arguments += delta.function.arguments;
  }
}

async function executeToolCall(opts, call) {
  const name = call.function?.name || "(unknown)";
  const rawArgs = call.function?.arguments || "{}";
  let args = {};
  let result;

  try {
    args = JSON.parse(rawArgs || "{}");
    result = await runTool(opts, name, args);
  } catch (error) {
    result = `Tool error: ${error.message}`;
  }

  return { call, name, rawArgs, args, result };
}

function shouldRunToolsSequentially(opts, calls) {
  if (opts.toolMode === "sequential") return true;
  if (calls.some((call) => call.function?.name === "agent_wait")) return true;
  if (opts.dangerouslyAutoRunCommands) return false;
  return calls.some((call) => ["run_cmd", "run_bash", "run_powershell", "functions_shell_command", "functions.shell_command"].includes(call.function?.name));
}

function repairToolCallHistory(messages) {
  const repaired = [];
  let repairs = 0;

  for (let i = 0; i < (messages || []).length; i += 1) {
    const message = messages[i];
    if (message.role === "tool") {
      repairs += 1;
      continue;
    }

    repaired.push(message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (message.role !== "assistant" || calls.length === 0) continue;

    const missing = new Map();
    calls.forEach((call, index) => {
      const id = call.id || `missing_tool_call_${index}`;
      missing.set(id, call.function?.name || "tool");
    });

    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const toolMessage = messages[j];
      if (missing.has(toolMessage.tool_call_id)) {
        repaired.push(toolMessage);
        missing.delete(toolMessage.tool_call_id);
      } else {
        repairs += 1;
      }
      j += 1;
    }

    for (const [toolCallId, toolName] of missing) {
      repaired.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: `Tool result unavailable: previous session ended before ${toolName} completed.`
      });
      repairs += 1;
    }

    i = j - 1;
  }

  return { messages: repaired, repairs };
}

function installStreamInterruptHandler(opts, controller) {
  if (opts.ui) {
    opts.ui.interrupt = () => { opts.interrupted = true; controller.abort(); };
    return () => { opts.ui.interrupt = null; };
  }
  if (!opts.interactiveChat || !process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return () => {};
  }

  const stdin = process.stdin;
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    if (text === "\u001b" || text === "\u0003") {
      opts.interrupted = true;
      if (!opts.noOutput) process.stderr.write("\n[interrupted]\n");
      controller.abort();
    }
  };

  stdin.resume();
  stdin.setRawMode(true);
  stdin.on("data", onData);

  return () => {
    stdin.off("data", onData);
    try { stdin.setRawMode(false); } catch {}
    stdin.resume();
  };
}

/**
 * Reports what one turn cost, and how much of it the provider had cached.
 *
 * Caching on DeepSeek and Z.ai is implicit: the provider matches a repeated
 * prefix by itself, bills those tokens at roughly a fifth of the fresh rate,
 * and says nothing unless asked. Without this line a run's cache-hit rate is
 * unknowable, which makes "is this model worth it" unanswerable.
 *
 * The two providers name the field differently -- DeepSeek reports
 * `prompt_cache_hit_tokens` at the top level, Z.ai reports
 * `prompt_tokens_details.cached_tokens` -- so both are read and whichever is
 * present wins. A provider that reports neither shows a hit rate of zero
 * rather than a wrong number.
 *
 * Contained: this is a diagnostic on the hot path of every turn, and a
 * malformed usage block must not end a run that otherwise succeeded.
 */
function reportTokenUsage(opts, usage) {
  try {
    if (!usage || opts.noOutput) return;
    const prompt = Number(usage.prompt_tokens) || 0;
    const completion = Number(usage.completion_tokens) || 0;
    const cached = Number(
      usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    ) || 0;
    if (!prompt && !completion) return;
    const written = usage.prompt_tokens_details?.cache_write_tokens || 0;
    const share = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;
    if (opts.ui) { opts.ui.usage = { prompt, completion, cached, written, share }; opts.ui.schedule(); return; }
    process.stderr.write(dim(opts, `  tokens in=${prompt} cached=${cached} (${share}%) cache_written=${written} out=${completion}\n`));
  } catch {
    // A diagnostic that throws is worse than one that is missing.
  }
}

async function streamChat(opts, messages, toolsEnabled = opts.tools) {
  let apiKey = await getProviderApiKey(opts.provider);
  let provider = providerConfig(opts.provider);
  if (!apiKey) throw new Error(`No ${provider.label} API key found. Run: switchyard config set-${opts.provider === "deepseek" ? "" : `${opts.provider}-`}key <key>`);

  // One attempt per iteration. Transient failures (network blips, per-attempt
  // timeouts, HTTP 429/5xx) retry with exponential backoff instead of taking
  // the CLI down; user interrupts (Esc/Ctrl+C) end the turn with an
  // interrupted marker. --retry-attempts 0 (default) keeps retrying forever.
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeout);
    const cleanupInterrupt = installStreamInterruptHandler(opts, controller);
    const toolCalls = [];
    let usage = null;
    let providerState;
    let content = "";
    let reasoningContent = "";
    let finishReason = "";
    let phase = "";
    let status = createStatusLine(opts, randomStatusPhrase());
    const reasoningWriter = opts.ui ? opts.ui.writer("reasoning") : createMarkdownWriter(opts, (text) => dim(opts, text), { status });
    const contentWriter = opts.ui ? opts.ui.writer("assistant") : createMarkdownWriter(opts, (text) => applyKnownFileLinks(opts, text, opts.touchedFiles || []), { status });
    const ensureToolStatus = () => {
      if (status.isActive()) return status;
      status = createStatusLine(opts, "Preparing tools");
      return status;
    };
    try {
      for await (const data of providerStream(opts, messages, {
        apiKey, tools: toolsEnabled ? toolSchemas(opts) : [], signal: controller.signal
      })) {
        if (data.usage) usage = data.usage;
        if (data.providerState) providerState = data.providerState;
        const choice = data.choices?.[0] || {};
        const delta = choice.delta || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;

        if (delta.reasoning_content) {
          status.addTokens(delta.reasoning_content);
          if (phase !== "thinking") {
            heading(opts, "thinking", "thinking");
            phase = "thinking";
          }
          reasoningContent += delta.reasoning_content;
          if (!opts.noOutput) reasoningWriter.write(delta.reasoning_content);
        }

        if (delta.content) {
          status.addTokens(delta.content);
          if (phase !== "final") {
            heading(opts, "final", "final");
            phase = "final";
          }
          content += delta.content;
          if (!opts.noOutput) contentWriter.write(delta.content);
        }

        if (delta.tool_calls) {
          const toolStatus = ensureToolStatus();
          toolStatus.setPhrase("Preparing tools");
          toolStatus.addTokens(JSON.stringify(delta.tool_calls));
          mergeToolDelta(toolCalls, delta.tool_calls);
        }
      }

      reasoningWriter.flush();
      contentWriter.flush();
      status.stop();
      if (!opts.noOutput) process.stdout.write("\n");
      // Some thinking-model streams end at the token limit with an index-only
      // tool delta. It is not callable and must not poison the next turn.
      const validToolCalls = toolCalls.filter((call) => String(call.function?.name || "").trim());
      reportTokenUsage(opts, usage);
      return {
        role: "assistant",
        content,
        ...(providerState ? { providerState } : {}),
        usage,
        reasoning_content: reasoningContent,
        finishReason: finishReason || undefined,
        tool_calls: validToolCalls.length ? validToolCalls : undefined
      };
    } catch (error) {
      status.stop();
      // User interrupt (Esc/Ctrl+C) and aborts that are not the per-attempt
      // timeout end the turn with an interrupted marker instead of retrying.
      const userInterrupt = opts.interrupted || (error?.name === "AbortError" && !timedOut);
      if (userInterrupt) {
        opts.ui?.add("notice", "Interrupted by user");
        if (!opts.noOutput) process.stdout.write("\n");
        return {
          role: "assistant",
          content: content.trim() ? `${content.trim()}\n\n[interrupted by user]` : "[interrupted by user]",
          reasoning_content: reasoningContent,
          interrupted: true
        };
      }
      if (error?.status === 402 && opts.balanceFallbackProvider && !opts.balanceFallbackUsed) {
        const fallbackName = normalizeProvider(opts.balanceFallbackProvider);
        const fallbackKey = fallbackName === opts.provider ? "" : await getProviderApiKey(fallbackName);
        if (fallbackKey) {
          const fallback = providerConfig(fallbackName);
          if (!opts.noOutput) heading(opts, `${provider.label} balance exhausted; switching this agent to ${fallback.label}`, "warn");
          opts.provider = fallbackName;
          opts.model = fallback.model;
          opts.baseUrl = fallback.baseUrl;
          opts.contextLimit = contextLimitFor(fallbackName, opts.model);
          if (opts.sessionObject) {
            await ensureContextCompact(opts, opts.sessionObject);
            messages = opts.sessionObject.messages;
          }
          opts.balanceFallbackUsed = true;
          apiKey = fallbackKey;
          provider = fallback;
          attempt = 0;
          continue;
        }
        const reason = fallbackName === opts.provider ? "is already active" : "is not configured";
        error.message = `${error.message} Balance fallback '${fallbackName}' ${reason}.`;
      }
      const exhausted = Number(opts.retryAttempts) > 0 && attempt >= Number(opts.retryAttempts);
      if (exhausted || !isRetryableFetchError(error)) throw error;
      const delay = retryBackoffMs(opts.retryDelay, opts.retryMaxDelay, attempt);
      if (!opts.noOutput) {
        const reason = error.status ? `HTTP ${error.status}` : (timedOut ? "timed out" : "fetch failed");
        heading(opts, `${reason}; retrying this turn in ${Math.round(delay / 1000)}s (attempt ${attempt})`, "warn");
      }
      await sleep(delay);
    } finally {
      status.stop();
      cleanupInterrupt();
      opts.interrupted = false;
      clearTimeout(timer);
    }
  }
}

async function ensureContextCompact(opts, session) {
  opts.compactToolTokens = estimateTokens(JSON.stringify(opts.tools ? toolSchemas(opts) : []));
  if (session.config) session.config.compactToolTokens = opts.compactToolTokens;
  if (opts.compactMethod === "off") return null;
  let meta;
  if (opts.compactMethod === "detached") {
    try {
      meta = await compactSessionDetached(opts, session);
    } catch (error) {
      if (!opts.noOutput) heading(opts, `detached compaction failed (${error.message}); falling back to deterministic truncation`, "warn");
      meta = await compactSession({ ...opts, compactMethod: "truncate" }, session);
    }
  } else {
    meta = await compactSession(opts, session, {
      onStart: (plan) => {
        if (opts.noOutput) return;
        const budget = plan.messagesBudget || plan.limit;
        const pct = Math.round(((plan.usageScaled || plan.usage) / budget) * 100);
        heading(opts, `context ~${pct}% of ${formatCompactCount(budget)} — compacting (${opts.compactMethod === "truncate" ? "deterministic roll-up" : "summarizing old messages"})…`, "warn");
      }
    });
  }
  if (meta && !opts.noOutput) {
    const budget = meta.messagesBudget || meta.limit;
    const pct = Math.round(((meta.usageScaled || meta.usage) / budget) * 100);
    heading(opts, `context ~${pct}% of ${formatCompactCount(budget)} — auto-compacted (${meta.method}: est ${formatCompactCount(meta.usage)} → ${formatCompactCount(meta.projectedTokens)} tokens, folded ${meta.foldedMessages} messages, kept ${meta.keptTurns} complete turns / ${meta.keptMessages} messages)`, "warn");
  }
  return meta;
}

async function compactAgentSession(opts, args) {
  const target = validateAgentId(args.agent_id);
  const method = String(args.method || "truncate");
  if (!["auto", "truncate"].includes(method)) throw new Error("agent_compact method must be auto or truncate.");

  const liveAgents = await listAgents(opts.coordDir);
  const isLive = liveAgents.some((agent) => agent.agentId === target);
  if (isLive) {
    // Running/parked target: the in-memory session is the source of truth, so
    // ask IT to compact (applied on its next wake/turn; it replies with meta).
    const message = await sendAgentMessage(opts.coordDir, {
      from: opts.agentId,
      to: target,
      type: "compact",
      body: JSON.stringify({ method, requestedBy: opts.agentId }),
      priority: "normal"
    });
    return {
      status: "requested",
      agent: target,
      message_id: message.id,
      note: "Target is live; it will compact on its next wake/turn and reply with the result."
    };
  }

  // Stopped/failed/dead target: compact its session file directly so the next
  // launch resumes compacted. Safe because no live process rewrites the file.
  const recordPath = join(opts.coordDir, "agents", `${target}.json`);
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    throw new Error(`unknown agent '${target}' (no coordination record).`);
  }
  if (!record.session) throw new Error(`agent '${target}' has no session file on record.`);
  const session = JSON.parse(await readFile(record.session, "utf8"));
  const meta = await compactSession(
    { ...session.config, provider: session.provider || session.config?.provider, model: session.model, baseUrl: session.baseUrl, contextLimit: session.config?.contextLimit || contextLimitFor(session.provider || session.config?.provider, session.model), compactMethod: method, compactForce: true, maxTokens: session.config?.maxTokens || 16384 },
    session
  );
  if (meta) {
    const original = await readFile(record.session, "utf8");
    await writeFile(`${record.session}.compact-bak`, original, "utf8");
    await writeSession(record.session, session);
  }
  return { status: meta ? "compacted_file" : "not_needed", agent: target, session: record.session, meta: meta || null };
}

// Coordinator-only swarm growth: spawn or resume an agent in its OWN detached
// PowerShell window (launch.ps1-style) so the current agent keeps working.
/**
 * Models each provider will serve, discovered once per session.
 *
 * Filled at startup and again on resume, so a long-lived agent picks up models
 * released since it began rather than being frozen at whatever existed when it
 * first ran. Never fatal: a provider whose catalog cannot be fetched is stored
 * as null, and every check below treats null as "unknown, allow" so an
 * unreachable models endpoint cannot stop a spawn that would have worked.
 */
const providerModelCatalog = new Map();

async function loadProviderModelCatalog(provider, options = {}) {
  const normalized = normalizeProvider(provider);
  let apiKey = null;
  try {
    apiKey = await getProviderApiKey(normalized);
  } catch {
    apiKey = null;
  }
  const models = await fetchProviderModels(normalized, apiKey, options);
  providerModelCatalog.set(normalized, models);
  return models;
}

function knownModelsFor(provider) {
  return providerModelCatalog.get(normalizeProvider(provider)) ?? null;
}

/**
 * Refuses a model the provider does not list, with the alternatives in hand.
 *
 * A spawn that dies on an unknown model wastes a detached process and a
 * coordination record, and the failure surfaces minutes later as a dead agent
 * rather than as a rejected tool call.
 */
async function assertModelAvailable(provider, model) {
  const normalized = normalizeProvider(provider);
  let models = knownModelsFor(normalized);
  if (models === undefined || models === null) {
    models = await loadProviderModelCatalog(normalized);
  }
  if (!models) return;
  if (!models.includes(model)) {
    throw new Error(`Provider '${normalized}' does not serve model '${model}'. Available: ${models.join(", ")}`);
  }
}

async function listProviderModels(args) {
  const providers = args?.provider
    ? [normalizeProvider(args.provider)]
    : Object.keys(PROVIDERS);
  const out = {};
  for (const provider of providers) {
    let models = knownModelsFor(provider);
    if (models === undefined || models === null) models = await loadProviderModelCatalog(provider);
    out[provider] = models
      ? models.map((model) => ({
          model,
          context_limit: contextLimitFor(provider, model),
          context_limit_known: hasKnownContextLimit(model)
        }))
      : { error: "catalog unavailable — the key may be unset or the models endpoint unreachable" };
  }
  return out;
}

async function spawnSwarmAgent(opts, args, { resume }) {
  if (opts.agentRole !== "coordinator") {
    throw new Error("spawn_agent / resume_agent are coordinator-only. Workers may not spawn agents; message the coordinator to scale the swarm.");
  }
  const agentId = validateAgentId(args.agent_id);
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required.");

  const records = await coordinationAgentRecords(opts);
  const existing = records.find((agent) => agent.agentId === agentId);

  if (resume) {
    if (!existing) throw new Error(`No coordination record for '${agentId}' — use spawn_agent to create it first.`);
    if (existing.live) throw new Error(`Agent '${agentId}' is currently live (PID ${existing.pid}) — cannot resume while running.`);
  } else if (existing) {
    throw new Error(`Agent '${agentId}' already exists (state ${existing.state}) — use resume_agent '${agentId}' to resume it instead.`);
  }

  const role = String(args.role || "worker").toLowerCase();
  if (!["coordinator", "worker"].includes(role)) throw new Error("role must be coordinator or worker.");
  const mission = String(args.mission || "").replace(/'/g, "''");
  // The child's provider is chosen, not inherited. It used to take the
  // coordinator's provider while accepting an independent model, so a GLM model
  // requested by a DeepSeek coordinator was sent to DeepSeek's endpoint and died
  // on "the supported API model names are deepseek-*, but you passed glm-*".
  const provider = normalizeProvider(args.provider || opts.provider);
  const model = String(args.model || (provider === opts.provider ? opts.model : "") || providerConfig(provider).model);
  await assertModelAvailable(provider, model);
  const permission = String(args.permission || "full");
  const coordDir = String(opts.coordDir || coordinationRoot());
  const cwd = String(process.cwd()).replace(/'/g, "''");

  // Spawn the worker as a DETACHED, headless node process. Console windows
  // cannot be created reliably from the wrapper context (a node-spawned
  // powershell/cmd window opens but never executes its command), while a
  // direct node.exe spawn always runs. `detached: true` + `unref()` makes the
  // child fully independent of this agent — the coordinator keeps working.
  const nodeExe = process.execPath;
  const script = fileURLToPath(new URL("./deepseek-watch.js", import.meta.url));
  const workerArgs = [
    script,
    "--agent-id", agentId,
    "--agent-role", role,
    "--coordinator-id", opts.agentId,
    ...(mission ? ["--agent-mission", mission] : []),
    "--provider", provider,
    "--model", model,
    "--coord-dir", coordDir,
    "--permission", permission,
    "--compact-keep-recent", String(opts.compactKeepRecent || 15),
    ...(opts.compactProvider ? ["--compact-provider", opts.compactProvider] : []),
    ...(opts.compactModel ? ["--compact-model", opts.compactModel] : []),
    ...(opts.compactBaseUrl ? ["--compact-base-url", opts.compactBaseUrl] : []),
    "--compact-method", "auto",
    "--compact-at", "0.9",
    // The CHILD's limit, from the child's own provider and model. Passing the
    // coordinator's limit gave a 200K worker a 1M budget when a DeepSeek
    // coordinator spawned a GLM one, so auto-compaction would not have fired
    // until long past the point the model could still answer.
    "--compact-limit", String(contextLimitFor(provider, model)),
    "-p", prompt
  ];
  const child = spawn(nodeExe, workerArgs, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  // The spawn PID is not proof the worker started: verify by polling the
  // coordination record for a fresh heartbeat under the agent id.
  const startedAt = Date.now();
  let registered = null;
  const deadline = startedAt + 25000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(join(coordDir, "agents", `${agentId}.json`), "utf8"));
      const heartbeat = Date.parse(record.heartbeatAt || "");
      if (Number.isFinite(heartbeat) && Date.now() - heartbeat < 20000) {
        registered = { pid: record.pid, state: record.state, instanceId: record.instanceId, session: record.session || null };
        break;
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  return {
    action: resume ? "resumed" : "spawned",
    agent_id: agentId,
    role,
    spawn_pid: child.pid || null,
    registered: registered ? { pid: registered.pid, state: registered.state, session: registered.session } : null,
    registered_after_seconds: registered ? Math.round((Date.now() - startedAt) / 1000) : null,
    coord_dir: coordDir,
    cwd,
    note: registered
      ? `Worker registered (PID ${registered.pid}, ${registered.state}). Runs headless/detached — verify with agent_list; message or wake it by id. For tiled windows, use launch.ps1 from a terminal instead.`
      : "No heartbeat seen within 25s — check for startup errors (API key, model, session file)."
  };
}

function selfLaunchArgs(args) {
  // Source checkout: node src/deepseek-watch.js <args>.
  // SEA executable: dsw.exe <args> (there is no script argument to repeat).
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  return entry.endsWith("deepseek-watch.js") ? [entry, ...args] : args;
}

async function resumeAgentAfterMessage(opts, agentId) {
  const records = await coordinationAgentRecords(opts);
  const existing = records.find((agent) => agent.agentId === agentId);
  if (!existing || existing.live || !existing.session) return null;

  let session;
  try {
    session = JSON.parse(await readFile(existing.session, "utf8"));
  } catch (error) {
    throw new Error(`Cannot auto-resume agent '${agentId}': ${error.message}`);
  }
  const config = session.config || {};
  const workerArgs = [
    "--resume",
    "--session", existing.session,
    "--agent-id", agentId,
    "--agent-role", existing.role || config.agentRole || "worker",
    "--coord-dir", existing.coordinationRoot || opts.coordDir,
    "--permission", config.permission || "full",
    "-p", "Resume after receiving a coordination message. Inspect the inbox and continue the current mission."
  ];
  const coordinatorId = config.coordinatorId || existing.coordinatorId;
  if (coordinatorId) workerArgs.push("--coordinator-id", coordinatorId);
  if (existing.mission) workerArgs.push("--agent-mission", existing.mission);

  const child = spawn(process.execPath, selfLaunchArgs(workerArgs), {
    cwd: existing.workspace || process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return { resumed: true, pid: child.pid || null };
}

async function processAgentTurns(opts, session) {
  let emptyRecoveryAttempts = 0;
  for (let turn = 0; opts.maxToolTurns === null || turn <= opts.maxToolTurns; turn += 1) {
    const compacted = await ensureContextCompact(opts, session);
    if (compacted && opts.saveSession) await writeSession(opts.session, touchSession(session));
    const response = await streamChat(opts, session.messages);
    session.provider = opts.provider;
    session.model = opts.model;
    session.baseUrl = opts.baseUrl;
    session.config.provider = opts.provider;
    const { finishReason, ...assistant } = response;
    session.messages.push(assistant);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));

    if (assistant.interrupted) return;
    if (!assistant.tool_calls?.length) {
      const hasUsableContent = Boolean(String(assistant.content || "").trim());
      const exhaustedThinking = Boolean(String(assistant.reasoning_content || "").trim()) && !hasUsableContent;
      if (exhaustedThinking && emptyRecoveryAttempts < 2) {
        emptyRecoveryAttempts += 1;
        const previousLimit = opts.maxTokens;
        opts.maxTokens = Math.min(Math.max(previousLimit * 2, 16384), 32768);
        session.messages.push({
          role: "user",
          content: "Your prior turn used its response budget before producing a usable answer or tool call. Continue the current task now. Be concise and issue the next required tool call immediately; do not repeat prior analysis."
        });
        if (opts.saveSession) await writeSession(opts.session, touchSession(session));
        if (!opts.noOutput) heading(opts, `retrying after empty ${finishReason || "model"} response with ${opts.maxTokens} tokens`, "warn");
        continue;
      }
      return;
    }
    emptyRecoveryAttempts = 0;
    heading(opts, "tool calls", "tools");

    const toolTracker = new ToolCallTracker(opts);
    const sequential = shouldRunToolsSequentially(opts, assistant.tool_calls);
    const trackerIds = new Map();
    for (const call of assistant.tool_calls) trackerIds.set(call.id, toolTracker.addCall(call));

    const isToolError = (result) => String(result || "").startsWith("Tool error:");
    let executions = [];
    if (!sequential) {
      const status = createStatusLine(opts, "Running tools", assistant.tool_calls.reduce((sum, call) => sum + estimateTokens(call.function?.arguments || ""), 0));
      try {
        executions = await Promise.all(assistant.tool_calls.map(async (call) => {
          const startedAt = Date.now();
          const execution = await executeToolCall(opts, call);
          execution.durationMs = Date.now() - startedAt;
          opts.ui?.finishTool(call.id, toolDisplayResult(execution.name, execution.args, execution.result), execution.durationMs, isToolError(execution.result));
          return execution;
        }));
      } finally {
        status.stop();
      }
    }

    for (const call of assistant.tool_calls) {
      let execution;
      if (sequential) {
        const status = createStatusLine(opts, toolStatusPhrase(call.function?.name || "tool"), estimateTokens(call.function?.arguments || ""));
        const startedAt = Date.now();
        try {
          execution = await executeToolCall(opts, call);
        } finally {
          status.stop();
        }
        execution.durationMs = Date.now() - startedAt;
      } else {
        execution = executions.shift();
      }
      if (sequential) opts.ui?.finishTool(call.id, toolDisplayResult(execution.name, execution.args, execution.result), execution.durationMs, isToolError(execution.result));
      toolTracker.complete(trackerIds.get(call.id), execution.durationMs, isToolError(execution.result));
      writeToolResult(opts, toolDisplayResult(execution.name, execution.args, execution.result), collectPathLikeValues(execution.args));
      session.messages.push({ role: "tool", tool_call_id: execution.call.id, content: String(execution.result) });
      session.touchedFiles = [...(opts.touchedFiles || [])];
      session.cache = { ...(opts.sessionCache || {}) };
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    }
    if (opts.ui?.stopRequested) { opts.ui.stopRequested = false; opts.ui.add("notice", "Stopped after completing current tool batch"); return; }
    if (opts.agentWaitRequest) return;
    await deliverPendingAgentMessages(opts, session);
  }

  // A deliberate tool budget should still leave a valid handoff/result file.
  // Make one tools-disabled completion request instead of throwing away all
  // completed work and skipping maybeWriteOutput().
  const finalizerOpts = { ...opts, thinking: "disabled", maxTokens: Math.max(2048, Math.min(opts.maxTokens, 8192)) };
  const finalCompacted = await ensureContextCompact(opts, session);
  if (finalCompacted && opts.saveSession) await writeSession(opts.session, touchSession(session));
  session.messages.push({
    role: "user",
    content: `The configured tool-call budget (${opts.maxToolTurns}) has been reached. Do not call tools. Give the required final response now: summarize completed work, files touched, checks/evidence, and what remains unfinished because of the budget.`
  });
  const response = await streamChat(finalizerOpts, session.messages, false);
  const { finishReason, ...assistant } = response;
  session.messages.push(assistant);
  session.tool_turn_limit = {
    reached: true,
    limit: opts.maxToolTurns,
    finalized_at: nowIso(),
    finish_reason: finishReason || null
  };
  if (opts.saveSession) await writeSession(opts.session, touchSession(session));
  if (!opts.noOutput) heading(opts, `tool budget reached (${opts.maxToolTurns}); wrote final response without tools`, "warn");
}

async function deliverPendingAgentMessages(opts, session, messages = null) {
  const pending = messages || await readAgentInbox(opts.coordDir, opts.agentId);
  if (!pending.length) return false;
  const deliveredIds = new Set(Array.isArray(session.agentMessageIds) ? session.agentMessageIds : []);
  const fresh = pending.filter((message) => !deliveredIds.has(message.id));
  const compactRequests = fresh.filter((message) => message.type === "compact");
  const llmMessages = fresh.filter((message) => message.type !== "compact");

  if (compactRequests.length) {
    for (const request of compactRequests) {
      let body = {};
      try { body = JSON.parse(request.body || "{}"); } catch { body = {}; }
      const method = body.method === "auto" ? "auto" : "truncate";
      let meta = null;
      try {
        meta = await compactSession({ ...opts, compactMethod: method, compactForce: true }, session);
        if (meta && opts.saveSession) await writeSession(opts.session, touchSession(session));
      } catch (error) {
        meta = { error: error.message };
      }
      try {
        await sendAgentMessage(opts.coordDir, {
          from: opts.agentId,
          to: request.from,
          type: "status",
          body: JSON.stringify({ compacted: Boolean(meta && !meta.error), meta, requestedBy: body.requestedBy || null })
        });
      } catch { /* a failed status reply must not break the turn */ }
    }
    if (!opts.noOutput) heading(opts, `handled ${compactRequests.length} inbox compaction request(s)`, "session");
  }

  if (llmMessages.length) {
    const parts = [`Messages delivered to agent ${opts.agentId} from the shared coordination inbox:`, ""];
    if (compactRequests.length) {
      parts.push(`Note: ${compactRequests.length} inbox compaction request(s) were handled automatically and are NOT listed below.`, "");
    }
    parts.push(formatAgentMessages(llmMessages), "", "Respond or act according to your current mission. Use agent_send for replies and agent_wait if you are ready to park again.");
    session.messages.push({ role: "user", content: parts.join("\n") });
    session.agentMessageIds = [...deliveredIds, ...fresh.map((message) => message.id)].slice(-5000);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
  } else if (compactRequests.length) {
    // Woken only to compact: give the agent a short prompt so the wake is useful.
    session.messages.push({
      role: "user",
      content: "Session compacted automatically per an inbox request. Report the compaction result to the requester if relevant, then continue your mission or park again."
    });
    session.agentMessageIds = [...deliveredIds, ...fresh.map((message) => message.id)].slice(-5000);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
  }
  await acknowledgeAgentMessages(opts.coordDir, opts.agentId, pending);
  return fresh.length > 0;
}

// While an agent is parked, let the operator type a wake message straight at
// the terminal: the text is queued to the agent's own coordination inbox and
// the wait poll delivers it, waking the session. No-op for headless/spawned
// agents (no TTY) or when output is suppressed.
function installParkedInputHandler(opts, agentId, onAbort) {
  if (opts.ui) {
    opts.ui.interrupt = onAbort;
    opts.ui.onSubmit = text => {
      void sendAgentMessage(opts.coordDir, { from: "operator", to: agentId, body: text, type: "message" })
        .then(() => opts.ui.add("user", text)).catch(error => opts.ui.add("error", error.message));
    };
    for (const text of opts.ui.queue.splice(0)) opts.ui.onSubmit(text);
    return () => { opts.ui.onSubmit = null; opts.ui.interrupt = null; };
  }
  if (!opts.interactiveChat || !process.stdin.isTTY || typeof process.stdin.setRawMode !== "function" || opts.noOutput) {
    return () => {};
  }
  const stdin = process.stdin;
  let buffer = "";
  stdin.resume();
  stdin.setRawMode(true);
  const prompt = () => {
    if (!opts.noOutput) process.stdout.write(`  ${dim(opts, "[parked] type a wake message + Enter> ")}`);
  };
  prompt();
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    for (const ch of text) {
      if (ch === "\u0003") { // Ctrl+C: abort the wait (matches "Ctrl+C to exit")
        buffer = "";
        if (typeof onAbort === "function") onAbort();
        return;
      }
      if (ch === "\r" || ch === "\n") {
        const line = buffer.trim();
        buffer = "";
        if (line) {
          void sendAgentMessage(opts.coordDir, { from: "operator", to: agentId, body: line, type: "message" })
            .then(() => { if (!opts.noOutput) process.stdout.write(`  ${green(opts, "✓ wake message queued - agent will resume")}\n`); })
            .catch((error) => { if (!opts.noOutput) process.stdout.write(`  ${red(opts, `✗ ${error.message}`)}\n`); });
        } else if (!opts.noOutput) {
          process.stdout.write("\n");
        }
        prompt();
        return;
      }
      if (ch === "\u007f" || ch === "\b") { // backspace
        if (buffer.length) {
          buffer = buffer.slice(0, -1);
          if (!opts.noOutput) process.stdout.write("\b \b");
        }
        continue;
      }
      if (ch >= " " && ch !== "\u001b") { // printable chars (Esc and arrows ignored)
        buffer += ch;
        if (!opts.noOutput) process.stdout.write(ch);
      }
    }
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    try { stdin.setRawMode(false); } catch {}
    stdin.resume();
  };
}

async function waitForCoordinatedMessage(opts, session, request) {
  await activeAgentRuntime(opts).setState("waiting_for_message", {
    waitReason: request.reason,
    waitStartedAt: nowIso(),
    waitTimeoutMs: request.timeoutMs || 0
  });
  if (!opts.noOutput) heading(opts, `agent ${opts.agentId} parked: ${request.reason}`, "session");
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Agent wait interrupted."));
  process.once("SIGINT", interrupt);
  const cleanupInput = installParkedInputHandler(opts, opts.agentId, interrupt);
  try {
    const result = await waitForAgentMessages(opts.coordDir, opts.agentId, {
      timeoutMs: request.timeoutMs,
      pollMs: 500,
      signal: controller.signal
    });
    if (result.timedOut) {
      session.messages.push({
        role: "user",
        content: `<agent_wait_timeout agent=${JSON.stringify(opts.agentId)} waited_ms=${JSON.stringify(request.timeoutMs)}>\nNo agent message arrived before the requested wait timeout. Reassess your mission, report status if useful, and either continue or call agent_wait again.\n</agent_wait_timeout>`
      });
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    } else {
      await deliverPendingAgentMessages(opts, session, result.messages);
    }
  } finally {
    cleanupInput();
    process.removeListener("SIGINT", interrupt);
    await activeAgentRuntime(opts).setState("working", {
      waitReason: null,
      waitStartedAt: null,
      waitTimeoutMs: 0
    });
  }
}

async function runCoordinatedAgent(opts, session) {
  await activeAgentRuntime(opts).setState("working");
  while (true) {
    await deliverPendingAgentMessages(opts, session);
    opts.agentWaitRequest = null;
    await processAgentTurns(opts, session);
    if (opts.agentWaitRequest) {
      await waitForCoordinatedMessage(opts, session, opts.agentWaitRequest);
      continue;
    }
    if (await deliverPendingAgentMessages(opts, session)) continue;
    return;
  }
}

function isExitCommand(text) {
  return ["/exit", "/quit", "/end", "exit", "quit"].includes(text.trim().toLowerCase());
}

function parseUiArgs(argv) {
  const opts = {
    port: Number.parseInt(process.env.DEEPSEEK_UI_PORT || "17891", 10),
    cdpPort: Number.parseInt(process.env.DEEPSEEK_UI_CDP_PORT || "9223", 10)
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--ui-port") opts.port = Number.parseInt(next(), 10);
    else if (arg === "--ui-cdp-port" || arg === "--cdp-port") opts.cdpPort = Number.parseInt(next(), 10);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`Unknown UI argument: ${arg}`);
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error("--ui-port must be a positive number.");
  if (!Number.isFinite(opts.cdpPort) || opts.cdpPort <= 0) throw new Error("--ui-cdp-port must be a positive number.");
  return opts;
}

function electronCommand() {
  const cmd = process.platform === "win32" ? "electron.cmd" : "electron";
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const local = resolve(process.cwd(), "node_modules", ".bin", cmd);
  const repoLocal = resolve(UI_APP_DIR, "..", "..", "node_modules", ".bin", cmd);
  const localExe = resolve(process.cwd(), "node_modules", "electron", "dist", exe);
  const repoLocalExe = resolve(UI_APP_DIR, "..", "..", "node_modules", "electron", "dist", exe);
  for (const candidate of [repoLocalExe, localExe, repoLocal, local]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0) return candidate;
  }
  const pathResult = spawnSync(cmd, ["--version"], { encoding: "utf8", windowsHide: true });
  if (pathResult.status === 0) return cmd;
  throw new Error("Electron was not found. Run `npm install` in the deepseek-detached-agent repo, then retry `d -ui`.");
}

function cliLaunchEnv() {
  const script = process.argv[1] && process.argv[1].endsWith("deepseek-watch.js") ? resolve(process.argv[1]) : "";
  return {
    DEEPSEEK_UI_CLI_EXE: process.execPath,
    DEEPSEEK_UI_CLI_SCRIPT: script,
    DEEPSEEK_UI_WORKSPACE: process.cwd()
  };
}

function launchElectronUi(argv) {
  const opts = parseUiArgs(argv);
  if (opts.help) {
    process.stdout.write("Usage: switchyard -ui [--ui-port 17891] [--ui-cdp-port 9223]\n");
    return;
  }
  const electron = electronCommand();
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    UI_APP_DIR
  ];
  const env = {
    ...process.env,
    ...cliLaunchEnv(),
    DEEPSEEK_UI_PORT: String(opts.port),
    DEEPSEEK_UI_CDP_PORT: String(opts.cdpPort)
  };
  const child = spawn(electron, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: false
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

function parseCoordinationCommandArgs(argv) {
  const opts = { coordDir: null, from: "operator", all: false, json: false, interactive: false, type: null, taskId: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--coord-dir") opts.coordDir = next();
    else if (arg === "--from") opts.from = next();
    else if (arg === "--type") opts.type = next();
    else if (arg === "--task" || arg === "--task-id") opts.taskId = next();
    else if (arg === "--all") opts.all = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "-i" || arg === "--interactive") opts.interactive = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown coordination option: ${arg}`);
    else opts.positional.push(arg);
  }
  opts.coordDir = coordinationRoot(opts.coordDir);
  return opts;
}

function formatAgentRows(agents) {
  if (!agents.length) return "No matching agents registered in this coordination directory.";
  return agents.map((agent) => [
    agent.agentId,
    `[${agent.live ? "live" : agent.state || "unknown"}]`,
    `pid=${agent.pid}`,
    `role=${agent.role || "worker"}`,
    `workspace=${agent.workspace}`,
    `mission=${agent.mission || "(not assigned)"}`
  ].join("  ")).join("\n");
}

async function agentPanel(opts) {
  if (!process.stdin.isTTY) {
    process.stdout.write("Interactive agent panel requires a TTY. Use `d agents` for a plain listing, or `d message <agent-id> <text>` to send.\n");
    return;
  }
  // Register the terminal as the "cli" operator agent so agents can reply to
  // the panel (replies land in inbox/cli). Tolerates an already-active record
  // (another terminal panel attached to the same board).
  const FROM = "cli";
  let runtime = null;
  try {
    runtime = await createAgentRuntime(opts.coordDir, {
      agentId: FROM,
      role: "operator",
      state: "working",
      mission: "Terminal agent panel - messages sent here wake parked agents; replies land in this inbox.",
      workspace: process.cwd(),
      heartbeatMs: 30000
    });
  } catch (error) {
    if (!String(error && error.message).includes("already active")) throw error;
  }
  try {
    for (;;) {
      const agents = await listAgents(opts.coordDir, { includeStopped: true });
      const visible = agents.filter((agent) => agent.agentId !== FROM);
      process.stdout.write(`\n  ${bold(opts, "Agents")}  ${dim(opts, opts.coordDir)}\n`);
      if (!visible.length) {
        process.stdout.write(`  ${dim(opts, "No agents registered in this coordination directory.")}\n`);
        const wait = (await promptLine("  q to quit: ")).trim().toLowerCase();
        if (wait === "q" || wait === "") break;
        continue;
      }
      visible.forEach((agent, i) => {
        const badge = !agent.live
          ? red(opts, "stopped")
          : agent.state === "waiting_for_message"
            ? yellow(opts, "parked")
            : green(opts, agent.state || "working");
        const mission = String(agent.mission || "").replace(/\s+/g, " ").slice(0, 52);
        process.stdout.write(`  ${dim(opts, `${String(i + 1).padStart(2, " ")}.`)} ${agent.agentId} ${badge}${mission ? ` ${dim(opts, mission)}` : ""}\n`);
      });
      process.stdout.write(`  ${dim(opts, "Number = message agent (wakes parked) · r = replies · q = quit")}\n`);
      const choice = (await promptLine("  > ")).trim().toLowerCase();
      if (choice === "" || choice === "q") break;
      if (choice === "r") {
        const replies = (await readAgentInbox(opts.coordDir, FROM)).filter((message) => message.from && message.from !== FROM);
        process.stdout.write(`\n  ${bold(opts, `Replies from agents (${replies.length})`)}\n`);
        if (!replies.length) process.stdout.write(`  ${dim(opts, "No replies yet.")}\n`);
        for (const reply of replies.slice(-5)) {
          process.stdout.write(`  ${dim(opts, reply.from)} ${reply.createdAt ? new Date(reply.createdAt).toLocaleTimeString() : ""}: ${String(reply.body).slice(0, 130)}\n`);
        }
        continue;
      }
      const n = Number.parseInt(choice, 10);
      const agent = visible[n - 1];
      if (!agent) {
        process.stdout.write(`  ${red(opts, "Invalid choice.")}\n`);
        continue;
      }
      const body = (await promptLine(`  Message to ${agent.agentId}> `)).trim();
      if (!body) continue;
      const message = await sendAgentMessage(opts.coordDir, { from: FROM, to: agent.agentId, body, type: "message" });
      process.stdout.write(`  ${green(opts, "✓ sent")} ${message.id.slice(0, 8)} -> ${agent.agentId}${agent.state === "waiting_for_message" ? ` ${yellow(opts, "(parked — wakes on next poll)")}` : ""}\n`);
    }
  } finally {
    try { if (runtime) await runtime.stop("stopped"); } catch { /* best effort */ }
  }
}

async function runCoordinationCommand(command, argv) {
  const opts = parseCoordinationCommandArgs(argv);
  if (command === "agents") {
    if (opts.interactive) {
      await agentPanel(opts);
      return;
    }
    const agents = await listAgents(opts.coordDir, { includeStopped: opts.all });
    process.stdout.write(`${opts.json ? JSON.stringify(agents, null, 2) : formatAgentRows(agents)}\n`);
    return;
  }
  if (command === "message" || command === "wake") {
    const [to, ...bodyParts] = opts.positional;
    if (!to) throw new Error(`Usage: switchyard ${command} <agent-id> ${command === "message" ? "<message>" : "[message]"} [--from <agent-id>] [--coord-dir <dir>]`);
    const body = bodyParts.join(" ").trim() || "Wake up, inspect your coordination inbox and current mission, then continue safely.";
    const message = await sendAgentMessage(opts.coordDir, {
      from: opts.from,
      to,
      body,
      type: command === "wake" ? "wake" : (opts.type || "message"),
      taskId: opts.taskId
    });
    const resumed = await resumeAgentAfterMessage(opts, to);
    process.stdout.write(`Queued ${message.type} ${message.id} from ${message.from} to ${message.to}.\n`);
    if (resumed) process.stdout.write(`Auto-resumed ${to} (PID ${resumed.pid || "starting"}).\n`);
    return;
  }
  if (command === "inbox") {
    const [agentId] = opts.positional;
    if (!agentId) throw new Error("Usage: switchyard inbox <agent-id> [--coord-dir <dir>]");
    const messages = await readAgentInbox(opts.coordDir, agentId);
    process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
    return;
  }
  if (command === "tasks") {
    process.stdout.write(`${JSON.stringify(await listTasks(opts.coordDir), null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown coordination command: ${command}`);
}

async function handleApiSlash(opts, session, text) {
  const command = parseSlash(text); if (!command) return false;
  const notice = message => opts.ui ? opts.ui.add("notice", message) : process.stdout.write(`${message}\n`);
  const ask = question => opts.ui ? opts.ui.ask(question) : promptLine(`${question}> `);
  const choose = async (title, hint, items) => {
    if (opts.ui) return opts.ui.select(title, hint, items);
    const result = await pickMenu(opts, title, hint, items); return result === "quit" ? null : result;
  };
  try {
    if (["help", "commands"].includes(command.name)) notice(SLASH_HELP);
    else if (command.name === "session") notice(`API · ${opts.provider} / ${opts.model}\n${sessionPath(opts.session)}`);
    else if (command.name === "usage") notice(`Context estimate: ${estimateContextTokens(session.messages).toLocaleString()} tokens\n${opts.ui?.usage ? JSON.stringify(opts.ui.usage) : "No response usage reported yet."}`);
    else if (["model", "provider"].includes(command.name)) {
      let provider = opts.provider;
      if (command.name === "provider") {
        provider = await choose("API provider", "The conversation will be sent to this provider.", CONNECTIONS.filter(c => !["codex", "claude"].includes(c.id)));
        if (!provider) return true;
      }
      if (!await getProviderApiKey(provider)) throw new Error(`Configure the ${provider} API key before switching.`);
      const target = { ...opts, provider, backend: "api", baseUrl: provider === opts.provider ? opts.baseUrl : providerConfig(provider).baseUrl };
      const model = command.name === "model" && command.argument ? command.argument : await chooseModel(target, choose, ask, notice);
      if (!model) return true;
      applyApiModel(opts, session, provider, model, contextLimitFor);
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
      notice(`Using ${provider} / ${model}. Conversation kept.`);
    } else notice(`Unknown command /${command.name}.\n${SLASH_HELP}`);
  } catch (error) { notice(error.message); }
  return true;
}

async function run() {
  const argv = process.argv.slice(2);
  if (["login", "auth"].includes(argv[0])) {
    if (!["codex", "claude"].includes(argv[1])) throw new Error("Usage: switchyard login|auth codex|claude");
    await nativeAuth(argv[1], argv[0] === "login" ? "login" : "status");
    return;
  }
  if (argv[0] === "-ui" || argv[0] === "--ui" || argv[0] === "ui") {
    launchElectronUi(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    process.stdout.write(`${await doctor()}\n`);
    return;
  }
  if (argv[0] === "update") {
    const info = await checkForUpdates({ timeoutMs: 8000 });
    if (info.status === "unknown") { process.stdout.write("Not a git checkout — cannot self-update.\n"); return; }
    if (info.status === "offline") { process.stdout.write("Could not reach origin (offline?). Try again later.\n"); return; }
    if (info.status === "up-to-date") { process.stdout.write(`Already up to date (${info.shortCurrent}).\n`); return; }
    if (info.dirty && argv[1] !== "--force") {
      process.stdout.write(`Update available (${info.shortCurrent} → ${info.shortRemote}) but the checkout has local changes.\nCommit or stash them, then re-run 'switchyard update'.\n`);
      return;
    }
    process.stdout.write(`Updating ${info.shortCurrent} → ${info.shortRemote} (origin/${info.branch})…\n`);
    const res = await performUpdate(info.repoDir, info.branch);
    if (!res.ok) { process.stdout.write(`Update failed (${res.phase}): ${res.message}\n`); process.exitCode = 1; return; }
    await clearSkipped();
    process.stdout.write(`Updated to ${res.newSha.slice(0, 9)}.${info.isSource ? " Restart dsw to load it." : " Rebuild the exe (npm run build:exe) to load it."}\n`);
    return;
  }
  if (argv[0] === "balance") {
    await runBalanceCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "skill") {
    try {
      await runSkillCommand(argv.slice(1));
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (["agents", "message", "wake", "inbox", "tasks"].includes(argv[0])) {
    await runCoordinationCommand(argv[0], argv.slice(1));
    return;
  }

  if (argv[0] === "security") {
    const { allowlistPath, loadAllowlist } = await import("./security_tools.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const command = argv[1];
    const domain = String(argv[2] || "").toLowerCase().trim();
    const list = await loadAllowlist();
    if (command === "allow") {
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        process.stdout.write("Usage: switchyard security allow <domain>  (e.g. switchyard security allow example.com)\n");
        return;
      }
      if (!list.domains.includes(domain)) {
        list.domains.push(domain);
        await mkdir(dirname(allowlistPath()), { recursive: true });
        await writeFile(allowlistPath(), JSON.stringify(list, null, 2), "utf8");
      }
      process.stdout.write(`Allowlisted: ${list.domains.join(", ") || "(none)"}\n`);
      return;
    }
    if (command === "remove") {
      list.domains = list.domains.filter((d) => d !== domain);
      await mkdir(dirname(allowlistPath()), { recursive: true });
      await writeFile(allowlistPath(), JSON.stringify(list, null, 2), "utf8");
      process.stdout.write(`Allowlisted: ${list.domains.join(", ") || "(none)"}\n`);
      return;
    }
    if (command === "list" || !command) {
      process.stdout.write(
        `Security allowlist (${allowlistPath()}):\n${list.domains.length ? list.domains.map((d) => `  - ${d}`).join("\n") : "  (empty — no targets allowed yet)"}\n`
      );
      return;
    }
    process.stdout.write("Usage: switchyard security allow <domain> | switchyard security remove <domain> | switchyard security list\n");
    return;
  }

  if (argv[0] === "config") {
    const command = argv[1];
    if (["set-key", "set-glm-key", "set-anthropic-key", "set-claude-key", "set-openai-key"].includes(command)) {
      const provider = command === "set-key" ? "deepseek" : normalizeProvider(command.slice(4, -4));
      await setProviderApiKey(provider, argv[2] || "");
      process.stdout.write(`Saved ${providerConfig(provider).label} API key to ${configPath()}\n`);
      return;
    }
    if (command === "set-google-search-key") {
      process.stdout.write(`${setUserEnvironmentVariable("GOOGLE_SEARCH_API_KEY", argv[2] || "")}\n`);
      return;
    }
    if (command === "set-google-search-engine-id") {
      process.stdout.write(`${setUserEnvironmentVariable("GOOGLE_SEARCH_ENGINE_ID", argv[2] || "")}\n`);
      return;
    }
    if (command === "path") {
      process.stdout.write(`${configPath()}\n`);
      return;
    }
    throw new Error("Unknown config command. Use: switchyard config set-key <key>, switchyard config set-glm-key <key>, switchyard config set-anthropic-key <key>, switchyard config set-openai-key <key>, switchyard config set-google-search-key <key>, or switchyard config set-google-search-engine-id <engine-id>");
  }

  const opts = argv.length === 0 ? await dashboardOpts() : parseArgs(argv);
  if (opts.quit) return;
  validateOpts(opts);

  // Codex-style "update available" gate before an interactive session begins.
  if (opts.interactiveChat && !opts.quit && !opts.help) {
    await maybePromptUpdate(opts);
    if (opts.quit) return;
  }

  if (opts.interactiveChat && !opts.quit && process.stdout.isTTY) {
    const cwdName = String(process.cwd()).split(/[\\/]/).filter(Boolean).pop() || "workspace";
    setTerminalTitle(`Switchyard · ${cwdName}`);
  }

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (opts.listSkills) {
    process.stdout.write(`${formatSkillList(await discoverSkills(opts))}\n`);
    return;
  }

  let resumedSession = null;
  let autoAgentSession = false;
  if (!opts.session && opts.resume) {
    const picked = await pickSession(opts);
    opts.session = picked.path;
    if (picked.agentId && !opts.agentId) opts.agentId = picked.agentId;
  }
  const nativeSaved = opts.session && opts.resume ? await readSession(opts.session) : null;
  if (!opts.backendExplicit && nativeSaved?.config?.backend) opts.backend = nativeSaved.config.backend;
  if (["codex", "claude"].includes(opts.backend)) {
    await runNativeChat(opts, { prompt: promptLine, confirm: askYesNo, stdin: readStdin });
    return;
  }
  if (nativeSaved?.config?.backend && nativeSaved.config.backend !== "api") throw new Error("This session uses a native backend. Resume without --backend api.");
  // Tie a stable agent id to a single session file: reuse the agent's most
  // recent session instead of scattering one session per launch. Pass --new
  // to start a fresh session for the agent id.
  if (!opts.session && !opts.newSession && opts.agentId) {
    const agentSession = await findSessionForAgent(validateAgentId(opts.agentId));
    if (agentSession) {
      opts.session = agentSession;
      autoAgentSession = true;
    }
  }
  // The coordination record stores the agent's definitive absolute session
  // path — use it when the workspace-relative session list misses (e.g. the
  // shim is run from a different cwd).
  if (!opts.session && !opts.newSession && opts.agentId) {
    try {
      const root = coordinationRoot(opts.coordDir);
      await stat(join(root, "agents"));
      const record = JSON.parse(await readFile(join(root, "agents", `${validateAgentId(opts.agentId)}.json`), "utf8"));
      if (record.session) {
        await stat(record.session);
        opts.session = record.session;
        autoAgentSession = true;
      }
    } catch {}
  }
  if (opts.resume || autoAgentSession) {
    resumedSession = await readSession(opts.session);
    if (!opts.providerExplicit && (resumedSession.config?.provider || resumedSession.provider)) opts.provider = normalizeProvider(resumedSession.config?.provider || resumedSession.provider);
    const switchedProvider = opts.providerExplicit && opts.provider !== (resumedSession.config?.provider || resumedSession.provider);
    if (switchedProvider) {
      if (!opts.modelExplicit) opts.model = providerConfig(opts.provider).model;
      if (!opts.baseUrlExplicit) opts.baseUrl = providerConfig(opts.provider).baseUrl;
    }
    for (const key of ["compactProvider", "compactModel", "compactBaseUrl"]) {
      if (!opts[key] && resumedSession.config?.[key]) opts[key] = resumedSession.config[key];
    }
    if (!opts.compactKeepRecentExplicit && !process.env.DSW_COMPACT_KEEP_RECENT && !process.env.DEEPSEEK_COMPACT_KEEP_RECENT && resumedSession.config?.compactionVersion === 2) {
      opts.compactKeepRecent = resumedSession.config.compactKeepRecent || 15;
    }
    if (!opts.coordinatorId && resumedSession.config?.coordinatorId) opts.coordinatorId = resumedSession.config.coordinatorId;
    if (!switchedProvider && !opts.modelExplicit && resumedSession.model) opts.model = resumedSession.model;
    if (!switchedProvider && !opts.baseUrlExplicit && resumedSession.baseUrl) opts.baseUrl = resumedSession.baseUrl;
    if (!opts.skills.length && Array.isArray(resumedSession.config?.skills)) {
      opts.skills = normalizeList(resumedSession.config.skills);
    }
    if (!opts.skillRoots.length && Array.isArray(resumedSession.config?.skillRoots)) {
      opts.skillRoots = normalizeList(resumedSession.config.skillRoots);
    }
  }

  opts.agentRole = String(opts.agentRole || resumedSession?.config?.agentRole || "worker").trim().toLowerCase() || "worker";
  opts.agentMission = String(opts.agentMission || resumedSession?.config?.agentMission || "").trim();
  opts.agentId = validateAgentId(opts.agentId || resumedSession?.config?.agentId || generateAgentId(opts.agentRole));
  opts.coordDir = coordinationRoot(opts.coordDir || resumedSession?.config?.coordDir);
  if (opts.contextLimit === null) opts.contextLimit = contextLimitFor(opts.provider, opts.model);

  // Discover this provider's models once per session. Runs here rather than
  // lazily so it also happens on resume: a resumed agent is a new process and
  // must see models released since it last ran. Failure is non-fatal by
  // construction -- fetchProviderModels returns null instead of throwing.
  await loadProviderModelCatalog(opts.provider, { baseUrl: opts.baseUrl });
  if (!hasKnownContextLimit(opts.model)) {
    process.stderr.write(
      `[dsw] no context window is recorded for '${opts.model}'; assuming ${opts.contextLimit} tokens. `
      + `Auto-compaction will run earlier than necessary rather than later than safe.
`
    );
  }

  opts.skills = normalizeList(opts.skills);
  opts.skillRoots = normalizeList(opts.skillRoots);

  const systemPrompt = await loadSystemPrompt(opts);
  if (opts.printSystem) {
    process.stdout.write(`${systemPrompt}\n`);
    return;
  }

  const emptyInteractive = opts.interactiveChat && !opts.prompt && !opts.promptFile && !opts.stdin && !opts.tuiQuiet && !opts.noOutput && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb";
  const userPrompt = emptyInteractive ? "" : await loadPrompt(opts);
  if (opts.quit) return;
  if (!opts.session) {
    opts.session = newSessionPath();
  }

  const session = (opts.resume || autoAgentSession)
    ? resumedSession
    : newSession({
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      workspace: process.cwd(),
      systemPrompt,
      userPrompt,
      config: {
        permission: opts.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask"),
        toolMode: opts.toolMode,
        skills: opts.skills,
        skillRoots: opts.skillRoots,
        coordinatorId: opts.coordinatorId
      }
    });

  if (opts.resume || autoAgentSession) {
    updateSystemMessage(session, systemPrompt);
  }

  const repairedHistory = repairToolCallHistory(session.messages);
  if (repairedHistory.repairs > 0) {
    session.messages = repairedHistory.messages;
    if (!opts.noOutput) {
      process.stderr.write(`Repaired ${repairedHistory.repairs} invalid saved tool message${repairedHistory.repairs === 1 ? "" : "s"} before resume.\n`);
    }
  }

  opts.permission = opts.permission || session.config?.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask");
  opts.toolMode = opts.toolMode || session.config?.toolMode || "parallel";
  if (opts.permission === "full") opts.dangerouslyAutoRunCommands = true;
  session.config = {
    ...(session.config || {}),
    provider: opts.provider,
    compactProvider: opts.compactProvider,
    compactModel: opts.compactModel,
    compactBaseUrl: opts.compactBaseUrl,
    compactKeepRecent: opts.compactKeepRecent,
    compactionVersion: 2,
    contextLimit: opts.contextLimit,
    maxTokens: opts.maxTokens,
    permission: opts.permission,
    toolMode: opts.toolMode,
    skills: opts.skills,
    skillRoots: opts.skillRoots,
    agentId: opts.agentId,
    agentRole: opts.agentRole,
    agentMission: opts.agentMission,
    coordDir: opts.coordDir,
    coordinatorId: opts.coordinatorId
  };
  if (session.provider !== opts.provider || session.model !== opts.model) {
    for (const message of session.messages) delete message.providerState;
  }
  session.provider = opts.provider; session.model = opts.model; session.baseUrl = opts.baseUrl;
  opts.touchedFiles = new Set(session.touchedFiles || []);
  opts.sessionCache = { ...(session.cache || {}) };
  opts.sessionObject = session;
  opts.agentRuntime = await createAgentRuntime(opts.coordDir, {
    agentId: opts.agentId,
    role: opts.agentRole,
    mission: opts.agentMission,
    workspace: process.cwd(),
    session: opts.session
  });
  if (opts.scopeFile || opts.allowedTargets.length) {
    let launchScope = { allowed_assets: opts.allowedTargets };
    if (opts.scopeFile) launchScope = JSON.parse(await readFile(resolve(process.cwd(), opts.scopeFile), "utf8"));
    const savedScope = await setScope(process.cwd(), opts.agentId || opts.session, launchScope);
    if (!opts.noOutput) process.stderr.write(`Task scope: ${savedScope.allowed_assets.length} allowed asset${savedScope.allowed_assets.length === 1 ? "" : "s"}\n`);
  }
  if (!opts.noOutput) process.stderr.write(`Agent: ${opts.agentId} (${opts.agentRole})\nCoordination: ${opts.coordDir}\n`);

  if ((opts.resume || autoAgentSession) && userPrompt) {
    session.messages.push({ role: "user", content: userPrompt });
  }

  if (opts.interactiveChat && !opts.noOutput && !opts.tuiQuiet && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb") {
    opts.ui = new TerminalUI(opts).start(session.messages);
    activeTerminalUi = opts.ui;
  }
  try {
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    if (opts.saveSession) writeSessionNotice(opts, sessionPath(opts.session));
    if (userPrompt) await runCoordinatedAgent(opts, session);
    session.touchedFiles = [...opts.touchedFiles];
    session.cache = { ...(opts.sessionCache || {}) };
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    await maybeWriteOutput(opts, session);

    while (opts.interactiveChat) {
      const contextTokens = formatCompactCount(estimateContextTokens(session.messages));
      if (!opts.ui) process.stdout.write(`\n  ${dim(opts, `Enter to send, /exit to quit, Ctrl+C to exit · context ${contextTokens} tokens`)}\n`);
      const nextPrompt = opts.ui ? await opts.ui.nextPrompt() : await promptLine("  > ");
      if (!nextPrompt.trim()) continue;
      if (isExitCommand(nextPrompt)) break;
      if (await handleApiSlash(opts, session, nextPrompt)) continue;
      if (opts.ui) { opts.ui.busy = true; opts.ui.add("user", nextPrompt); }
      session.messages.push({ role: "user", content: nextPrompt });
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
      await runCoordinatedAgent(opts, session);
      session.touchedFiles = [...opts.touchedFiles];
      session.cache = { ...(opts.sessionCache || {}) };
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
      await maybeWriteOutput(opts, session);
    }
    await opts.agentRuntime.stop("completed");
  } catch (error) {
    await opts.agentRuntime.stop("failed", { error: error.message });
    throw error;
  } finally {
    opts.ui?.close();
    if (opts.ui) process.stdin.pause();
    activeTerminalUi = null;
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
