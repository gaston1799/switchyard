#!/usr/bin/env node
// Self-test: fetch-retry behavior of the watch CLI (deepseek-watch.js) and
// the detached worker (deepseek-detached.js). A local mock DeepSeek server
// fails with HTTP 500 twice, then streams a valid SSE completion. The CLI
// must retry (not crash) and produce the final answer; an auth failure (401)
// must fail fast without retrying.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WATCH_CLI = join(REPO, "src", "deepseek-watch.js");
const DETACHED_CLI = join(REPO, "src", "deepseek-detached.js");

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hello from mock"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");

const JSON_BODY = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }]
});

function jsonError(status, message) {
  return JSON.stringify({ error: { message, code: "mock_error", type: "server_error" } });
}

function startMockServer({ failStatuses = [500, 500], authFail = false } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    requests += 1;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (authFail) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(jsonError(401, "Authentication Fails..."));
        return;
      }
      if (requests <= failStatuses.length) {
        res.writeHead(failStatuses[requests - 1], { "content-type": "application/json" });
        res.end(jsonError(failStatuses[requests - 1], "mock server hiccup"));
        return;
      }
      // The watch CLI sends stream:true (expects SSE); the detached worker
      // sends no stream flag (expects a plain JSON completion).
      let streaming = false;
      try { streaming = JSON.parse(body || "{}")?.stream === true; } catch {}
      if (streaming) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE_BODY);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON_BODY);
      }
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, port: server.address().port, requestCount: () => requests }));
  });
}

function runCli(cli, args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: REPO,
      env: { ...process.env, DEEPSEEK_API_KEY: "sk-test", ...env },
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

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `\n      ${detail}`}`);
}

const tmp = await mkdtemp(join(tmpdir(), "dsw-retry-test-"));
try {
  // 1. CLI retries transient 500s and completes.
  {
    const { server, port, requestCount } = await startMockServer({ failStatuses: [500, 500] });
    try {
      const session = join(tmp, "cli-session.json");
      const output = join(tmp, "cli-out.md");
      const result = await runCli(WATCH_CLI, [
        "-p", "ping",
        "--base-url", `http://127.0.0.1:${port}`,
        "--retry-attempts", "5",
        "--retry-delay", "100",
        "--retry-max-delay", "300",
        "--timeout", "10000",
        "--no-tools",
        "--no-color",
        "--tui-quiet",
        "--no-save-session",
        "--session", session,
        "--coord-dir", join(tmp, "coordination"),
        "--agent-id", "retry-test-cli",
        "-o", output
      ]);
      const combined = `${result.stdout}\n${result.stderr}`;
      const outText = await readFile(output, "utf8").catch(() => "");
      check("cli exits 0 after transient 500s", result.code === 0, `code=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      check("cli retried (3 requests: 2 fails + 1 success)", requestCount() === 3, `requests=${requestCount()}`);
      check("cli logged retry message", /retrying this turn/.test(combined), combined.slice(0, 400));
      check("cli wrote final answer", outText.includes("hello from mock"), outText.slice(0, 200));
    } finally {
      server.close();
    }
  }

  // 2. CLI fails fast on terminal auth errors (no retry).
  {
    const { server, port, requestCount } = await startMockServer({ authFail: true });
    try {
      const result = await runCli(WATCH_CLI, [
        "-p", "ping",
        "--base-url", `http://127.0.0.1:${port}`,
        "--retry-attempts", "5",
        "--retry-delay", "100",
        "--no-tools",
        "--no-color",
        "--tui-quiet",
        "--no-save-session",
        "--session", join(tmp, "cli-auth-session.json"),
        "--coord-dir", join(tmp, "coordination-auth"),
        "--agent-id", "retry-test-auth",
        "-o", join(tmp, "cli-auth-out.md")
      ]);
      check("cli exits 1 on 401", result.code === 1, `code=${result.code}`);
      check("cli 401 did not retry (1 request)", requestCount() === 1, `requests=${requestCount()}`);
      check("cli 401 message shown", /DeepSeek HTTP 401/.test(result.stderr), result.stderr.slice(0, 200));
    } finally {
      server.close();
    }
  }

  // 3. Detached worker retries transient 500s and writes the output file.
  {
    const { server, port, requestCount } = await startMockServer({ failStatuses: [500, 500] });
    try {
      const output = join(tmp, "dsd-out.md");
      const result = await runCli(DETACHED_CLI, [
        "-p", "ping",
        "-o", output,
        "--base-url", `http://127.0.0.1:${port}`,
        "--retry-attempts", "5",
        "--retry-delay", "100",
        "--retry-max-delay", "300",
        "--timeout", "10000",
        "--no-fallback"
      ]);
      const outText = await readFile(output, "utf8").catch(() => "");
      check("dsd exits 0 after transient 500s", result.code === 0, `code=${result.code} stderr=${result.stderr.slice(0, 300)}`);
      check("dsd retried (3 requests)", requestCount() === 3, `requests=${requestCount()}`);
      check("dsd logged retry message", /retrying in \d+s/.test(result.stderr), result.stderr.slice(0, 300));
      check("dsd wrote final answer", outText.includes("hello from mock"), outText.slice(0, 200));
    } finally {
      server.close();
    }
  }

  // 4. Unit-level classification sanity.
  {
    const { isRetryableFetchError, retryBackoffMs } = await import("../src/fetch-retry.js");
    const httpErr = Object.assign(new Error("x"), { status: 429 });
    check("429 is retryable", isRetryableFetchError(httpErr));
    const authErr = Object.assign(new Error("x"), { status: 401 });
    check("401 is not retryable", !isRetryableFetchError(authErr));
    check("network TypeError is retryable", isRetryableFetchError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })));
    check("plain Error is not retryable", !isRetryableFetchError(new Error("boom")));
    check("backoff doubles and caps", retryBackoffMs(1000, 30000, 1) === 1000 && retryBackoffMs(1000, 30000, 6) === 30000);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} retry checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} retry checks passed.`);
}
