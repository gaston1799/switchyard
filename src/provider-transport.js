// Provider wire formats are isolated here; sessions retain the existing chat/tool shape.
import { createHash } from "node:crypto";
import { normalizeProvider, providerConfig } from "./providers.js";
import { applyThinkingOptions } from "./deepseek-request.js";
import { deepSeekHttpError } from "./api-error.js";

export function providerHeaders(provider, apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(normalizeProvider(provider) === "anthropic" ? { "anthropic-version": "2023-06-01" } : {})
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) return content.map((part) => part.text || JSON.stringify(part)).join("\n");
  return JSON.stringify(content);
}

function nativeState(message, opts) {
  const state = message.providerState;
  return state?.provider === normalizeProvider(opts.provider) && state.model === opts.model ? state : null;
}

function anthropicMessages(messages, opts) {
  const output = [];
  for (const message of messages) {
    if (["system", "developer"].includes(message.role)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    let content;
    if (message.role === "tool") {
      content = [{ type: "tool_result", tool_use_id: message.tool_call_id, content: contentText(message.content) }];
    } else if (nativeState(message, opts)?.content) {
      content = nativeState(message, opts).content;
    } else {
      content = contentText(message.content) ? [{ type: "text", text: contentText(message.content) }] : [];
      for (const call of message.tool_calls || []) {
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") });
      }
    }
    if (!content.length) continue;
    // Tool results must immediately follow their tool_use block, in one user message.
    if (output.at(-1)?.role === role) output.at(-1).content.push(...content);
    else output.push({ role, content: [...content] });
  }
  return output;
}

function responseInput(messages, opts) {
  const input = [];
  for (const message of messages) {
    const native = nativeState(message, opts);
    if (message.role === "assistant" && native?.output) {
      input.push(...native.output);
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: contentText(message.content) });
      continue;
    }
    const text = contentText(message.content);
    if (text) input.push({ role: message.role === "system" ? "developer" : message.role, content: text });
    for (const call of message.tool_calls || []) {
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
    }
  }
  return input;
}

export function buildProviderRequest(opts, messages, { apiKey, stream = false, tools = [] } = {}) {
  const provider = normalizeProvider(opts.provider);
  const config = providerConfig(provider);
  const base = String(opts.baseUrl || config.baseUrl).replace(/\/$/, "");
  const model = opts.model || config.model;
  opts = { ...opts, provider, model };
  let body;
  let endpoint;
  if (config.protocol === "messages") {
    endpoint = "messages";
    body = { model, stream, max_tokens: opts.maxTokens || 16384,
      system: messages.filter((m) => ["system", "developer"].includes(m.role)).map((m) => contentText(m.content)).join("\n\n"),
      messages: anthropicMessages(messages, opts), cache_control: { type: "ephemeral" } };
    if (tools.length) body.tools = tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    if (opts.thinking === "enabled" && !opts.compactionRequest) {
      if (/^claude-(?:sonnet|opus)-(?:4-6|[5-9](?:[.-]|$))/.test(model)) body.thinking = { type: "adaptive" };
      else if (body.max_tokens > 1024) body.thinking = { type: "enabled", budget_tokens: Math.min(4096, body.max_tokens - 1) };
    }
  } else if (config.protocol === "responses") {
    endpoint = "responses";
    body = { model, stream, store: false, input: responseInput(messages, opts), max_output_tokens: opts.maxTokens || 16384,
      include: ["reasoning.encrypted_content"] };
    if (tools.length) body.tools = tools.map(({ function: tool }) => ({ type: "function", ...tool, strict: false }));
    if (/^(gpt-[5-9]|o[134])/.test(model)) {
      body.reasoning = { effort: opts.thinking === "disabled" || opts.compactionRequest ? (/^gpt-5(?:-|$)|^o/.test(model) ? "minimal" : "none") : (opts.effort === "max" ? "high" : opts.effort || "high") };
    }
    // Deterministic per-session routing key; never contains prompts or credentials.
    body.prompt_cache_key = createHash("sha256").update(`${opts.session || opts.agentId || "switchyard"}:${opts.compactionRequest ? "summary" : "agent"}`).digest("hex");
  } else {
    endpoint = "chat/completions";
    body = { model, stream, max_tokens: opts.maxTokens || 16384,
      messages: messages.map((m) => ({ role: m.role, content: m.content ?? "",
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.reasoning_content && provider === "deepseek" ? { reasoning_content: m.reasoning_content } : {}) })) };
    applyThinkingOptions(body, opts);
    if (stream) body.stream_options = { include_usage: true };
    if (tools.length) body.tools = tools;
  }
  return { url: `${base}/${endpoint}`, init: { method: "POST", headers: providerHeaders(provider, apiKey), body: JSON.stringify(body) } };
}

export function normalizeUsage(provider, usage) {
  if (!usage) return null;
  const anthropic = normalizeProvider(provider) === "anthropic";
  const cached = Number(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
  const written = Number(usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens ?? 0);
  return { prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) + (anthropic ? cached + written : 0),
    completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written }, raw: usage };
}

function normalizedMessage(opts, data) {
  if (normalizeProvider(opts.provider) === "anthropic") {
    return { role: "assistant", content: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
      tool_calls: (data.content || []).filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } })),
      providerState: { provider: "anthropic", model: opts.model, content: data.content || [] } };
  }
  if (normalizeProvider(opts.provider) === "openai") {
    if (data.error || data.status === "failed" || data.status === "incomplete") throw new Error(data.error?.message || `OpenAI response ${data.status}`);
    return { role: "assistant", content: (data.output || []).flatMap((i) => i.content || []).filter((b) => b.type === "output_text").map((b) => b.text).join(""),
      tool_calls: (data.output || []).filter((i) => i.type === "function_call").map((i) => ({ id: i.call_id, type: "function", function: { name: i.name, arguments: i.arguments } })),
      providerState: { provider: "openai", model: opts.model, output: data.output || [] } };
  }
  return data.choices?.[0]?.message || { role: "assistant", content: "" };
}

export async function completeProvider(opts, messages, { apiKey, signal, fetchImpl = fetch } = {}) {
  const { url, init } = buildProviderRequest(opts, messages, { apiKey });
  const response = await fetchImpl(url, { ...init, signal });
  if (!response.ok) throw await deepSeekHttpError(response, providerConfig(opts.provider).label);
  const data = await response.json();
  return { ...normalizedMessage(opts, data), usage: normalizeUsage(opts.provider, data.usage) };
}

// SSE parser handles arbitrary UTF-8/chunk boundaries and a final frame without a newline.
export async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  function line(text) {
    if (text === "") { const frame = data.join("\n"); data = []; return frame; }
    if (text.startsWith("data:")) data.push(text.slice(5).trimStart());
    return null;
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = line(buffer.slice(0, end).replace(/\r$/, ""));
      buffer = buffer.slice(end + 1);
      if (frame) yield frame === "[DONE]" ? { done: true } : JSON.parse(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer) line(buffer.replace(/\r$/, ""));
  const frame = line("");
  if (frame) yield frame === "[DONE]" ? { done: true } : JSON.parse(frame);
}

const deltaChunk = (delta, finish_reason) => ({ choices: [{ delta, finish_reason }] });

export async function* providerStream(opts, messages, { apiKey, tools = [], signal, fetchImpl = fetch } = {}) {
  const { url, init } = buildProviderRequest(opts, messages, { apiKey, tools, stream: true });
  const response = await fetchImpl(url, { ...init, signal });
  if (!response.ok) throw await deepSeekHttpError(response, providerConfig(opts.provider).label);
  const provider = normalizeProvider(opts.provider);
  const blocks = [];
  const argumentsByIndex = new Map();
  const callIndexes = new Map();
  let usage = {};
  let finished = false;
  for await (const data of readSse(response.body)) {
    if (data.error || data.type === "error" || data.type === "response.failed") {
      const error = new Error(data.error?.message || data.response?.error?.message || "Provider stream failed");
      if (data.error?.type === "overloaded_error") error.status = 529;
      throw error;
    }
    if (provider === "anthropic") {
      if (data.type === "message_start") usage = { ...data.message?.usage };
      if (data.type === "content_block_start") {
        blocks[data.index] = structuredClone(data.content_block);
        if (data.content_block.type === "text" && data.content_block.text) yield deltaChunk({ content: data.content_block.text });
        if (data.content_block.type === "tool_use") {
          argumentsByIndex.set(data.index, "");
          yield deltaChunk({ tool_calls: [{ index: data.index, id: data.content_block.id, type: "function", function: { name: data.content_block.name, arguments: "" } }] });
        }
      }
      if (data.type === "content_block_delta") {
        const block = blocks[data.index];
        const delta = data.delta;
        if (delta.type === "text_delta") { block.text += delta.text; yield deltaChunk({ content: delta.text }); }
        if (delta.type === "thinking_delta") { block.thinking += delta.thinking; yield deltaChunk({ reasoning_content: delta.thinking }); }
        if (delta.type === "signature_delta") block.signature = (block.signature || "") + delta.signature;
        if (delta.type === "input_json_delta") {
          argumentsByIndex.set(data.index, (argumentsByIndex.get(data.index) || "") + delta.partial_json);
          yield deltaChunk({ tool_calls: [{ index: data.index, function: { arguments: delta.partial_json } }] });
        }
      }
      if (data.type === "content_block_stop" && blocks[data.index]?.type === "tool_use") {
        const args = argumentsByIndex.get(data.index);
        blocks[data.index].input = args ? JSON.parse(args) : blocks[data.index].input || {};
        if (!args) yield deltaChunk({ tool_calls: [{ index: data.index, function: { arguments: JSON.stringify(blocks[data.index].input) } }] });
      }
      if (data.type === "message_delta") { usage = { ...usage, ...data.usage }; yield deltaChunk({}, data.delta?.stop_reason); }
      if (data.type === "message_stop") {
        finished = true;
        yield { usage: normalizeUsage(provider, usage), providerState: { provider, model: opts.model, content: blocks.filter(Boolean) } };
      }
    } else if (provider === "openai") {
      if (data.type === "response.output_text.delta") yield deltaChunk({ content: data.delta });
      if (data.type === "response.reasoning_summary_text.delta") yield deltaChunk({ reasoning_content: data.delta });
      if (data.type === "response.output_item.added" && data.item.type === "function_call") {
        callIndexes.set(data.output_index, data.item);
        argumentsByIndex.set(data.output_index, "");
        yield deltaChunk({ tool_calls: [{ index: data.output_index, id: data.item.call_id, type: "function", function: { name: data.item.name, arguments: "" } }] });
      }
      if (data.type === "response.function_call_arguments.delta") {
        argumentsByIndex.set(data.output_index, (argumentsByIndex.get(data.output_index) || "") + data.delta);
        yield deltaChunk({ tool_calls: [{ index: data.output_index, function: { arguments: data.delta } }] });
      }
      if (data.type === "response.output_item.done" && data.item.type === "function_call" && !argumentsByIndex.get(data.output_index)) {
        yield deltaChunk({ tool_calls: [{ index: data.output_index, ...(callIndexes.has(data.output_index) ? {} : { id: data.item.call_id, type: "function" }),
          function: { ...(callIndexes.has(data.output_index) ? {} : { name: data.item.name }), arguments: data.item.arguments } }] });
      }
      if (data.type === "response.incomplete") throw new Error(`OpenAI response incomplete: ${data.response?.incomplete_details?.reason || "unknown reason"}`);
      if (data.type === "response.completed") {
        finished = true;
        yield { ...deltaChunk({}, "stop"), usage: normalizeUsage(provider, data.response.usage), providerState: { provider, model: opts.model, output: data.response.output || [] } };
      }
    } else {
      if (data.done || data.choices?.[0]?.finish_reason) finished = true;
      if (!data.done) yield { ...data, ...(data.usage ? { usage: normalizeUsage(provider, data.usage) } : {}) };
    }
  }
  if (!finished) {
    const error = new Error("Provider stream ended before completion");
    error.code = "ECONNRESET";
    throw error;
  }
}
