#!/usr/bin/env node
// Self-test: agent id → session file binding in the watch CLI.
//   run 1: --agent-id test-agent-1 creates a session recording the agent id.
//   run 2: same agent id resumes that exact session (prompt appended).
//   run 3: --agent-id test-agent-1 --new starts a fresh session (second file).
// Uses a local mock DeepSeek server so no API key is needed.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSession, writeSession } from "../src/session-memory.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WATCH_CLI = join(REPO, "src", "deepseek-watch.js");

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hello from mock"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");
const NAME_CHAT_SSE = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_name_chat","type":"function","function":{"name":"name_chat","arguments":"{\\"title\\":\\"Named mock chat\\"}"}},{"index":1,"id":"call_unexpected","type":"function","function":{"name":"read_text_file","arguments":"{\\"path\\":\\"missing.txt\\"}"}}]},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");

function startMockServer() {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.tool_choice?.function?.name === "name_chat" ? NAME_CHAT_SSE : SSE_BODY);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, port: server.address().port, requests }));
  });
}

function runCli(cwd, port, extraArgs, tools = false) {
  return new Promise((resolvePromise) => {
    const flags = [
      "--base-url", `http://127.0.0.1:${port}`,
      "--timeout", "10000",
      "--no-color",
      "--tui-quiet",
      "--coord-dir", join(cwd, "coordination"),
      ...extraArgs
    ];
    if (!tools) flags.push("--no-tools");
    const child = spawn(process.execPath, [
      WATCH_CLI,
      ...flags
    ], {
      cwd,
      env: { ...process.env, SWITCHYARD_DATA_DIR: join(cwd, ".switchyard-data"), DEEPSEEK_API_KEY: "sk-test" },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr, error }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function sessionFiles(cwd) {
  const dir = join(cwd, ".switchyard-data", "sessions");
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `\n      ${detail}`}`);
}

const { server, port, requests } = await startMockServer();
const cwd = await mkdtemp(join(tmpdir(), "dsw-agent-session-test-"));
try {
  const agentId = "test-agent-1";

  const racedSessionPath = join(cwd, "concurrent-session-writes.json");
  await Promise.all(Array.from({ length: 12 }, (_, sequence) => writeSession(racedSessionPath, { sequence })));
  const racedSession = await readSession(racedSessionPath);
  check("concurrent session writes serialize and preserve the latest snapshot", racedSession.sequence === 11, JSON.stringify(racedSession));

  // Run 1: first launch → creates a session recording the agent id.
  const run1 = await runCli(cwd, port, ["--agent-id", agentId, "-p", "run one"]);
  check("run 1 exits 0", run1.code === 0, `code=${run1.code} stderr=${run1.stderr.slice(0, 200)}`);
  let files = await sessionFiles(cwd);
  check("run 1 created exactly one session", files.length === 1, `files=${files.length}`);
  const session1 = JSON.parse(await readFile(files[0], "utf8"));
  check("session records agent id", session1.config?.agentId === agentId, JSON.stringify(session1.config));

  // Run 2: same agent id → resumes the SAME session file (still one file).
  const run2 = await runCli(cwd, port, ["--agent-id", agentId, "-p", "run two"]);
  check("run 2 exits 0", run2.code === 0, `code=${run2.code} stderr=${run2.stderr.slice(0, 200)}`);
  files = await sessionFiles(cwd);
  check("run 2 reused the session (still one file)", files.length === 1, `files=${files.length}`);
  const session2 = JSON.parse(await readFile(files[0], "utf8"));
  const userPrompts = session2.messages.filter((message) => message.role === "user").map((message) => String(message.content));
  check("run 2 appended its prompt (resumed)", userPrompts.includes("run two"), JSON.stringify(userPrompts));

  // Run 3: --new → fresh session file for the same agent id.
  const run3 = await runCli(cwd, port, ["--agent-id", agentId, "--new", "-p", "run three"]);
  check("run 3 exits 0", run3.code === 0, `code=${run3.code} stderr=${run3.stderr.slice(0, 200)}`);
  files = await sessionFiles(cwd);
  check("run 3 --new created a second session", files.length === 2, `files=${files.length}`);

  // The newest session (run 3) holds "run three"; both record the agent id.
  const parsed = [];
  for (const file of files) parsed.push({ file, data: JSON.parse(await readFile(file, "utf8")) });
  parsed.sort((a, b) => (b.data.updatedAt || "").localeCompare(a.data.updatedAt || ""));
  check("new session records agent id too", parsed.every((entry) => entry.data.config?.agentId === agentId), JSON.stringify(parsed.map((entry) => entry.data.config?.agentId)));
  const freshPrompts = parsed[0].data.messages.filter((message) => message.role === "user").map((message) => String(message.content));
  check("--new session started fresh (only run three)", freshPrompts.length === 1 && freshPrompts[0] === "run three", JSON.stringify(freshPrompts));

  // Run 4: --resume --new must be rejected.
  const run4 = await runCli(cwd, port, ["--agent-id", agentId, "--resume", "--new", "-p", "bad"]);
  check("--resume --new rejected", run4.code === 1 && /cannot be combined/.test(`${run4.stderr}\n${run4.stdout}`), `code=${run4.code} out=${run4.stdout.slice(0, 200)} err=${run4.stderr.slice(0, 200)}`);

  const coordinatorRun = await runCli(cwd, port, ["--agent-role", "coordinator", "--new", "-p", "coordinator role check"]);
  const coordinatorFiles = await sessionFiles(cwd);
  const coordinatorSessions = await Promise.all(coordinatorFiles.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  check("coordinator role is saved when selected at launch", coordinatorRun.code === 0 && coordinatorSessions.some((session) => session.config?.agentRole === "coordinator"), `code=${coordinatorRun.code} roles=${JSON.stringify(coordinatorSessions.map((session) => session.config?.agentRole))}`);

  const namedCwd = await mkdtemp(join(tmpdir(), "dsw-named-session-test-"));
  try {
    const before = requests.length;
    const namedRun = await runCli(namedCwd, port, ["-p", "Summarize the project structure"], true);
    check("named chat exits 0", namedRun.code === 0, `code=${namedRun.code} stderr=${namedRun.stderr.slice(0, 200)}`);
    const namedFiles = await sessionFiles(namedCwd);
    const namedSession = namedFiles.length ? JSON.parse(await readFile(namedFiles[0], "utf8")) : {};
    check("model title is saved in session metadata", namedSession.title === "Named mock chat", JSON.stringify(namedSession.title));
    check("naming gate clears after successful name_chat", namedSession.config?.chatNamingPending === false, JSON.stringify(namedSession.config));
    const firstNamedArray = namedSession.messages.find((message) => message.role === "assistant" && message.tool_calls?.length);
    check("name_chat is the only call retained from the first tool-call array", firstNamedArray?.tool_calls?.length === 1 && firstNamedArray.tool_calls[0].function?.name === "name_chat", JSON.stringify(firstNamedArray?.tool_calls?.map((call) => call.function?.name)));
    check("sibling tool calls are discarded until the title is set", !namedSession.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "read_text_file")) && !namedSession.messages.some((message) => message.tool_call_id === "call_unexpected"), JSON.stringify(namedSession.messages.filter((message) => message.tool_calls || message.tool_call_id)));
    const namingRequests = requests.slice(before);
    check("first provider request exposes only forced name_chat", namingRequests[0]?.tool_choice?.function?.name === "name_chat" && namingRequests[0]?.tools?.length === 1 && namingRequests[0]?.tools?.[0]?.function?.name === "name_chat", JSON.stringify(namingRequests[0]?.tool_choice));
    const namingSystemPrompt = namingRequests[0]?.messages?.find((message) => message.role === "system")?.content || "";
    check("first-turn system prompt requires name_chat before any work", /FIRST-TURN CHAT NAMING/.test(namingSystemPrompt) && /only usable tool/.test(namingSystemPrompt) && /All other tools are unavailable/.test(namingSystemPrompt), namingSystemPrompt.slice(-500));
    check("DeepSeek forced naming disables unsupported thinking mode", namingRequests[0]?.thinking?.type === "disabled", JSON.stringify(namingRequests[0]?.thinking));
    check("normal tools return after the title is set", !namingRequests[1]?.tool_choice && namingRequests[1]?.tools?.some((tool) => tool.function?.name === "read_text_file"), JSON.stringify(namingRequests[1]?.tools?.map((tool) => tool.function?.name).slice(0, 3)));
    check("naming metadata is omitted from the follow-up provider history", !namingRequests[1]?.messages?.some((message) => message.tool_calls?.some((call) => call.function?.name === "name_chat") || (message.role === "tool" && message.tool_call_id === "call_name_chat")), JSON.stringify(namingRequests[1]?.messages?.map((message) => ({ role: message.role, tool_call_id: message.tool_call_id, calls: message.tool_calls?.map((call) => call.function?.name) }))));
    check("name_chat remains in the saved transcript for display", namedSession.messages.some((message) => message.tool_calls?.some((call) => call.function?.name === "name_chat")) && namedSession.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_name_chat"), JSON.stringify(namedSession.messages.map((message) => ({ role: message.role, tool_call_id: message.tool_call_id, calls: message.tool_calls?.map((call) => call.function?.name) }))));
    check("normal response keeps the configured reasoning mode", namingRequests[1]?.thinking?.type === "enabled", JSON.stringify(namingRequests[1]?.thinking));
    const followUp = await runCli(namedCwd, port, ["--resume", "--session", namedFiles[0], "-p", "continue the same chat"], true);
    check("resume exits 0 without renaming", followUp.code === 0, `code=${followUp.code} stderr=${followUp.stderr.slice(0, 200)}`);
    const resumedNamed = JSON.parse(await readFile(namedFiles[0], "utf8"));
    check("chat title remains unchanged after resume", resumedNamed.title === "Named mock chat", JSON.stringify(resumedNamed.title));
    const followUpRequests = requests.slice(before + 2);
    check("resumed chat never exposes name_chat again", followUpRequests.length === 1 && !followUpRequests[0]?.tool_choice && !followUpRequests[0]?.tools?.some((tool) => tool.function?.name === "name_chat"), JSON.stringify(followUpRequests.map((request) => request.tool_choice)));
  } finally {
    await rm(namedCwd, { recursive: true, force: true });
  }
} finally {
  server.close();
  await rm(cwd, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} agent-session checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} agent-session checks passed.`);
}
