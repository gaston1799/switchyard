# Provider support

Switchyard is the working name of the harness. The package, command aliases, and
saved configuration paths retain their existing names for compatibility.

| Provider | CLI value | Default model | API |
| --- | --- | --- | --- |
| DeepSeek | `deepseek` | `deepseek-v4-flash` | Chat Completions |
| Z.AI GLM | `glm` | `glm-4.7` | Chat Completions |
| Anthropic Claude | `anthropic` (`claude` alias) | `claude-sonnet-4-6` | Messages |
| OpenAI GPT | `openai` (`gpt` alias) | `gpt-5` | Responses |

These are explicit defaults, not claims about the latest model or account access.
Use `--model` to select another model available to your API key. Model catalogs are
discovered from the provider, including Claude pagination. Catalog failure is
nonfatal. Context limits come from the local model table; unknown models use a
131,072-token estimate with a warning. For such models, set `--compact-limit` to
the actual documented context window, especially if it is smaller. Context limits come from the local model table, VERIFIED against vendor docs on
2026-09-21. Claude Fable 5.1, Fable 5, Opus 5, Opus 4.8/4.7/4.6, Sonnet 5 and
Sonnet 4.6 are 1M by default with no beta header; Sonnet 4.5, Opus 4.5 and Haiku
4.5 are 200K. The GPT-5 family is 400K (gpt-5-chat-latest is 128K), GPT-4.1 is
1,047,576, GPT-4o is 128K and the o-series is 200K. An earlier note here called
200K a "conservative baseline" for the Claude 4.6 entries -- that reflected an
older beta-header regime and was discarding 800K of usable context.

Anthropic is the one provider that exposes this at runtime: its Models API
returns `max_input_tokens` per model, so that table could be replaced by a live
read. OpenAI, DeepSeek and Z.AI return only id/object/created/owned_by, and
OpenAI's overflow error names no figure, so for those the table is the only
place the truth can live.

## Configuration

Use `dsw config set-key`, `set-glm-key`, `set-anthropic-key` (or `set-claude-key`),
and `set-openai-key`. Keys are saved in the existing config file. Environment
variables take precedence: `DEEPSEEK_API_KEY`, `GLM_API_KEY`, `ANTHROPIC_API_KEY`,
and `OPENAI_API_KEY`. The saved OpenAI key also works for the image analysis tool.

## Multimodal tools

Switchyard gates image tools from the active provider/model name. A known
vision-capable model receives `view_image`, whose canonical result contains image
bytes and metadata rather than base64 disguised as text. The transport converts
that result into OpenAI `input_image`, Anthropic base64 image content, or a
compatible chat image message. A text-only model receives
`analyze_image_openai`, which returns text from a separate OpenAI vision request.

OpenAI mainline GPT models also receive `generate_image`. Other models receive
`generate_image_openai`; Claude can therefore see the generated image in its next
turn even though generation itself is performed by OpenAI. Codex-specialized GPT
models use the fallback because OpenAI documents the Responses image-generation
tool for supported mainline models. Unknown model families default to text-only
until their multimodal request format is verified.

Native Codex and Claude Code connections are separate: their CLI owns the tool
loop. Switchyard does not inject these API-backend tools into native sessions.
The installed Claude Code manifest confirms image input through its `Read` tool
and exposes no native image-generation tool; see `docs/claude-multimodal-tools.md`.

`DSW_PROVIDER`, `DSW_MODEL`, and `DSW_BASE_URL` supply defaults. Each provider also
accepts `<PROVIDER>_MODEL` and `<PROVIDER>_BASE_URL`, using canonical names such as
`ANTHROPIC_MODEL`. Explicit CLI model/endpoint flags override defaults.
OpenAI and Anthropic base URLs include `/v1`.

```powershell
d --provider claude -p "Read the project and explain its architecture"
d --provider gpt --model gpt-5 -p "Review the recent diff"
dsd --provider openai -p "Summarize this task" --output result.md --no-fallback
```

The Electron UI inherits `DSW_PROVIDER` and other environment defaults; resuming
an existing session restores its saved provider. `--provider` explicitly switches
providers on CLI resume, resetting the default model and endpoint for that provider.
No provider subscription login is implemented; these adapters use API keys.

## Caching, tools, and reasoning

The canonical session keeps the existing chat-style roles and tool-call IDs.
`src/provider-transport.js` translates them to each provider's requests. It also
preserves Claude signed thinking/content blocks and OpenAI response items, including
encrypted reasoning, for replay to the same provider and model. Those opaque items
are not forwarded to other providers or models.

Claude requests enable automatic caching with top-level `cache_control`. OpenAI
requests use default automatic caching and a stable hashed per-session routing key.
DeepSeek and GLM retain their implicit caching behavior. Cache hits depend on provider
eligibility and matching prefixes; they are not guaranteed. Tools and instructions
remain ordered consistently. Compaction changes the summarized prefix, so the next
request may rebuild its history cache.

The terminal reports input, cached input, cache writes, and output tokens where the
provider supplies them. Usage is saved with each completed assistant response.
OpenAI requests use `store: false` and send the explicit active context, so a server
conversation chain cannot bring a removed prefix back into context.

`--thinking enabled` maps to Claude adaptive thinking on 4.6/newer named families
and a bounded thinking budget on older Claude models. GPT reasoning models use
`reasoning.effort`; the existing `max` setting maps to `high` for compatibility.
Summary requests omit Claude thinking and use minimal/no reasoning as supported on
GPT. Thinking is never sent as a DeepSeek-shaped field to Claude or GPT.

## Compaction

`src/conversation-turns.js` groups assistant calls and all matching tool results.
`src/context-compactor.js` retains 15 completed groups plus the unfinished group,
replaces the earlier prefix, and checks the final request estimate before mutation.
Saved sessions are written through a temporary file and rename. Folded raw history
is replaced, not archived automatically.

The summary request has no workspace tools and has its own bounded prompt, output
budget, timeout, and retries. It uses the active provider/model by default.
`--compact-provider`, `--compact-model`, and `--compact-base-url` select an independent
summarizer. Selecting a different provider resets its default endpoint/model and
uses its own key. Inline, detached, and coordination-triggered compaction all use
these rules. The audit records actual post-compaction estimates and retained turns.

## Verification

Run `npm run check`, `npm run test:providers`, and `npm run test:compaction`.
Provider tests use mocked streams and local HTTP servers, including tool execution,
saved-session resume, and detached completions. Compaction checks exercise prefix
replacement, whole tool batches, independent summary requests, persistence, bounded
failures, and detached provider propagation. They do not assert live API access or
real cache hits.

Protocol references:

- [OpenAI Responses function calls](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude Messages API](https://platform.claude.com/docs/en/api/beta/messages/create)
- [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
