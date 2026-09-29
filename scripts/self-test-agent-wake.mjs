import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRuntime, listAgents, sendAgentMessage } from "../src/agent-coordination.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), "dsw-agent-wake-test-"));
const coordDir = join(tempRoot, "coordination");
const sessionFile = join(tempRoot, "worker-session.json");
const outputFile = join(tempRoot, "result.md");
let coordinator;
let child;
let stderr = "";
let requestCount = 0;
let secondRequestMessages = [];
let thirdRequestMessages = [];

function sse(response, payloads) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body || "{}");
  if (request.method !== "POST" || request.url?.endsWith("/user/balance")) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "endpoint unavailable in this mock" }));
    return;
  }
  requestCount += 1;
  if (requestCount === 1) {
    sse(response, [{
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call-wait-1",
            type: "function",
            function: { name: "agent_wait", arguments: JSON.stringify({ reason: "Waiting for coordinator dependency." }) }
          }]
        },
        finish_reason: "tool_calls"
      }]
    }]);
    return;
  }
  if (requestCount === 2) {
    secondRequestMessages = parsed.messages || [];
    sse(response, [{ choices: [{ delta: { content: "Woke after coordinator message." }, finish_reason: "stop" }] }]);
    return;
  }
  thirdRequestMessages = parsed.messages || [];
  sse(response, [{ choices: [{ delta: { content: "Resumed after normal completion." }, finish_reason: "stop" }] }]);
});

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function removeTempRootWithRetry() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

try {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  coordinator = await createAgentRuntime(coordDir, {
    agentId: "coordinator-test",
    role: "coordinator",
    mission: "Wake the test worker.",
    workspace: tempRoot,
    session: join(tempRoot, "coordinator-session.json"),
    heartbeatMs: 250
  });

  child = spawn(process.execPath, [
    join(repoRoot, "src", "deepseek-watch.js"),
    "--agent-id", "worker-test",
    "--agent-role", "worker",
    "--agent-mission", "Park, then resume when the coordinator writes.",
    "--coord-dir", coordDir,
    "--session", sessionFile,
    "--base-url", `http://127.0.0.1:${address.port}`,
    "--permission", "full",
    "--no-output",
    "--outfile", outputFile,
    "-p", "Call agent_wait now. After waking, report that the message arrived."
  ], {
    cwd: tempRoot,
    env: { ...process.env, DEEPSEEK_API_KEY: "test-key" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  await waitUntil(async () => {
    const agents = await listAgents(coordDir, { includeStopped: true });
    return agents.some((agent) => agent.agentId === "worker-test" && agent.state === "waiting_for_message");
  }, 5000, "worker to park");

  assert.equal(requestCount, 1, "no model request should remain active while parked");
  await sendAgentMessage(coordDir, {
    from: "coordinator-test",
    to: "worker-test",
    type: "wake",
    body: "The dependency is ready. Continue now."
  });

  const exitCode = await Promise.race([
    new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise(code));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for worker process to exit.")), 8000))
  ]);
  assert.equal(exitCode, 0, stderr);
  assert.equal(requestCount, 2);
  assert.match(await readFile(outputFile, "utf8"), /Woke after coordinator message/);
  assert.equal(
    secondRequestMessages.some((message) => message.role === "user" && String(message.content).includes('<agent_message from="coordinator-test" type="wake"')),
    true,
    "wakeup message should be injected into the resumed model turn"
  );
  const savedSession = JSON.parse(await readFile(sessionFile, "utf8"));
  assert.equal(savedSession.config.agentId, "worker-test");
  assert.equal(savedSession.config.agentRole, "worker");
  assert.equal(savedSession.messages[0].role, "system");
  assert.match(savedSession.messages[0].content, /agent_id: worker-test/);

  const sender = spawn(process.execPath, [
    join(repoRoot, "src", "deepseek-watch.js"),
    "message", "worker-test", "A new instruction after normal completion.",
    "--coord-dir", coordDir
  ], {
    cwd: tempRoot,
    env: { ...process.env, DEEPSEEK_API_KEY: "test-key" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const senderExit = await new Promise((resolvePromise, reject) => {
    sender.once("error", reject);
    sender.once("exit", (code) => resolvePromise(code));
  });
  assert.equal(senderExit, 0, "message command should queue and auto-resume a completed agent");
  await waitUntil(() => requestCount === 3, 8000, "completed worker to auto-resume after a message");
  assert.equal(
    thirdRequestMessages.some((message) => message.role === "user" && String(message.content).includes('<agent_message from="operator" type="message"')),
    true,
    "message to a completed agent should be injected into the automatically resumed session"
  );
  process.stdout.write("agent park/wake end-to-end self-test: ok\n");
} finally {
  if (child && child.exitCode == null) child.kill();
  let cleanupError = null;
  if (coordinator) {
    try { await coordinator.stop("completed"); }
    catch (error) { cleanupError = error; }
  }
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await removeTempRootWithRetry();
  if (cleanupError) throw cleanupError;
}
