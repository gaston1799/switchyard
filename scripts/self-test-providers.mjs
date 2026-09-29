import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderRequest, completeProvider, providerStream, normalizeUsage } from "../src/provider-transport.js";
import { normalizeProvider, fetchProviderModels, contextLimitFor, hasKnownContextLimit, UNKNOWN_MODEL_CONTEXT_LIMIT } from "../src/providers.js";
import { consumeMultimodalResults, modelCapabilities, multimodalResult } from '../src/multimodal.js';

async function collect(iterable) { const items = []; for await (const item of iterable) items.push(item); return items; }

const tools = [{ type: "function", function: { name: "read_text_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
const calls = [{ id: "call_1", type: "function", function: { name: "read_text_file", arguments: '{"path":"note.txt"}' } }];
const history = [{ role: "system", content: "Stable instructions" }, { role: "user", content: "Read note" }, { role: "assistant", content: "", tool_calls: calls }, { role: "tool", tool_call_id: "call_1", content: "hello" }];
const optsFor = (provider) => ({ provider, model: ({ anthropic: "claude-sonnet-4-6", openai: "gpt-5", deepseek: "deepseek-v4-flash", glm: "glm-4.7" })[provider], maxTokens: 4096, thinking: "enabled", effort: "high", session: "test-session" });
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
function responseStream(events) {
  const bytes = new TextEncoder().encode(sse(events));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

test("provider aliases and wire formats preserve call/result pairing without leaking session fields", () => {
  assert.equal(normalizeProvider("claude"), "anthropic");
  assert.equal(normalizeProvider("gpt"), "openai");
  for (const provider of ["deepseek", "glm", "anthropic", "openai"]) {
    const opts = optsFor(provider);
    const request = buildProviderRequest(opts, history, { tools, apiKey: "test", stream: true });
    const body = JSON.parse(request.init.body);
    if (provider === "anthropic") {
      assert.ok(request.url.endsWith("/messages"));
      assert.equal(body.system, "Stable instructions");
      assert.equal(body.messages.at(-1).content[0].tool_use_id, "call_1");
      assert.deepEqual(body.cache_control, { type: "ephemeral" });
      assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
    } else if (provider === "openai") {
      assert.ok(request.url.endsWith("/responses"));
      assert.equal(body.store, false);
      assert.equal(body.input.at(-1).call_id, "call_1");
      assert.equal(body.tools[0].strict, false);
      assert.equal(body.thinking, undefined);
      assert.equal(body.prompt_cache_key, JSON.parse(buildProviderRequest(opts, [...history, { role: "user", content: "next" }], { apiKey: "test" }).init.body).prompt_cache_key);
    } else {
      assert.ok(request.url.endsWith("/chat/completions"));
      assert.equal(body.messages.at(-1).tool_call_id, "call_1");
      assert.equal(body.stream_options.include_usage, true);
    }
  }
});

test('model capabilities gate native vision and image generation conservatively', () => {
  assert.deepEqual(modelCapabilities('openai', 'gpt-5'), { vision: true, imageGeneration: true });
  assert.deepEqual(modelCapabilities('openai', 'gpt-5.1-codex'), { vision: true, imageGeneration: false });
  assert.deepEqual(modelCapabilities('anthropic', 'claude-sonnet-4-6'), { vision: true, imageGeneration: false });
  assert.deepEqual(modelCapabilities('deepseek', 'deepseek-v4-flash'), { vision: false, imageGeneration: false });
  assert.equal(modelCapabilities('deepseek', 'deepseek-v4-flash-vision-exp').vision, true);
  assert.equal(modelCapabilities('glm', 'glm-4.6v').vision, true);
  assert.equal(modelCapabilities('openai', 'gpt-5-search-api').vision, false);
  assert.equal(modelCapabilities('openai', 'unknown-model').vision, false);
});

test('multimodal tool results become native Claude and GPT image content', () => {
  const media = multimodalResult({ text: '{"path":"shot.png"}', images: [{ data: 'aGVsbG8=', mimeType: 'image/png', path: 'shot.png' }] });
  const multimodalHistory = [history[0], history[1], history[2], { role: 'tool', tool_call_id: 'call_1', content: media }];
  const claude = JSON.parse(buildProviderRequest(optsFor('anthropic'), multimodalHistory, { apiKey: 'test' }).init.body);
  const claudeResult = claude.messages.at(-1).content.find(part => part.type === 'tool_result');
  assert.equal(claudeResult.content[1].type, 'image');
  assert.deepEqual(claudeResult.content[1].source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' });

  const gpt = JSON.parse(buildProviderRequest(optsFor('openai'), multimodalHistory, { apiKey: 'test' }).init.body);
  assert.equal(gpt.input.at(-2).type, 'function_call_output');
  assert.equal(gpt.input.at(-1).content[1].type, 'input_image');
  assert.equal(gpt.input.at(-1).content[1].image_url, 'data:image/png;base64,aGVsbG8=');

  const textOnly = JSON.parse(buildProviderRequest(optsFor('deepseek'), multimodalHistory, { apiKey: 'test' }).init.body);
  assert.equal(textOnly.messages.at(-1).role, 'tool');
  assert.equal(textOnly.messages.some(message => Array.isArray(message.content)), false);
});

test('image bytes are released after one model turn while metadata remains', () => {
  const content = multimodalResult({ text: 'shot.png', images: [{ data: 'aGVsbG8=', mimeType: 'image/png', path: 'shot.png' }] });
  const messages = [{ role: 'tool', content }];
  assert.ok(consumeMultimodalResults(messages) > 0);
  assert.equal(content.images[0].data, undefined);
  assert.equal(content.images[0].path, 'shot.png');
  assert.equal(content.consumed, true);
  assert.equal(consumeMultimodalResults(messages), 0);
});

test("cache usage counts Anthropic reads/writes as part of total input", () => {
  const usage = normalizeUsage("anthropic", { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 });
  assert.equal(usage.prompt_tokens, 130);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 100);
  assert.equal(usage.prompt_tokens_details.cache_write_tokens, 20);
  assert.equal(normalizeUsage("openai", { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } }).prompt_tokens, 100);
});

test("older Claude models keep budgeted thinking while 4.6 uses adaptive thinking", () => {
  const body = (model) => JSON.parse(buildProviderRequest({ ...optsFor("anthropic"), model }, history.slice(0, 2), { apiKey: "test" }).init.body);
  assert.equal(body("claude-sonnet-4-5").thinking.type, "enabled");
  assert.equal(body("claude-sonnet-4-5").thinking.budget_tokens, 4095);
  assert.equal(body("claude-sonnet-4-6").thinking.type, "adaptive");
});

test("Claude streams preserve thinking signatures and parallel tool JSON across chunks", async () => {
  const opts = optsFor("anthropic");
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check it" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    { type: "content_block_stop", index: 0 },
    ...[1, 2].flatMap((index) => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${index}`, name: "read_text_file", input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '"note.txt"}' } },
      { type: "content_block_stop", index }
    ]),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } },
    { type: "message_stop" }
  ];
  const chunks = await collect(providerStream(opts, history.slice(0, 2), { apiKey: "test", fetchImpl: async () => responseStream(events) }));
  const last = chunks.at(-1);
  assert.equal(last.usage.prompt_tokens, 110);
  assert.equal(last.providerState.content[0].signature, "signed");
  assert.deepEqual(last.providerState.content[1].input, { path: "note.txt" });
  const assistant = { role: "assistant", content: "", tool_calls: calls, providerState: last.providerState };
  const body = JSON.parse(buildProviderRequest(opts, [history[0], history[1], assistant], { apiKey: "test" }).init.body);
  assert.equal(body.messages.at(-1).content[0].signature, "signed");
  const other = JSON.parse(buildProviderRequest(optsFor("deepseek"), [assistant], { apiKey: "test" }).init.body);
  assert.equal(other.messages[0].providerState, undefined);
});

test("OpenAI streams preserve encrypted reasoning and tool output items for the next request", async () => {
  const opts = optsFor("openai");
  const output = [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_text_file", arguments: '{"path":"note.txt"}' }];
  const events = [
    { type: "response.output_item.added", output_index: 1, item: { ...output[1], arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":"note.txt"}' },
    { type: "response.output_item.done", output_index: 1, item: output[1] },
    { type: "response.completed", response: { output, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20 } } }
  ];
  const chunks = await collect(providerStream(opts, history.slice(0, 2), { apiKey: "test", fetchImpl: async () => responseStream(events) }));
  const last = chunks.at(-1);
  assert.equal(last.usage.prompt_tokens_details.cached_tokens, 80);
  const next = JSON.parse(buildProviderRequest(opts, [history[0], history[1], { role: "assistant", content: "", tool_calls: calls, providerState: last.providerState }, history[3]], { apiKey: "test" }).init.body);
  assert.deepEqual(next.input.slice(2, 4), output);
  assert.equal(next.input[4].call_id, "call_1");
});

test("truncated streams and provider errors cannot masquerade as completed replies", async () => {
  for (const provider of ["anthropic", "openai", "deepseek", "glm"]) {
    await assert.rejects(collect(providerStream(optsFor(provider), history.slice(0, 2), { apiKey: "test", fetchImpl: async () => responseStream([]) })), /before completion/);
    await assert.rejects(collect(providerStream(optsFor(provider), history.slice(0, 2), { apiKey: "test", fetchImpl: async () => responseStream([{ type: "error", error: { message: "overloaded", type: "overloaded_error" } }]) })), /overloaded/);
  }
});

test("nonstreaming requests support all providers", async () => {
  for (const provider of ["deepseek", "glm", "anthropic", "openai"]) {
    const payload = provider === "anthropic" ? { content: [{ type: "text", text: "answer" }] } : provider === "openai" ? { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] } : { choices: [{ message: { role: "assistant", content: "answer" } }] };
    const result = await completeProvider(optsFor(provider), history.slice(0, 2), { apiKey: "test", fetchImpl: async () => Response.json(payload) });
    assert.equal(result.content, "answer");
  }
});

test("Claude model discovery follows pagination and honors custom endpoints", async () => {
  const seen = [];
  const models = await fetchProviderModels("claude", "test", { baseUrl: "http://localhost/v1", fetchImpl: async (url, init) => {
    seen.push(url);
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    return Response.json(seen.length === 1 ? { data: [{ id: "a" }], has_more: true, last_id: "a" } : { data: [{ id: "b" }], has_more: false });
  } });
  assert.deepEqual(models, ["a", "b"]);
  assert.match(seen[1], /after_id=a/);
});

function runCli(script, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(`../src/${script}`, import.meta.url)), ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${stderr}`)); }, 20000);
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('GPT API session executes view_image as real image input and releases persisted bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'switchyard-image-'));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69kZ7wAAAABJRU5ErkJggg==';
  await writeFile(join(dir, 'pixel.png'), Buffer.from(png, 'base64'));
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"gpt-5"}]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const hasImage = body.input.some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'input_image'));
    const output = hasImage
      ? [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'image received', annotations: [] }] }]
      : [{ type: 'function_call', id: 'fc_1', call_id: 'call_image', name: 'view_image', arguments: '{"path":"pixel.png"}' }];
    const events = hasImage
      ? [{ type: 'response.output_text.delta', delta: 'image received' }, { type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 5 } } }]
      : [{ type: 'response.output_item.added', output_index: 0, item: { ...output[0], arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0, delta: output[0].arguments }, { type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 5 } } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(events));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sessionPath = join(dir, 'image-session.json');
  try {
    const result = await runCli('deepseek-watch.js', ['--provider', 'openai', '--model', 'gpt-5', '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--session', sessionPath, '--permission', 'review', '--no-update-check', '--tui-quiet', '--retry-attempts', '1', '-p', 'inspect pixel.png'], dir, { OPENAI_API_KEY: 'test' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 2);
    const image = requests[1].input.flatMap(item => Array.isArray(item.content) ? item.content : []).find(part => part.type === 'input_image');
    assert.equal(image.image_url, `data:image/png;base64,${png}`);
    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    const media = session.messages.find(message => message.role === 'tool').content;
    assert.equal(media.consumed, true);
    assert.equal(media.images[0].data, undefined);
    assert.equal(session.messages.at(-1).content, 'image received');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch CLI executes a real local tool round and resumes saved Claude/GPT sessions; dsd uses the same adapters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-provider-"));
  await writeFile(join(dir, "note.txt"), "fixture contents");
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ url: req.url, body });
      const anthropic = req.url.endsWith("/messages");
      const hasResult = anthropic ? body.messages.some((m) => m.content.some((c) => c.type === "tool_result")) : body.input.some((i) => i.type === "function_call_output");
      const useTool = body.stream && !hasResult;
      const output = anthropic ? [{ type: "text", text: "fixture complete" }] : [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "fixture complete", annotations: [] }] }];
      if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(anthropic ? { content: output } : { status: "completed", output })); return; }
      let events;
      if (anthropic) {
        const block = useTool ? { type: "tool_use", id: "call_1", name: "read_text_file", input: { path: "note.txt" } } : output[0];
        events = [{ type: "message_start", message: { usage: { input_tokens: 20 } } }, { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } }, { type: "message_stop" }];
      } else if (useTool) {
        const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_text_file", arguments: '{"path":"note.txt"}' };
        events = [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments }, { type: "response.completed", response: { output: [item], usage: { input_tokens: 20, output_tokens: 20 } } }];
      } else events = [{ type: "response.output_text.delta", delta: "fixture complete" }, { type: "response.completed", response: { output, usage: { input_tokens: 20, output_tokens: 20 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(sse(events));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ANTHROPIC_API_KEY: "test", OPENAI_API_KEY: "test", DSW_PROVIDER: "deepseek" };
  try {
    for (const provider of ["anthropic", "openai"]) {
      const sessionPath = join(dir, `${provider}.json`);
      const args = ["--provider", provider, "--base-url", baseUrl, "--session", sessionPath, "--permission", "review", "--no-update-check", "--tui-quiet", "--retry-attempts", "1", "--coord-dir", join(dir, "coord"), "-p", "read note.txt"];
      const result = await runCli("deepseek-watch.js", args, dir, env);
      assert.equal(result.code, 0, result.stderr);
      const session = JSON.parse(await readFile(sessionPath, "utf8"));
      assert.equal(session.provider, provider);
      assert.ok(session.messages.some((m) => m.role === "tool" && m.content.includes("fixture contents")));
      assert.equal(session.messages.at(-1).content, "fixture complete");
      assert.equal(session.messages.at(-1).providerState.provider, provider);
      const resumed = await runCli("deepseek-watch.js", ["--resume", "--session", sessionPath, "--no-update-check", "--tui-quiet", "--retry-attempts", "1", "-p", "continue"], dir, env);
      assert.equal(resumed.code, 0, resumed.stderr);
      const out = join(dir, `${provider}.md`);
      const detached = await runCli("deepseek-detached.js", ["--provider", provider, "--base-url", baseUrl, "--no-fallback", "--output", out, "-p", "hello"], dir, env);
      assert.equal(detached.code, 0, detached.stderr);
      assert.equal((await readFile(out, "utf8")).trim(), "fixture complete");
    }
    assert.ok(requests.filter((r) => r.body.stream).every((r) => r.url === "/v1/messages" || r.url === "/v1/responses"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Context windows, which no provider reports.
 *
 * Re-checked live on 2026-09-21: `GET /models` returns only id/object/owned_by
 * on DeepSeek, plus created on GLM, plus created and shutdown_date on OpenAI.
 * Nothing carries a window, and OpenAI's overflow error names no figure, so this
 * table cannot be replaced by discovery and has to be defended by tests instead.
 *
 * The bug these cover: the table held three OpenAI names and had no `gpt-5`
 * family rule, so every 5.1/5.2, every pro and codex variant, and every dated
 * alias silently fell to the 131,072 floor -- compacting at ~118K on a 400K
 * model and throwing away two thirds of the window.
 */
test("every GPT-5 variant and dated alias gets the family window, not the floor", () => {
  for (const model of [
    "gpt-5", "gpt-5-2025-08-07", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
    "gpt-5.1", "gpt-5.2", "gpt-5.2-pro",
    "gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.2-codex"
  ]) {
    assert.equal(contextLimitFor("openai", model), 400_000, model);
    assert.equal(hasKnownContextLimit(model), true, model);
    assert.notEqual(contextLimitFor("openai", model), UNKNOWN_MODEL_CONTEXT_LIMIT, model);
  }
});

test("the two GPT-5 names that are NOT 400K keep their own smaller windows", () => {
  // Exact names are matched before family patterns. If that order ever flips,
  // these inherit 400K -- guessing HIGH, the direction that does not compact in
  // time and fails the request outright instead of merely compacting early.
  assert.equal(contextLimitFor("openai", "gpt-5-chat-latest"), 128_000);
  assert.equal(contextLimitFor("openai", "gpt-5-search-api"), 131_072);
  assert.ok(contextLimitFor("openai", "gpt-5-chat-latest") < contextLimitFor("openai", "gpt-5"));
});

test("GPT-4.1 carries its million-token window", () => {
  for (const model of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.1-2025-04-14"]) {
    assert.equal(contextLimitFor("openai", model), 1_047_576, model);
  }
});

test("the other providers' windows are unchanged by the OpenAI rules", () => {
  // The new `^gpt-` patterns must not reach across providers or shadow the
  // existing GLM and DeepSeek entries.
  assert.equal(contextLimitFor("glm", "glm-4.7"), 204_800);
  assert.equal(contextLimitFor("glm", "glm-4.5-air"), 131_072);
  assert.equal(contextLimitFor("glm", "glm-5.2"), 1_048_576);
  assert.equal(contextLimitFor("deepseek", "deepseek-v4-pro"), 1_000_000);
  assert.equal(contextLimitFor("anthropic", "claude-sonnet-4-6"), 1_000_000);
});

test("a model nobody has added still degrades to the cautious floor, with a warning flag", () => {
  // The fallback must stay -- a newly released name should compact early rather
  // than assume a window it may not have.
  for (const model of ["gpt-6-astra", "zzz-unreleased-model", "totally-new-model"]) {
    assert.equal(contextLimitFor("openai", model), UNKNOWN_MODEL_CONTEXT_LIMIT, model);
    assert.equal(hasKnownContextLimit(model), false, model);
  }
});

/**
 * Coverage, not just correctness.
 *
 * 16 of the 50 priced models had no window before this: nine of eleven Claude
 * models, GPT-4o, the whole o-series, and deepseek-flash. A priced model is one
 * somebody can actually select, so a missing window means real compaction at
 * 131K on a model that may hold far more.
 */
test("every priced model has a known context window, except the one documented omission", () => {
  const lines = readFileSync(new URL("../src/model-pricing.js", import.meta.url), "utf8").split(String.fromCharCode(10));
  let provider = null;
  const priced = [];
  for (const line of lines) {
    const head = line.match(/^\s{2}(openai|anthropic|glm|deepseek):\s*\{/);
    if (head) { provider = head[1]; continue; }
    if (/^\s{2}\},?\s*$/.test(line)) { provider = null; continue; }
    const id = line.match(/^\s*'([^']+)':\s*\[/);
    if (id && provider) priced.push(id[1]);
  }
  assert.ok(priced.length >= 50, `parsed only ${priced.length} priced models -- the parse broke, not the table`);
  const unknown = priced.filter((id) => !hasKnownContextLimit(id));
  // gpt-6-astra is left unknown on purpose so the warning keeps firing.
  assert.deepEqual(unknown, ["gpt-6-astra"], `unexpected models without a window: ${unknown.join(", ")}`);
});

/**
 * Claude windows, VERIFIED against the context-windows doc on 2026-09-21, not
 * inferred. The table previously held sonnet-4-6 and opus-4-6 at 200K as a
 * deliberate "conservative baseline"; 1M is the default with no beta header, so
 * that caution was throwing away 800K of context on the models most likely to
 * be used for long agentic runs.
 */
test("the 1M Claude generation gets 1M, not the old conservative 200K", () => {
  for (const model of [
    "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8",
    "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6"
  ]) {
    assert.equal(contextLimitFor("anthropic", model), 1_000_000, model);
  }
});

test("the 200K Claude generation is NOT widened to 1M", () => {
  // Guessing high here is the direction that overruns a real 200K window.
  for (const model of ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]) {
    assert.equal(contextLimitFor("anthropic", model), 200_000, model);
  }
});

test("an unknown Claude model takes the documented 200K floor", () => {
  assert.equal(contextLimitFor("anthropic", "claude-not-released-yet"), 200_000);
});

test("GPT-4o and the o-series keep their own windows, not the GPT-5 family's", () => {
  assert.equal(contextLimitFor("openai", "gpt-4o"), 128_000);
  assert.equal(contextLimitFor("openai", "gpt-4o-mini"), 128_000);
  for (const model of ["o3", "o3-mini", "o4-mini"]) {
    assert.equal(contextLimitFor("openai", model), 200_000, model);
  }
});

test("deepseek-flash matches its v4 sibling, as measured", () => {
  // A ~200K-token request was accepted by both on 2026-09-21, so neither is a
  // 128K-class model.
  assert.equal(contextLimitFor("deepseek", "deepseek-flash"), 1_000_000);
  assert.equal(contextLimitFor("deepseek", "deepseek-v4-flash"), 1_000_000);
});
