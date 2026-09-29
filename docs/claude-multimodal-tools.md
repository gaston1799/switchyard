# Claude multimodal tools: contract design

> **Implementation reconciliation (Codex, 2026-09-21):** Switchyard now uses a
> `switchyard.multimodal.v1` result envelope and converts it to native provider
> image blocks. Image bytes remain in memory/session only until the immediately
> following model turn consumes them; they are then removed while path, MIME,
> size, and delivery metadata remain. This resolves the persistence concern
> identified in this review without requiring a separate byte cache. Anthropic's
> official tool-use documentation explicitly permits `image` blocks inside
> `tool_result.content`, so probe P1 is no longer blocking. The original Claude
> review follows unchanged as evidence of the installed CLI inspection.

Status: **design only**. No source change is proposed by this document being merged.
Phase: `claude_multimodal_contract`. Written 2026-09-21 against Switchyard `0.3.0`
(`package.json:3`) and Claude Code CLI `2.1.278`.

This file specifies the tool and result shapes Switchyard would need in order to (a) let a
model actually *see* a local image, and (b) expose image generation/editing — and it draws a
hard line between what is verified today and what is not.

---

## 0. Method and evidence base

Every "current state" claim below cites one of:

| Source | How it was obtained |
|---|---|
| Repository files | Read directly; cited as `path:line` |
| `claude --version` | `2.1.278 (Claude Code)` |
| `claude --help` | Full option/command listing |
| `claude auth status` | JSON status object (no model request) |
| `sdk-tools.d.ts` | `@anthropic-ai/claude-code@2.1.278` ships this file; it is the generated JSON-Schema-to-TypeScript dump of **every** CLI tool input and output schema (`sdk-tools.d.ts:1-10`). It is the authoritative machine-readable tool manifest for the installed CLI. |

No paid model request, no login, no image generation, and no write outside this file was
performed. The CLI binary itself is a single 237 MB native executable
(`@anthropic-ai/claude-code/bin/claude.exe`), so `sdk-tools.d.ts` — not string-scraping —
is the metadata of record.

> **Line numbers are anchored to commit `f4c1a9d`** ("Release Switchyard v0.3.0"), not to
> the working tree. During this analysis another process began modifying
> `src/deepseek-watch.js` and `src/provider-transport.js` and added an untracked
> `src/multimodal.js`; line numbers shifted underneath the read. Every citation below was
> re-verified against `git show f4c1a9d:<path>`. If the working tree has moved on, resolve
> citations with `git show f4c1a9d:src/deepseek-watch.js` rather than against `HEAD` of a
> later branch. `src/native-backends.js` and `src/native-chat.js` were unmodified, so their
> citations hold for both.

Labels used throughout:

- **VERIFIED** — established from a cited repo file or cited CLI output above.
- **VENDOR-DOCUMENTED** — part of the published Anthropic Messages API surface, but *not*
  exercised or verified anywhere in this repository or in this phase.
- **UNVERIFIED** — plausible but not established. Must be probed before it is relied on.
- **NOT PRESENT** — actively checked for and absent.

---

## 1. Current state

### 1.1 The API backend has two image tools, neither of which shows Claude an image

`toolSchemas()` (`src/deepseek-watch.js:1687`) registers exactly two image tools:

- `view_image` — schema at `src/deepseek-watch.js:1739-1755`, implementation
  `viewImage()` at `src/deepseek-watch.js:1392-1417`, dispatch at
  `src/deepseek-watch.js:4328-4330`.
- `analyze_image_openai` — schema at `src/deepseek-watch.js:1756-1775`, implementation
  `analyzeImageOpenAI()` at `src/deepseek-watch.js:1431-1480`, dispatch at
  `src/deepseek-watch.js:4332-4334`.

`viewImage()` returns a **JSON string**. It resolves the path inside the workspace, stats
it, derives a MIME type from the extension (`IMAGE_MIME_BY_EXT`,
`src/deepseek-watch.js:1331-1343`), parses dimensions from file headers for PNG/GIF/BMP/
WebP/SVG/JPEG (`imageDimensions()`, `src/deepseek-watch.js:1345-1390`), and — when the file
is under `max_bytes` — embeds a `data:` URL (`src/deepseek-watch.js:1411-1412`).

It hardcodes `vision_available: false` and carries a self-describing note
(`src/deepseek-watch.js:1407-1408`):

> "This tool does not visually interpret image content. Use analyze_image_openai for real
> image understanding when OPENAI_API_KEY is configured."

That note is accurate, and the reason is structural, not cosmetic — see §1.3.

`analyzeImageOpenAI()` is the only path in the repository that turns image bytes into model
perception. It posts to `https://api.openai.com/v1/responses` with an
`{ type: "input_image", image_url: <data URL> }` block (`src/deepseek-watch.js:1459-1467`),
defaults to `gpt-4.1-mini` or `$OPENAI_VISION_MODEL` (`src/deepseek-watch.js:1447`), and
returns **plain text** — the model's description — not JSON
(`src/deepseek-watch.js:1477-1479`).

Both are documented as read-only in `README.md:331-332` and steered by
`prompts/default-system.md:17-19`.

### 1.2 The native Claude backend exposes none of Switchyard's tools

`runNativeChat()` refuses to start if the caller asked for Switchyard tooling at all
(`src/native-chat.js:10`):

```
if (opts.agentId || opts.coordinatorId || opts.scopeFile || opts.allowedTargets?.length
    || opts.skills?.length || !opts.tools) throw new Error('Native backends use their own
    tools, skills and permissions. ...')
```

`ClaudeBackend.start()` (`src/native-backends.js:127-140`) spawns:

```
claude --print --verbose --input-format stream-json --output-format stream-json
       --include-partial-messages --permission-prompt-tool stdio
       [--resume <id>] [--model <m>] [--append-system-prompt <s>]
       --permission-mode <bypassPermissions|dontAsk|manual>
```

In `review` permission it additionally passes `--tools Read,Glob,Grep --strict-mcp-config`
(`src/native-backends.js:136`). So in native mode the tools are **Claude Code's own**;
`view_image` and `analyze_image_openai` are not in play. Switchyard is a transport and a
renderer there, not a tool provider.

Switchyard sends a user turn as a bare string (`src/native-backends.js:143`):

```js
this.rpc.send({ type: 'user', session_id: this.state.id || '',
                message: { role: 'user', content: text }, parent_tool_use_id: null });
```

`content` is a **string**, never a content-block array. This is the single most important
constraint for §4.

Tool results flowing back are flattened to a string before they reach the session
(`src/native-backends.js:183-185`, consumed at `src/native-chat.js:64-71`):

```js
if (block.type === 'tool_result') this.emit('tool', { id: block.tool_use_id, done: true,
  result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
  error: block.is_error });
```

A `Read` of an image therefore reaches Switchyard's UI/session as
`JSON.stringify(<blocks>)` — a base64 blob rendered as text. Claude Code itself still sees
the image correctly; only Switchyard's mirror of it is degraded.

### 1.3 The Anthropic API transport can only emit text and tool blocks

`src/provider-transport.js` is the one place that builds Anthropic Messages API bodies
(`buildProviderRequest()`, `src/provider-transport.js:72-112`; `protocol: "messages"`
selected by `src/providers.js:16-19`).

`anthropicMessages()` (`src/provider-transport.js:27-49`) can produce exactly three block
types:

| Block | Line |
|---|---|
| `{ type: "text", text }` | `src/provider-transport.js:38` |
| `{ type: "tool_use", id, name, input }` | `src/provider-transport.js:40` |
| `{ type: "tool_result", tool_use_id, content: <string> }` | `src/provider-transport.js:34` |

`contentText()` (`src/provider-transport.js:15-20`) stringifies anything non-string, and the
tool-result branch wraps it in `contentText(...)` unconditionally. Upstream, tool results are
already coerced (`String(execution.result)`, `src/deepseek-watch.js:5499`).

**This is why `view_image` cannot make Claude see anything today.** Its `data_url` is a
string field inside a JSON string inside a text `tool_result`. Claude receives the base64
as *text*, burns tokens on it, and cannot decode it. The `vision_available: false` flag is
honest.

### 1.4 Capability signalling today

`get_runtime_context` reports vision purely as an OpenAI-key question
(`src/deepseek-watch.js:391-392`):

```
openai_vision: configured | not_configured
openai_vision_model: <OPENAI_VISION_MODEL or gpt-4.1-mini>
```

`switchyard doctor` mirrors this (`src/deepseek-watch.js:3688-3695`). There is **no**
per-provider vision capability concept: an Anthropic-backed or GLM-backed session reports
`openai_vision: not_configured` and is told to go get an OpenAI key, even though the active
model may itself be vision-capable.

Permission gating is positional: schemas registered before `reviewSchemaCount`
(`src/deepseek-watch.js:2466`) survive `review` mode; the rest are filtered out
(`src/deepseek-watch.js:3029-3031`). Both image tools sit in the read-only prefix, so both
survive `review`.

---

## 2. Claude Code CLI vs Anthropic Messages API — capability split

This is the distinction the phase brief asks for. They are different products with
different surfaces.

### 2.1 Claude Code CLI 2.1.278 — verified from `sdk-tools.d.ts`

**Image *input* is supported, via `Read`.** `FileReadOutput` (`sdk-tools.d.ts:205`) is a
union, and one arm is the image arm (`sdk-tools.d.ts:242-279`):

```ts
| {
    type: "image";
    file: {
      base64: string;                                                  // sdk-tools.d.ts:248
      type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";   // sdk-tools.d.ts:252
      originalSize: number;
      dimensions?: { originalWidth?; originalHeight?;
                     displayWidth?; displayHeight? };                  // sdk-tools.d.ts:258-276
    };
  }
```

`FileReadInput` (`sdk-tools.d.ts:856-873`) takes only `file_path`, `offset`, `limit`, and
`pages` (PDF-only). There is **no** `view_image` tool and no image-specific input tool — the
CLI decides by file type. The MIME allow-list is exactly four types; note that this is
*narrower* than Switchyard's `IMAGE_MIME_BY_EXT`, which also admits `image/bmp` and
`image/svg+xml` (`src/deepseek-watch.js:1336-1338`).

Two adjacent image-bearing surfaces exist:

- `BashOutput.isImage?: boolean` — "Flag to indicate if stdout contains image data"
  (`sdk-tools.d.ts:3254-3256`).
- PDF reads return per-page images as image blocks in the model-facing `tool_result`, and
  the docs there state the page bytes are "not retained on the tool_use_result"
  (`sdk-tools.d.ts:331-347`) — a useful precedent for §5.3.

**Image *generation* is NOT PRESENT.** The complete tool manifest is the
`ToolInputSchemas` union (`sdk-tools.d.ts:11-55`) and `ToolOutputSchemas`
(`sdk-tools.d.ts:56-98`). Grepping the full file for `generate_image`, `image_gen`,
`createImage`, `text-to-image`, `dall`, `imagen` returns **zero matches**. `claude --help`
contains no image, vision, render, or generation flag. There is no CLI subcommand for it
(`claude --help` commands: `agents`, `attach`, `auth`, `auto-mode`, `doctor`, `gateway`,
`import`, `install`, `logs`, `mcp`, `plugin`, `project`, `respawn`, `rm`, `setup-token`,
`stop`, `ultrareview`, `update`).

Two tools are **opaque** and must not be read either way:

- `ClaudeDesignInput` (`sdk-tools.d.ts:2721-2732`) is a generic
  `{ operation: string, arguments: object }` dispatcher whose operations are
  "server-validated" and discovered by calling `operation: "list"` at runtime. Its output is
  `{ operation, content: object[], isError? }` (`sdk-tools.d.ts:4147-4153`). **UNVERIFIED**
  whether any of its operations produce images. Discovering that requires a live call, which
  this phase forbids. Do not assume either answer.
- `ArtifactInput` `upload_asset` accepts local image/video/PDF/font/CSS/JS files
  (`sdk-tools.d.ts:3136, 3184`). That is *upload*, not synthesis.

One flag is worth noting for §4: `--file <specs...>` takes `file_id:relative_path` pairs
(e.g. `--file file_def:img.png`) and downloads file resources at startup. This is a
**pre-session materialisation** mechanism keyed by an opaque `file_id`, not a way to attach
a local path to a turn.

### 2.2 Anthropic Messages API

- **Image input: VENDOR-DOCUMENTED.** The Messages API accepts
  `{"type":"image","source":{...}}` blocks in user content, with `source.type` of `base64`,
  `url`, or `file`. Switchyard emits none of these today (§1.3). This shape has **not** been
  verified against the live endpoint in this phase — no request was made.
- **Image blocks inside `tool_result` content: VENDOR-DOCUMENTED, unverified here.** The
  documented form is `tool_result.content` as an array that may contain image blocks. This
  is the mechanism §4 depends on, and it is the single highest-risk assumption in this
  document. **Probe it before implementing** (§8, P1).
- **Image generation: NOT PRESENT.** The Anthropic Messages API has no image-generation
  endpoint or server tool. `src/providers.js:16-19` points at
  `https://api.anthropic.com/v1` with `protocol: "messages"`; there is nothing else to call.

### 2.3 Summary table

| Capability | Claude Code CLI 2.1.278 | Anthropic Messages API | Switchyard today |
|---|---|---|---|
| See a local image | **VERIFIED** — `Read` → `type:"image"` | **VENDOR-DOCUMENTED** — `image` content block | **No.** Text only (`src/provider-transport.js:27-49`) |
| See an image in a tool result | **VERIFIED** — PDF page precedent (`sdk-tools.d.ts:331-347`) | **VENDOR-DOCUMENTED**, unverified | **No** (`src/provider-transport.js:34`) |
| Generate an image | **NOT PRESENT** | **NOT PRESENT** | **No** |
| Edit an image | **NOT PRESENT** | **NOT PRESENT** | **No** |
| Third-party vision fallback | n/a | n/a | **Yes** — OpenAI (`src/deepseek-watch.js:1431-1480`) |
| `ClaudeDesign` image operations | **UNVERIFIED** | n/a | n/a |

---

## 3. Design principles

1. **Never claim vision Switchyard cannot deliver.** A capability probe decides the tool
   surface; the model is told the truth in `get_runtime_context`.
2. **One tool name, several fulfilment strategies.** `view_image` keeps its name and its
   existing arguments remain valid, so saved sessions and `prompts/default-system.md`
   don't break. This follows `AGENTS.md`'s "prefer compatibility aliases rather than
   breaking existing prompts".
3. **Base64 never enters the session transcript.** Image bytes are attached at
   request-build time and referenced by handle in the persisted session. Session JSON
   holding a 4 MB data URL would wreck compaction and resume.
4. **Native mode stays hands-off.** In `--backend claude` the CLI owns the tools. Switchyard
   should improve how it *renders* image tool results, not inject tools
   (`src/native-chat.js:10`).
5. **Generation is provider-backed and off by default.** Since neither Claude surface can
   generate images (§2.3), `generate_image` must be an explicitly-configured third-party
   capability or it must not appear at all.

---

## 4. `view_image` — proposed contract

### 4.1 Input schema

Backwards compatible with `src/deepseek-watch.js:1744-1753`: `path` is still the only
required field, and `include_data_url` / `max_bytes` keep their meanings. `mode` is new and
defaults to the behaviour that is correct for the active provider.

```json
{
  "type": "function",
  "function": {
    "name": "view_image",
    "description": "Attach a workspace image to the conversation so the model can see it, when the active model supports vision; otherwise return metadata only. Check image_vision in the runtime context before relying on visual understanding. Read-only.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Workspace-relative image path."
        },
        "mode": {
          "type": "string",
          "enum": ["auto", "attach", "metadata"],
          "description": "auto (default): attach the image when the active model is vision-capable, else return metadata. attach: fail loudly if the model cannot see images. metadata: never attach."
        },
        "detail": {
          "type": "string",
          "enum": ["auto", "low", "high"],
          "description": "Requested fidelity hint. Advisory only; providers that ignore it are unaffected."
        },
        "include_data_url": {
          "type": "boolean",
          "description": "Legacy. Include a data:image/... base64 URL in the JSON result. Default false when the image is attached, true when it is not. Setting true alongside an attachment duplicates the bytes and is not recommended."
        },
        "max_bytes": {
          "type": "number",
          "description": "Maximum image bytes to attach or embed. Default 4000000, max 12000000."
        }
      },
      "required": ["path"],
      "additionalProperties": false
    }
  }
}
```

Note the default flip on `include_data_url`: today it defaults to `true`
(`src/deepseek-watch.js:1399`), which is right only because the data URL is the sole
delivery mechanism. Once real attachment exists, defaulting it to `true` would double the
token cost for zero gain.

### 4.2 Result shape — attached

The executor returns a **structured** result rather than a string. This requires the tool
dispatch path (`src/deepseek-watch.js:4328`) and the coercion at
`src/deepseek-watch.js:5499` to learn about non-string results; that is the main
implementation cost.

```json
{
  "text": "{\n  \"path\": \"docs/images/tui.png\",\n  \"mime\": \"image/png\",\n  \"size_bytes\": 182344,\n  \"dimensions\": { \"width\": 1280, \"height\": 720 },\n  \"attached\": true,\n  \"vision_available\": true,\n  \"vision_provider\": \"anthropic\",\n  \"attachment_id\": \"img_7f3a2c\"\n}",
  "attachments": [
    {
      "kind": "image",
      "id": "img_7f3a2c",
      "mime": "image/png",
      "bytes": 182344,
      "source_path": "docs/images/tui.png",
      "data_base64_ref": "sha256:9f2b...c41e"
    }
  ]
}
```

`data_base64_ref` is a content hash, not the bytes. Bytes live in an in-process,
session-scoped cache keyed by that hash; the persisted session stores only this record.
This mirrors the precedent in `sdk-tools.d.ts:331-347`, where Claude Code deliberately does
not retain PDF page bytes on the persisted tool result.

### 4.3 Result shape — not attached

Byte-identical in spirit to today's output, so nothing regresses when vision is
unavailable:

```json
{
  "path": "docs/images/tui.png",
  "mime": "image/png",
  "size_bytes": 182344,
  "dimensions": { "width": 1280, "height": 720 },
  "attached": false,
  "vision_available": false,
  "vision_provider": null,
  "reason": "active_model_not_vision_capable",
  "note": "This result does not let the model see the image. Use analyze_image_openai for real image understanding when OPENAI_API_KEY is configured.",
  "data_url_included": true,
  "data_url": "data:image/png;base64,iVBORw0KGgo..."
}
```

`reason` is a closed enum so the model can react instead of guessing:
`active_model_not_vision_capable`, `provider_transport_unsupported`,
`image_too_large`, `unsupported_mime`, `mode_metadata_requested`.

### 4.4 How a local path becomes image content

```
args.path
  → assertInsideWorkspace(path)                      [src/deepseek-watch.js:1393]
  → stat + isFile guard                              [src/deepseek-watch.js:1394-1395]
  → imageMime(path) from extension                   [src/deepseek-watch.js:1341-1343]
  → gate: mime ∈ provider's supported set  ─ no ─→   metadata result, reason=unsupported_mime
  → readFile → Buffer                                [src/deepseek-watch.js:1400]
  → imageDimensions(buffer, mime)                    [src/deepseek-watch.js:1345-1390]
  → gate: buffer.length ≤ max_bytes        ─ no ─→   metadata result, reason=image_too_large
  → sha256(buffer) → attachment_id, cache.put(hash, buffer)
  → tool result = { text, attachments:[…] }
  → request builder rehydrates the bytes per provider  ← the only place base64 is produced
```

The final step is provider-specific and belongs in `src/provider-transport.js`, next to
`anthropicMessages()` (`src/provider-transport.js:27`):

**Anthropic** — extend the `tool_result` branch (`src/provider-transport.js:34`) so
`content` becomes an array when attachments are present. VENDOR-DOCUMENTED shape; probe
first (§8, P1):

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01A",
  "content": [
    { "type": "text", "text": "{\"path\":\"docs/images/tui.png\",\"attached\":true}" },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBORw0KGgoAAAANSUhEUg..."
      }
    }
  ]
}
```

Two hard constraints follow from §1.3 and must be preserved: tool results still have to
immediately follow their `tool_use` block in a single user message
(`src/provider-transport.js:44-46`), and `nativeState()` replay
(`src/provider-transport.js:22-25, 35-37`) must not clobber a rehydrated attachment.

**OpenAI (`protocol: "responses"`)** — `responseInput()`
(`src/provider-transport.js:51-70`) emits `function_call_output` with a plain string
`output`. The Responses API's `input_image` block is a *user message* block, not a
function-output block. So the attachment has to be appended as a following user message:

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "Image attached by view_image: docs/images/tui.png" },
    { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo..." }
  ]
}
```

That `input_image` shape is already proven in this repo at
`src/deepseek-watch.js:1459-1467`, which is the strongest evidence available for any
attachment shape in this document.

**DeepSeek / GLM (`chat/completions`)** — the OpenAI-compatible branch
(`src/provider-transport.js:100-110`) passes `m.content` through verbatim, so a
`[{type:"text"},{type:"image_url"}]` array would survive the builder. Whether the selected
model accepts it is a per-model question the capability table (§6) must answer, not
something to assume. `deepseek-v4-flash-vision-exp` appears in the context table
(`src/providers.js:109`) but its vision behaviour is **UNVERIFIED** here.

### 4.5 Native `--backend claude`

No new tool. Claude Code's own `Read` already returns
`{ type: "image", file: { base64, type, originalSize, dimensions } }`
(`sdk-tools.d.ts:242-279`) and the model sees it correctly. What Switchyard should fix is
its own mirror: `src/native-backends.js:184` currently does
`JSON.stringify(block.content)`, which dumps a megabyte of base64 into the TUI and the
session file. Proposed handling in §7.

---

## 5. `generate_image` — proposed contract

### 5.1 The honest position

Per §2.3: **no verified image-generation capability exists in Claude Code 2.1.278 or in the
Anthropic Messages API.** Grep over the full installed tool manifest returns zero matches,
and `claude --help` has no such flag or command. Therefore:

> Switchyard must not present `generate_image` as a Claude capability, and must not
> register the tool at all unless a non-Anthropic image backend is explicitly configured.

The only residual unknown is `ClaudeDesign` (`sdk-tools.d.ts:2721-2732`), whose operation
list is server-side. If a future probe (§8, P3) finds an image operation there, it would be
reachable only in **native** mode and only through Claude Code's own tool — never through
`src/provider-transport.js`. That would not change this schema; it would add a row to §6.

The schema below is therefore specified for a **third-party backend**, registered
conditionally, so that the work is ready if and when a key is configured.

### 5.2 Input schema

```json
{
  "type": "function",
  "function": {
    "name": "generate_image",
    "description": "Generate or edit an image with a configured third-party image model and write it into the workspace. Not a Claude capability: requires an image backend to be configured. Returns the written path, never raw bytes. Writes a file.",
    "parameters": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "What the image should depict. Be specific about composition, style, and any text that must appear."
        },
        "output_path": {
          "type": "string",
          "description": "Workspace-relative path to write, including extension. The extension selects the output format."
        },
        "edit_source_path": {
          "type": "string",
          "description": "Workspace-relative image to edit instead of generating from scratch. Omit for text-to-image."
        },
        "mask_path": {
          "type": "string",
          "description": "Workspace-relative mask image for inpainting. Only valid with edit_source_path."
        },
        "size": {
          "type": "string",
          "description": "Requested output size, e.g. '1024x1024'. Backend-dependent; the result reports what was actually produced."
        },
        "backend": {
          "type": "string",
          "description": "Image backend id. Defaults to the single configured backend, and is required when more than one is configured."
        },
        "model": {
          "type": "string",
          "description": "Backend-specific model id. Defaults to the backend's configured default."
        },
        "overwrite": {
          "type": "boolean",
          "description": "Allow overwriting an existing file at output_path. Default false."
        },
        "timeout_ms": {
          "type": "number",
          "description": "Request timeout. Default 120000, max 300000."
        }
      },
      "required": ["prompt", "output_path"],
      "additionalProperties": false
    }
  }
}
```

### 5.3 Result shape

Path-out, never bytes-out. The model can then call `view_image` if it needs to see the
result — which keeps exactly one code path responsible for attachment (§4.4) and follows
the `sdk-tools.d.ts:331-347` precedent of not retaining image bytes on a persisted result.

```json
{
  "output_path": "docs/images/generated/hero.png",
  "mime": "image/png",
  "size_bytes": 884213,
  "dimensions": { "width": 1024, "height": 1024 },
  "backend": "openai",
  "model": "<configured-image-model>",
  "operation": "generate",
  "revised_prompt": null,
  "overwritten": false,
  "note": "Image written to the workspace. Call view_image on output_path to look at it."
}
```

Error result — the shape returned when the tool is reachable but unusable, rather than a
thrown string, so the model can recover:

```json
{
  "error": "no_image_backend_configured",
  "message": "generate_image has no configured backend. Neither Claude Code nor the Anthropic Messages API can generate images; configure a third-party image backend to enable this tool.",
  "configured_backends": []
}
```

### 5.4 Permission

`generate_image` writes a file and spends money. It must sit **after** `reviewSchemaCount`
(`src/deepseek-watch.js:2466`) so `review` mode filters it out
(`src/deepseek-watch.js:3029-3031`), and it must be subject to the usual write
confirmation in `ask` mode. It is not a read-only tool and must not be listed in the
read-only table at `README.md:323-376`.

---

## 6. Capability gating rules

### 6.1 The capability record

A single resolver answers "can the active model see an image, and how?". Proposed shape,
computed once per turn from `opts.backend`, `opts.provider`, `opts.model`:

```json
{
  "image_input": "attach",
  "vision_provider": "anthropic",
  "attach_channel": "tool_result_blocks",
  "supported_mime": ["image/jpeg", "image/png", "image/gif", "image/webp"],
  "max_attach_bytes": 4000000,
  "image_generation": "unavailable",
  "fallback": "openai_vision",
  "source": "static_table"
}
```

- `image_input`: `attach` | `metadata_only`
- `attach_channel`: `tool_result_blocks` (Anthropic) | `followup_user_message` (OpenAI
  Responses) | `inline_content_array` (chat/completions) | `none`
- `source`: `static_table` | `probe` | `user_override` — so a wrong table entry is
  attributable.

### 6.2 Decision table

| Backend / provider | `image_input` | `attach_channel` | `generate_image` registered? |
|---|---|---|---|
| `--backend claude` (native) | n/a — CLI owns tools | n/a | **No** |
| `--backend codex` (native) | n/a — CLI owns tools | n/a | **No** |
| `api` + `anthropic`, vision model | `attach` | `tool_result_blocks` | Only if third-party backend configured |
| `api` + `openai`, vision model | `attach` | `followup_user_message` | Only if third-party backend configured |
| `api` + `deepseek` / `glm` | `metadata_only` until per-model vision is **verified** | `inline_content_array` once verified | Only if third-party backend configured |
| Any provider, non-vision model | `metadata_only` | `none` | unchanged |

### 6.3 Gating rules

1. **Conservative default.** An unrecognised model gets `metadata_only`. This matches the
   reasoning already written into `src/providers.js:132-138`: guessing a capability high is
   the dangerous direction. A wrongly-optimistic vision flag produces a hard API rejection
   mid-turn; a wrongly-pessimistic one costs a fallback call.
2. **Static table, not runtime probing.** Vision capability is not discoverable from
   `/models` — `fetchProviderModels()` (`src/providers.js:167-195`) returns ids only, and
   `src/providers.js:37-62` documents at length why capability tables must be hardcoded.
   Same logic, same file, ideally the same table.
3. **`mode: "attach"` fails loudly.** If the model explicitly asked to attach and the
   capability record says `metadata_only`, return an error naming the reason rather than
   silently degrading. Silent degradation is how a model ends up confidently describing an
   image it never saw.
4. **MIME intersection.** Switchyard's extension map admits `image/bmp` and `image/svg+xml`
   (`src/deepseek-watch.js:1336-1338`); Claude Code's image arm admits only four types
   (`sdk-tools.d.ts:252`). Attachment must use the intersection with the provider's set,
   and return `reason: "unsupported_mime"` otherwise. Metadata and dimension parsing keep
   working for all seven types — `imageDimensions()` already handles BMP and SVG
   (`src/deepseek-watch.js:1352-1374`) and that should not be lost.
5. **Size ceiling is a capability, not a preference.** `max_attach_bytes` comes from the
   capability record and clamps `max_bytes`, so a model cannot argue its way past a provider
   limit by passing a larger number.
6. **Runtime context tells the truth.** Replace the OpenAI-only lines at
   `src/deepseek-watch.js:391-392` with provider-aware ones:

   ```
   image_vision: attach | metadata_only
   image_vision_provider: anthropic | openai | deepseek | glm | none
   image_generation: unavailable | <backend-id>
   openai_vision_fallback: configured | not_configured
   openai_vision_model: <model>
   ```

   `prompts/default-system.md:17-19` must be rewritten against these names; per `AGENTS.md`,
   `README.md` and `prompts/default-system.md` are updated whenever a model-visible tool
   changes.

---

## 7. Events and results Switchyard must handle

### 7.1 API backend

| Event | Where | Change |
|---|---|---|
| Tool returns a structured `{ text, attachments }` | `src/deepseek-watch.js:4328` dispatch; `src/deepseek-watch.js:5499` result push | Coercion is `String(execution.result)` today. Must preserve attachments on the session message and persist only the hash record (§4.2). |
| Request build with attachments | `src/provider-transport.js:34` (Anthropic), `:60` (OpenAI), `:103` (compat) | Rehydrate bytes from the cache; keep the tool_use/tool_result adjacency rule at `src/provider-transport.js:44-46`. |
| Compaction | `src/context-compactor.js` | Attachment records must be droppable — an image from 20 turns ago is dead weight. Compaction must not try to summarise base64, and must not resurrect evicted bytes. |
| Resume | `repairToolCallHistory()`, `src/deepseek-watch.js:4885-4931` | After a restart the byte cache is empty. A replayed attachment must degrade to its metadata record with an explicit note, not a dangling reference or a fabricated block. |
| Provider rejects the image | `src/provider-transport.js:185-189` | An oversize/unsupported-format rejection should surface as a named tool-level failure the model can retry against with `mode: "metadata"`, not an opaque stream error. |

### 7.2 Native backend

| Event | Where | Change |
|---|---|---|
| `tool_result` containing image blocks | `src/native-backends.js:183-185` | Stop `JSON.stringify`-ing image blocks. Summarise as e.g. `[image image/png 1280x720, 182 KB]` and keep the text blocks verbatim. Prevents megabytes of base64 in the TUI and in the session JSON written at `src/native-chat.js:68`. |
| `Read` tool_use on an image path | `src/native-backends.js:180` | Surface as an image read in the tool card so the operator sees what the model looked at. |
| `BashOutput.isImage` | `sdk-tools.d.ts:3254-3256` | Same treatment — do not dump image stdout as text. |
| `--file file_id:path` | `claude --help` | **UNVERIFIED** how `file_id`s are minted. Not a path-attachment mechanism; do not build on it without a probe. |
| `ClaudeDesign` results | `sdk-tools.d.ts:4147-4153` | `content` is `object[]`; if any element is an image block, apply the same summarisation. Whether that ever happens is **UNVERIFIED**. |

### 7.3 Fallback to OpenAI vision

Unchanged in mechanism — `analyzeImageOpenAI()` (`src/deepseek-watch.js:1431-1480`) stays
exactly as it is. What changes is when it is recommended:

1. `view_image` with `mode: "auto"` on a vision-capable model → attach. No fallback, no
   second API call, no second bill.
2. `view_image` on a non-vision model, with `OPENAI_API_KEY` set → metadata result whose
   `note` points at `analyze_image_openai`. This is today's behaviour
   (`src/deepseek-watch.js:1408`) and stays correct.
3. `view_image` on a non-vision model, no `OPENAI_API_KEY` → metadata result, `note` says
   no visual understanding is available anywhere in this session and gives the setup
   instruction already encoded in `prompts/default-system.md:19`.
4. `analyze_image_openai` remains callable regardless of the active provider. It is a
   deliberate cross-provider escape hatch and should not be gated behind the capability
   record.

The fallback must never be **automatic**. Silently spending OpenAI credit because the
active Anthropic model could not see an image is a billing surprise; the model asks for it
explicitly or it does not happen.

---

## 8. Probes required before implementation

None of these were run in this phase — each needs a live request, which the phase forbids.

- **P1 — Anthropic image-in-`tool_result` (blocking).** Minimal Messages API call with an
  `image` block inside `tool_result.content`. §4.4's Anthropic path is built entirely on
  this being accepted. If it is rejected, the fallback design is a following user message
  carrying the image, as in the OpenAI path.
- **P2 — Anthropic per-model vision.** Which `claude-*` ids accept image blocks. Feeds §6.2.
- **P3 — `ClaudeDesign` operation list.** One native-mode call with
  `{"operation":"list","arguments":{}}` resolves §2.1's only open question about native
  image generation. Read-only and cheap.
- **P4 — DeepSeek / GLM vision.** Whether `deepseek-v4-flash-vision-exp`
  (`src/providers.js:109`) and the GLM catalog accept `image_url` content parts. Until
  answered, §6.2 keeps them `metadata_only`.
- **P5 — Claude Code image size/resize thresholds.** `sdk-tools.d.ts:258-276` distinguishes
  `originalWidth/Height` from `displayWidth/Height`, implying a resize step whose thresholds
  are not published. Only affects how Switchyard *reports* native reads.

---

## 9. Non-goals

- Injecting Switchyard tools into native `--backend claude` sessions
  (`src/native-chat.js:10` exists on purpose).
- Automatic provider switching to reach a vision model.
- Video, audio, or PDF page extraction. PDFs are a separate contract; Claude Code already
  has one (`sdk-tools.d.ts:293-351`) and Switchyard has nothing.
- Any image-generation implementation before a backend is actually configured. §5 is a
  contract, not a commitment.

---

## 10. Concurrent implementation in the working tree

While this analysis ran, another process added an untracked `src/multimodal.js` and began
modifying `src/deepseek-watch.js` and `src/provider-transport.js` (see the note in §0). That
work is **not** part of this design phase and was not authored here, but it overlaps
directly and should be reconciled rather than duplicated.

Read-only observations from `src/multimodal.js` as of this writing:

- It defines a `modelCapabilities(provider, model)` resolver returning `{ vision,
  imageGeneration }`, driven by per-provider regexes over the model id. This is the same
  idea as §6.1, resolved from a pattern table rather than the explicit static map §6.3.2
  argues for.
- It defines a `MULTIMODAL_RESULT = 'switchyard.multimodal.v1'` envelope,
  `{ type, text, images: [{ type, data, mimeType, path }], files }`, which serves the same
  role as §4.2's `{ text, attachments }`. **Differs on one substantive point:** it carries
  base64 `data` inline on the result object, where §4.2 deliberately carries a content-hash
  reference so image bytes never enter the persisted session (§3.3). Whichever shape wins,
  the persistence and compaction questions in §7.1 still have to be answered.
- Its comment records the same conclusion this document reaches independently: Claude
  "accepts image input but does not expose an equivalent Anthropic Messages API image-output
  tool", and generation is gated to OpenAI's Responses `image_generation` tool. That agrees
  with §2.3 and with §5.1's requirement that generation be third-party and explicitly
  configured.

The open items that concurrent work does not appear to settle, and which §8 still gates:
probe P1 (image blocks inside an Anthropic `tool_result`), P3 (`ClaudeDesign` operation
list), and P4 (DeepSeek/GLM vision) — note that `src/multimodal.js` currently *infers*
DeepSeek and GLM vision from substrings in the model id (`vision`, `vl`, `ocr`), which is
exactly the optimistic-guess direction `src/providers.js:132-138` warns against.
