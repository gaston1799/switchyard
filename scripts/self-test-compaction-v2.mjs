import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { compactSession, compactSessionDetached, computeCompactionPlan, estimateContextTokens, summaryOptions, truncateTranscriptForSummary } from "../src/context-compactor.js";
import { conversationTurns } from "../src/conversation-turns.js";
import { writeSession } from "../src/session-memory.js";

function messages(count = 30) {
  const output = [{ role: "system", content: "instructions" }, { role: "user", content: "Implement the task. Preserve file X." }];
  for (let i = 0; i < count; i++) {
    output.push({ role: "assistant", content: `working ${i}`, tool_calls: [0, 1].map((j) => ({ id: `call_${i}_${j}`, type: "function", function: { name: "read_text_file", arguments: '{"path":"note.txt"}' } })) });
    output.push(...[0, 1].map((j) => ({ role: "tool", tool_call_id: `call_${i}_${j}`, content: `RESULT_${i}_${j}` + "x".repeat(1000) })));
  }
  return output;
}
const options = { provider: "deepseek", model: "deepseek-v4-flash", contextLimit: 100000, maxTokens: 4096, compactMethod: "truncate", compactForce: true };

test("default keeps 15 full tool turns and the entire pending parallel tool batch", () => {
  const input = messages();
  const pending = [{ role: "assistant", content: "", tool_calls: [{ id: "pending-a", function: { name: "read_text_file", arguments: "{}" } }, { id: "pending-b", function: { name: "read_text_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "pending-a", content: "first result" }];
  input.push(...pending);
  const plan = computeCompactionPlan(input, { limit: 100000, completionTokens: 4096, force: true });
  assert.equal(plan.keptTurns, 15);
  assert.equal(plan.foldedTurns, 15);
  assert.equal(plan.activeTurn, true);
  assert.equal(plan.tail.length, 15 * 3 + 2);
  assert.equal(plan.tail[0].tool_calls[0].id, "call_15_0");
  assert.deepEqual(plan.tail.slice(-2), pending);
  assert.equal(conversationTurns(plan.tail).complete.length, 15);
});

test("compaction replaces prefix in memory and persisted JSON, keeping the recent tail byte-for-byte", async () => {
  const session = { messages: messages(), goal: { status: "active", objective: "Keep working" } };
  const original = structuredClone(session.messages);
  const meta = await compactSession(options, session);
  assert.equal(meta.keptTurns, 15);
  assert.deepEqual(session.messages.slice(2), original.slice(2 + 15 * 3));
  assert.equal(session.messages.filter((m) => m.compactionSummary).length, 1);
  const dir = await mkdtemp(join(tmpdir(), "switchyard-compact-"));
  try {
    const file = join(dir, "session.json");
    await writeSession(file, { messages: original });
    await writeSession(file, session);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved, session);
    assert.ok(!saved.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_0_0"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("successive compactions replace the earlier summary instead of accumulating summaries", async () => {
  const session = { messages: messages() };
  await compactSession(options, session);
  session.messages.push(...messages(20).slice(2));
  await compactSession(options, session);
  assert.equal(session.messages.filter((m) => m.compactionSummary).length, 1);
  assert.equal(conversationTurns(session.messages).complete.length, 15);
  assert.equal(session.compactions.length, 2);
});

test("oversized retained turns produce an explicit error without mutation", async () => {
  const session = { messages: messages() };
  const before = structuredClone(session);
  await assert.rejects(compactSession({ ...options, contextLimit: 5000 }, session), /cannot fit while preserving 15/);
  assert.deepEqual(session, before);
});

test("tool schema budget is included in trigger and post-compaction budget", async () => {
  const session = { messages: messages() };
  const meta = await compactSession({ ...options, compactToolTokens: 1000 }, session);
  assert.equal(meta.projectedTokens, Math.ceil((estimateContextTokens(session.messages) + 1000) * 1.2));
});

test("summary provider override cannot inherit the agent endpoint or model", () => {
  const selected = summaryOptions({ ...options, baseUrl: "https://custom-deepseek.invalid", compactProvider: "claude" });
  assert.equal(selected.provider, "anthropic");
  assert.equal(selected.model, "claude-sonnet-4-6");
  assert.equal(selected.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(selected.contextLimit, 200000);
});

test("summary calls have a separate prompt, provider format, context budget and no agent tools", async () => {
  for (const provider of ["anthropic", "openai", "glm", "deepseek"]) {
    let captured;
    const session = { messages: messages() };
    const meta = await compactSession({ ...options, compactMethod: "auto", compactProvider: provider, compactContextLimit: 8000, compactBaseUrl: "http://summary.local/v1" }, session, {
      apiKey: "test", fetchImpl: async (url, init) => {
        captured = { url, body: JSON.parse(init.body) };
        return Response.json(provider === "anthropic" ? { content: [{ type: "text", text: "Summary" }] } : provider === "openai" ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Summary" }] }] } : { choices: [{ message: { content: "Summary" } }] });
      }
    });
    assert.equal(meta.method, "llm");
    assert.ok(captured.url.startsWith("http://summary.local/v1/"));
    assert.equal(captured.body.stream, false);
    assert.equal(captured.body.tools, undefined);
    assert.ok(JSON.stringify(captured.body).includes("context compactor"));
    assert.ok(JSON.stringify(captured.body).length < 8000 * 4);
    if (provider === "anthropic") assert.equal(captured.body.thinking, undefined);
    if (provider === "openai") assert.equal(captured.body.thinking, undefined);
  }
});

test("empty response, HTTP failure, timeout and overlong summary all fall back deterministically", async () => {
  const failures = [
    async () => Response.json({ choices: [{ message: { content: "" } }] }),
    async () => new Response("unavailable", { status: 503 }),
    async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true })),
    async () => Response.json({ choices: [{ message: { content: "x".repeat(20000) } }] })
  ];
  for (const fetchImpl of failures) {
    const session = { messages: messages() };
    const meta = await compactSession({ ...options, compactMethod: "llm", compactRetryAttempts: 1, compactTimeoutMs: 20 }, session, { apiKey: "test", fetchImpl });
    assert.equal(meta.method, "truncate_fallback");
    assert.match(session.messages[1].content, /deterministic roll-up/);
    assert.match(session.messages[1].content, /Preserve file X/);
  }
});

test("persistent transient failure stops after bounded retries", async () => {
  let calls = 0;
  const meta = await compactSession({ ...options, compactMethod: "auto", compactRetryAttempts: 2, retryDelay: 100 }, { messages: messages() }, { apiKey: "test", fetchImpl: async () => { calls++; return new Response("unavailable", { status: 503 }); } });
  assert.equal(calls, 2);
  assert.equal(meta.method, "truncate_fallback");
});

test("bounded summary excerpt retains the actual newest folded content", () => {
  const input = Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `MESSAGE_${i}:` + "x".repeat(2000) }));
  const text = truncateTranscriptForSummary(input, 1000);
  assert.ok(text.length <= 4000);
  assert.ok(text.includes("MESSAGE_0:"));
  assert.ok(text.includes("MESSAGE_99:"));
});

test("detached compaction sends the saved GPT provider/model/endpoint and returns a replaced prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-detached-compact-"));
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  let captured;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    captured = { url: req.url, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Detached summary" }] }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = { provider: "openai", model: "gpt-5", messages: messages(), config: { provider: "openai" } };
    const meta = await compactSessionDetached({ ...options, provider: "openai", model: "gpt-5", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, session: join(dir, "session.json"), compactMethod: "detached", compactAt: 0.1, compactKeepRecent: 15 }, session);
    assert.equal(meta.method, "llm");
    assert.equal(captured.url, "/v1/responses");
    assert.equal(captured.body.model, "gpt-5");
    assert.equal(captured.body.tools, undefined);
    assert.match(session.messages[1].content, /Detached summary/);
    assert.equal(meta.keptTurns, 15);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
