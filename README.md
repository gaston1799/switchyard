# Switchyard — coding-agent harness

> A local coding-agent harness for DeepSeek, GLM, Claude, and GPT. Streams responses, calls workspace tools, resumes sessions, and coordinates detached agents.

`switchyard` is the main command. `d`, `dsw`, and `ds` remain interactive aliases; `dsd` and `dswait` remain available. Existing configuration and session paths are preserved. The npm package identifier remains `deepseek-detached-agent`.

[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey)]()

---

## Features

- **Extended thinking** — streams DeepSeek's reasoning chain live as it works
- **File tools** — read by line range, write new files, patch existing ones
- **Web search** — search current external information from the agent loop
- **Shell tools** — run `cmd.exe` and PowerShell with per-session permission controls
- **Session memory** — every conversation is saved; resume any previous session
- **Multi-agent coordination** — stable IDs, durable peer messages, task claims, handoffs, and parked wait/wake sessions
- **Electron UI** — launch `d -ui` for a desktop chat surface with a local control API and CDP port
- **Unlimited tool turns** — no cap on how many tool-call loops it can make
- **Detached mode** — fire a prompt in the background and poll for the output file
- **Claude fallback** — `dsd` falls back to `claude -p` if DeepSeek is unavailable
- **Dependency-light CLI** — core agent tools use built-in Node APIs; Electron is used only for `d -ui`
- **OpenAI-compatible** — point at any compatible endpoint via `--base-url`
- **Provider adapters** — DeepSeek/GLM chat completions, Claude Messages, and GPT Responses; use `--provider deepseek|glm|anthropic|openai`. `claude` and `gpt` are accepted aliases.
- **Automatic prompt caching** — Claude automatic cache control, implicit caching on the other providers, and normalized input/cache-read/cache-write/output usage.
- **Automatic context compaction** — provider/model budgets, a replaced prefix summary, 15 complete tool-safe turns, and bounded deterministic fallback.

### Model picker pricing

The startup and `/model` API pickers show USD per million input, cached-input,
and output text tokens, with cache-write rates where applicable. Known prices sort
by an example of 10,000 uncached input + 1,000 output tokens; this is a comparison,
not a budget cap or prediction of total agent cost. Tool schemas, history, reasoning,
and repeated requests add tokens. Tool fees, long-context premiums, and other billing
modifiers can add cost. DeepSeek shows peak reference rates (off-peak is half).

The bundled reference table was checked **2026-09-21**, and is not fetched live.
Unverified IDs (including snapshots without a verified entry) show **Price unknown**.
Custom endpoints show vendor reference prices only. Codex/Claude Code account
connections show plan/usage-limit labels and preserve provider credit notices.
Sources: [OpenAI](https://developers.openai.com/api/docs/pricing) and its individual
model pages, [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing),
[Z.AI](https://docs.z.ai/guides/overview/pricing), and
[DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/).

---

## Context compaction

Before model requests, the harness estimates messages, provider state, tool definitions,
and the reserved completion budget. At 90% of the available input budget it replaces
the older prefix with one summary. Both in-memory context and the atomically saved
session contain the replacement; folded raw messages are not retained in that file.

- **Keep 15 complete turns:** a turn is one assistant response plus every matching
  tool result, together with preceding user input. Parallel calls are kept together.
  Any active, unfinished turn is also retained. This works during a single long task.
- **Preserve recent content:** the retained tail and provider-specific reasoning
  state stay verbatim. System instructions remain at the front. Repeated compaction
  replaces the earlier summary instead of adding another summary to the prefix.
- **Separate summary request:** the compactor uses its own prompt and output budget,
  disables tools, and uses the selected provider's wire format. It defaults to the
  session provider/model; overrides can select a separate summarizer.
- **Bounded fallback:** `auto` and `llm` attempt at most two summary requests, each
  with a 30-second timeout. Missing credentials, empty/oversized summaries, timeouts,
  and exhausted retries fall back to a deterministic roll-up. `truncate` skips the API.
- **Budget errors are explicit:** if the 15 retained turns plus the active turn cannot
  fit, compaction stops without changing the session. Choose a larger supported
  context window or explicitly lower `--compact-keep-recent`; no tool pair is split.
- **Audit:** `session.compactions[]` records folded/retained turns and messages,
  summary provider/model, method, and measured post-compaction estimates.

```powershell
d --provider anthropic -p "Inspect this repository"
d --provider openai --model gpt-5 -p "Inspect this repository"
d --provider deepseek --compact-provider openai --compact-model gpt-5 -p "Work on the task"
```

Options: `--compact-at <fraction>` (0.9), `--compact-keep-recent <turns>` (15),
`--compact-limit <tokens|auto>`, `--compact-method <auto|llm|truncate|detached|off>`,
`--compact-provider`, `--compact-model`, and `--compact-base-url`.
`--no-compact` disables automatic compaction. `detached` uses the same provider-aware
compactor in a child process. Recent-turn semantics apply to all methods.

`DSW_COMPACT_KEEP_RECENT`, `DSW_COMPACT_PROVIDER`, `DSW_COMPACT_MODEL`, and
`DSW_COMPACT_BASE_URL` configure these defaults. Existing `DEEPSEEK_COMPACT_*`
and `DEEPSEEK_CONTEXT_LIMIT` settings still work. Existing keep-recent settings
now count complete turns, rather than individual messages.

To compact a saved session into a separate result file:

```powershell
node scripts/compact-session.mjs .deepseek-watch/sessions/<file>.json --method auto
```

The CLI inherits the session provider, model, and endpoint. See
[provider support](docs/providers.md) for configuration, protocols, and limits.

**Coordination-level compaction** — agents get two extra tools:
- `compact_session` — an agent compacts *its own* session on demand (`force: true` even below the auto threshold).
- `agent_compact <agent_id>` — the coordinator (or any agent) compacts another agent: if the target is **live** it receives an inbox `compact` request it applies mechanically on its next wake/turn and replies with the result (deterministic, no LLM involvement in the mechanics); if the target is **stopped/failed** its session file is compacted directly (with a `.compact-bak`) so its next launch resumes compacted.

---

## Install

### Windows — one-liner

```powershell
irm https://raw.githubusercontent.com/gaston1799/switchyard/master/install.ps1 | iex
```

Or download [`install.bat`](install.bat) and double-click it.

The installer checks for **Git** and **Node.js ≥ 18**, installs any missing deps via `winget`, refreshes `PATH`, clones the repo, then runs `npm install -g`.

### Manual

```bash
git clone https://github.com/gaston1799/switchyard
cd switchyard
npm install -g .
```

---

## Quick start

```bash
# Save your API key once
switchyard config set-key sk-xxxxxxxxxxxxxxxx

# Ask a question
switchyard -p "explain this codebase"

# Open the TUI dashboard (no args)
switchyard

# Open the Electron desktop UI
d -ui

# Resume a previous session
switchyard --resume
```

---

## Startup and local commands

Run `switchyard` with no arguments. The styled startup screens guide you through:

1. **New run** (option 1), **Resume session** (option 2), or agent messages.
2. **Connection**: ChatGPT/Codex login, Claude Code login, or a provider API key.
3. **Model**: a live catalog from that connection, including model descriptions.
4. **Permissions**, then the chat input. No separate initial `Prompt>` is needed.

Use arrows and Enter, type a number, or type to filter. Page Up/Down navigates
long lists; Escape goes back. Model catalogs reflect the provider/CLI response,
not a guarantee of entitlement. If discovery fails, the picker labels the error
and offers manual model entry instead of inventing an available-model list.
Sign-in uses the existing `switchyard login codex|claude` commands; API keys use
`switchyard config set-<provider>-key` (`set-key` for DeepSeek).

Type `/` for command hints; Tab completes a command. These are handled locally:

| Command | Action |
| --- | --- |
| `/commands`, `/help` | Show local commands |
| `/model` | Open the model picker for this connection |
| `/model <id>` | Select a model directly |
| `/provider` | Switch an API session to another API provider and model |
| `/usage` | Show token usage or native account limits when available |
| `/session` | Show the session location and connection |
| `/exit` | Save and quit |

Commands entered during a response are queued and processed after the current
turn/task. Unknown slash commands show help and are not sent to a model.

**Sessions belong to conversations, not individual models.** API sessions retain
messages and tool-call/result pairs when switching between DeepSeek, GLM, OpenAI,
and Anthropic. Provider-specific reasoning state is discarded on a switch and
the context budget is recalculated. Switching API provider sends the saved
conversation to that provider. Resume offers a saved-model option, a new model,
and (for API sessions) a new API provider.

Codex sessions can change Codex models; Claude Code sessions can change Claude
models. Their native conversation IDs and tool histories are engine-specific:
crossing between native engines, or between native and API, requires a new
session with an explicit context handoff. Automatic cross-engine handoff is not
implemented yet; the original native session remains with its engine.

## ChatGPT and Claude subscription connections

Use your installed, signed-in Codex or Claude Code CLI as the execution backend:

```powershell
switchyard --backend codex --tui
switchyard --backend claude --tui
```

The dashboard also offers these connections when starting a new run. If needed:

```powershell
switchyard login codex
switchyard login claude
switchyard auth codex
switchyard auth claude
```

These commands delegate login to the official CLI. Switchyard does not copy its
credentials. Subscription backends remove inherited API-key/proxy variables from
the child environment and check the native account login before starting work.
API-key billing remains available through `--backend api --provider openai` or
`--backend api --provider anthropic`; there is no automatic billing fallback.

- The native engine owns tools, instruction discovery, context compaction, and
  provider caching. Switchyard's API tools, agent coordination, custom scope,
  and compactor flags do not configure those engines.
- `--permission ask` routes native approval requests into the TUI. Codex starts
  in its read-only sandbox with untrusted-command approvals; Claude uses Manual
  mode and its existing rules. `review` uses Codex's read-only sandbox with no
  approvals, or Claude's Read/Glob/Grep tools with no MCP tools. `full` explicitly
  selects native unrestricted execution, subject to managed CLI policies.
- The TUI streams replies and tool activity. Escape interrupts generation.
  Enter queues a follow-up. Native sessions open straight into the input box.
- `/model` opens the connection model picker; `/model <name>` changes it for later turns.
  Without `--model`, each CLI chooses its configured default.
- Codex allowance and reset times appear in the status row; `/usage` refreshes
  them. Claude reports rate-limit events but this integration does not fetch a
  remaining subscription quota or dollar balance.
- Switchyard saves a transcript plus the native conversation ID. `switchyard
  --resume` restores the matching backend; keep the native CLI's session files.
  API sessions and native sessions cannot be converted by switching backends.
  Resume from the original workspace. `--no-save-session` disables Switchyard's
  copy, not the native CLI's own history.
- `--timeout` also bounds each native turn. Interrupted/failed turns are saved;
  model requests are not automatically retried, to avoid repeating tool actions.

Requires an installed Codex app-server CLI or Claude Code with bidirectional
stream-json support. Verified here with Codex 0.150.1 and Claude Code 2.1.278.
For nonstandard installations, set `SWITCHYARD_CODEX_CLI` or
`SWITCHYARD_CLAUDE_CLI` to an executable or JavaScript entrypoint (not a shell shim).
`SWITCHYARD_BACKEND=codex|claude|api` sets the default for command-line runs;
a saved session retains its own backend.

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `switchyard` | `d`, `dsw`, `ds` | Interactive agent — streams thinking, calls tools, saves sessions |
| `switchyard -ui` | `d -ui` | Electron desktop UI with HTTP control API and CDP debugging port |
| `switchyard balance` | — | Read DeepSeek credit; `--minimum <usd>` exits 2 below the reserve floor |
| `dsd` | — | Fire-and-forget: prompt → Markdown file, optional Claude fallback |
| `dswait` | — | Poll until a detached output file appears |

---

## Permission levels

| Level | What DeepSeek can do |
|-------|----------------------|
| `review` | Read files and list directories only |
| `ask` *(default)* | Same + prompts before writing files or running shell commands |
| `full` | All tools run automatically without prompting |

```bash
switchyard --permission review -p "audit the auth module"
switchyard --permission full   -p "refactor utils.js to use ES modules"
```

### Unattended, scoped work

For an authorized task that may run unattended, seed the task scope at launch and use full permission:

```powershell
switchyard --provider glm --permission full --allow-target example.com,api.example.com --agent-id recon
```

Repeat `--allow-target` for additional authorized assets, or comma-separate them. While a session is running, the agent can use `scope_add_assets` or `scope_remove_assets`; no replacement agent is needed. For a complete policy, use `--scope-file scope.json`; it accepts the same `allowed_assets`, `excluded_assets`, `allowed_classes`, `excluded_classes`, and `restrictions` fields as `scope_set`.

For HackerOne work, give the coordinator a target first. It should use the existing signed-in PBC profile for a cheap viability pass, record `CONTINUE`, `ESCALATE`, or `DROP`, and only then wake deeper workers.

---

## Desktop UI

Launch the Electron UI instead of the terminal dashboard:

```bash
d -ui
```

Useful options:

```bash
d -ui --ui-port 17891 --ui-cdp-port 9223
```

- UI control API: `http://127.0.0.1:17891`
- CDP / remote debugging: `http://127.0.0.1:9223`
- Health check: `GET /health`
- List saved sessions: `GET /sessions`
- Read a saved session: `GET /sessions/<url-encoded-session-path>`
- Start a run: `POST /chat` with `{"prompt":"...","permission":"review"}` or `{"permission":"full"}`
- Resume a session from the API: include `{"sessionPath":"C:\\path\\to\\session.json"}` in `POST /chat`
- Inspect runs: `GET /runs` and `GET /runs/<id>`

The UI delegates chat execution back to the existing `d` CLI, reads the same `.deepseek-watch/sessions/*.json` files as the TUI, renders chat history/tool calls/tool results, and writes per-run output under `.deepseek-watch/ui/<run-id>/`.

![Electron UI showing saved session history](docs/images/electron-session-history.png)

![Electron UI with independently scrollable chat history](docs/images/electron-scrollable-chat.png)

---

## Workspace tools

In terminals that support OSC-8 hyperlinks, the TUI turns exact workspace file paths shown in tool calls/results into clickable file links. Set `DEEPSEEK_NO_FILE_LINKS=1` to disable terminal file links.

### Read-only (all permission levels)

| Tool | Description |
|------|-------------|
| `get_runtime_context` | OS, shell, Node version, git branch, date |
| `list_workspace_files` | List files/dirs — now supports `recursive`, `glob`, `exclude_glob`, `include_metadata`, pagination |
| `read_text_file` | Read a file by line range or byte offset; `structured: true` returns cursor JSON |
| `read_text_files` | Batch-read multiple files in one call; per-file errors don't abort the batch |
| `view_image` | Read a workspace image and return metadata, dimensions, and a data URL when small enough; does not visually interpret content |
| `analyze_image_openai` | Use OpenAI vision to inspect/transcribe a workspace image; requires `OPENAI_API_KEY` |
| `search_code` | Regex/literal search across workspace files with glob filter and context lines |
| `artifact_list` / `artifact_read_range` / `artifact_search` | Bounded retrieval from task-scoped analysis artifacts |
| `artifact_index` / `artifact_search_all` | Task-wide artifact metadata and bounded cross-artifact search |
| `sandbox_execute` / `sandbox_manage` | Bounded Docker execution using named ephemeral environments |
| `scope_get` / `scope_set` / `scope_check` | Structured task authorization state and target checks |
| `hypothesis_record` / `viability_set` / `roi_record` | Persist negative findings, viability decisions, and task economics |
| `net_capture_start` / `net_capture_stop` / `net_capture_status` | Bounded ring-buffer capture in the isolated network environment |
| `model_escalation_get` / `model_escalation_set` / `model_escalation_decide` | Configurable cheap/specialist/verifier routing |
| `glob` | Discover paths matching a glob pattern (no shell) |
| `stat_file` | Size, modification time, type, and binary flag for any path |
| `path_exists` | Check whether a path exists |
| `is_text_file` | Sniff whether a file is text or binary |
| `get_related_files` | Scan import/require/include statements to find referenced files |
| `tree` | Visual directory tree output |
| `git_status` | `git status --short --branch` |
| `git_diff` | Staged or unstaged diff, optionally vs a branch |
| `git_log` | Commit log (one-line format) |
| `git_blame` | Line-range blame |
| `cache_set` / `cache_get` | Session key-value store persisted with saved session files |
| `list_skills` / `read_skill` | Discover and read local skills from configured skill roots |
| `create_goal` / `get_goal` / `update_goal` | Persistent session goal state for long-running work |
| `update_plan` / `get_plan` | Persistent visible plan steps with statuses |
| `session_health` | Session integrity, progress, touched files, and repair-needs summary |
| `checkpoint_session` | Append a compact checkpoint to the saved session |
| `summarize_session` | Compact recent session summary |
| `handoff_status` / `handoff_wait` | Inspect or wait for delegated handoff output files |
| `web_search` | Web search via Google Custom Search when configured, then Brave, then DuckDuckGo HTML/Lite |
| `web_fetch` | Fetch a URL and return readable page text with chunk offsets |
| `web_find` | Fetch a URL and run a JavaScript regexp over readable page text |
| `classify_url` | Check an unfamiliar URL for known scam, tracker, wall, executable, and shortener signatures without opening it |
| `verify_download` | Quarantine and statically inspect a permitted local file or non-flagged URL; never executes it |
| `watch_downloads` | List recent Downloads files and identify `.crdownload` files still in progress |
| `file_watch` | Compare workspace file snapshots and report created, modified, and deleted files |
| `project_memory` | Durable workspace conventions/decisions in `.deepseek-watch/project-memory.json` (never secrets) |
| `track_bypass_state` | Persist defensive research state such as suspicious domains and verified hashes |
| `scan_download_hash` / `virus_total` | Optional VirusTotal lookup when `VT_API_KEY` is configured |
| `whois_lookup` / `dns_lookup` / `cert_logs` | Read-only domain registration, DNS, and Certificate Transparency reconnaissance |
| `file_analyze` | Static file inspection: SHA-256, entropy, printable strings, and basic PE heuristics |
| `semantic_search` | Rank workspace text files by local lexical relevance to a natural-language query |
| `plan_review` | Git status/diff summary, whitespace check, and a compact pre-handoff checklist |
| `agent_identity` / `agent_list` | Inspect this agent and discover live peers, roles, missions, and workspaces |
| `agent_send` / `agent_check_inbox` / `agent_wait` | Durable peer messaging plus safe parked wait/wake behavior |
| `agent_task_create` / `agent_task_list` / `agent_claim` / `agent_handoff` | Coordinator task contracts, atomic ownership leases, and result handoffs |

### Write tools (ask, full)

| Tool | Description |
|------|-------------|
| `write_text_file` | Create or overwrite a file |
| `patch_files` | Atomic multi-file patch — all `old_string` values must match before any file is written; edits to the same file apply in order; CRLF/LF normalized for matching |
| `patch_text_file` | Single-file search-and-replace (first occurrence, or all with `replace_all`); CRLF/LF normalized for matching |
| `run_cmd` | Run a `cmd.exe` command |
| `run_powershell` | Run a PowerShell command |
| `run_bash` | Run a Bash command through `bash.exe` (WSL or Git Bash) |
| `functions_shell_command` | PowerShell with optional workspace-relative `workdir` |
| `handoff_start` | Start a bounded delegated CLI handoff with prompt, output, and log files |
| `process_manage` | Start/stop/status/list named detached processes; records persist in `.deepseek-watch/processes.json` so a later wrapper session can stop them; each process has separate logs and optional HTTP readiness checks |
| `diagnostics` | Run available npm `lint`, `typecheck`, and `check` scripts |
| `run_tests` | Run the workspace npm `test` script when configured |

### Reading by line range

DeepSeek can target specific lines without loading the whole file:

```
read lines 40–80 of src/auth.js
```

Internally: `read_text_file { "path": "src/auth.js", "start_line": 40, "end_line": 80 }`

### Searching across files

```
search_code { "pattern": "TODO", "glob": "**/*.ts", "context_lines": 2 }
```

### Atomic multi-file patching

`patch_files` preflights all `old_string` values first — if any don't match, no files are written:

```json
{
  "edits": [
    { "path": "src/a.ts", "old_string": "foo", "new_string": "bar" },
    { "path": "src/b.ts", "old_string": "baz", "new_string": "qux" }
  ]
}
```

Two properties worth knowing:

- **Multiple edits to the same file apply in order.** Each edit's `old_string` is
  matched against the file content *as modified by the previous edit in the same
  call*, so a multi-hunk edit to one file works in a single call.
- **Line endings are normalized for matching.** On Windows checkouts (CRLF files),
  an `old_string` written with `\n` still matches. Inserted text adopts the file's
  dominant line ending, so a patch never rewrites the whole file's EOL style.
  `patch_text_file` shares the same matching behavior.

### Terminal UI

Interactive chats now use a full-screen view with one renderer, a pinned input
and status row, live tool cards, and terminal resize handling. Start it with
`d --tui -p "your task"` or from the interactive dashboard. Type during a response
to queue a follow-up; it runs after the current task returns.

- Enter sends; Alt+Enter inserts a newline. Bracketed paste stays in the draft.
- Escape interrupts generation; during tools it stops after the current batch.
- Page Up / Page Down scroll history; Ctrl+End follows the latest output.
- Ctrl+R toggles reasoning; Ctrl+E toggles tool arguments and results.
- Ctrl+L forces a redraw. `/exit` quits; Ctrl+C quits when idle.
- Permission questions get their own input and preserve your draft.

The screen restores the previous terminal view on exit. Saved sessions retain
the conversation. `--tui-quiet`, redirected output, and `TERM=dumb` keep the
plain-output path. One-shot commands keep their existing rendering unless
`--tui` is supplied. The full-screen view uses colored message labels, compact tool rows, word-wrapped
answers, and a bordered composer. Token/cache statistics stay in the status bar.
Headings, bold text, inline code, and fenced code receive basic terminal styling.
`--no-color` or `NO_COLOR` disables colors while preserving the layout.

Interactive sessions render with a Claude Code-style terminal UI (pure ANSI, no
dependencies):

- streaming **markdown-lite** output: headings, bold, inline code, fenced code
  blocks, bullets, numbered lists, task checkboxes, blockquotes, horizontal
  rules, and terminal links for known workspace files
- Claude Code-style **padding + word wrapping**: content is indented 2 columns
  on each side and wraps at word boundaries (never mid-word), re-flowing live
  as the line streams; unbreakable over-long tokens (URLs, code) hard-split
- a live **spinner status line** (model · phase · token count · elapsed time)
  that stays animated during thinking/tool phases and clears before output;
  interactive sessions also set the terminal window title (`Switchyard · <folder>`)
- compact **tool-call trace**: each call prints `▹ name {args}` when it starts
  and `✓ name (duration)` / `✗ failed` when it finishes, before the result

Everything degrades to plain text when stdout is not a TTY or `--no-color` is
set. For clean terminal copies, use `--tui-quiet` (or
`DEEPSEEK_TUI_QUIET=1`): it disables the status line and in-place line
rewriting, so streamed text never duplicates or leaves status artifacts when
selected/copied mid-run. `npm run test:tui` runs the renderer self-tests.

### Security tooling (allowlisted targets only)Web-app security tools for testing **your own properties** (`switchyard security allow
<domain>` registers a target; anything else is refused):

- `sec_http_request` — raw HTTP(S) requests (method/headers/body/redirect control)
- `sec_fuzz_paths` — polite, rate-limited path discovery (wordlists: `small`/`common`)
- `sec_crt_subdomains` — passive cert-transparency subdomain enum + dangling-DNS takeover candidates
- `sec_encode` — base64/hex/url/rot13/SHA1/SHA256/MD5/JWT/XOR workbench
- `sec_extract_iocs` — URLs/IPv4/emails/hashes/domains out of text or files
- `sec_scan_adware` — injected adware/miner/obfuscation/hidden-iframe/popup scanner with a clean/suspicious/infected verdict
- `sec_headers_audit` — security-header scoring (HSTS/CSP/XFO/nosniff/Referrer-Policy), CORS origin-reflection test, cookie flags, version-disclosure notes

Safety model: active tools require the target host in
`~/.deepseek-watch/security-allowlist.json` (managed via
`switchyard security allow <domain>` / `remove` / `list`). Requests are rate-limited,
and the tools are request primitives and passive analyzers — no
auto-exploitation or weaponization. `npm run test:security` runs the offline
self-tests.

---

## dsw options

```
  -p, --prompt <text>              Prompt text
  --prompt-file <file>             Read prompt from file
  --stdin                          Read prompt from stdin
  --system <text>                  Override system prompt
  --system-file <file>             System prompt file (default: prompts/default-system.md)
  --print-system                   Print rendered system prompt and exit
  --skill <name-or-path>           Load a local skill's SKILL.md into the system prompt; repeatable
  --skills <a,b>                   Comma-separated skills to load
  --skill-root <dir>               Directory containing skill folders; repeatable
  --list-skills                    List discovered local skills and exit
  --provider <name>                deepseek, glm, anthropic, openai (default: deepseek)
  --model <name>                   Model (selected provider default)
  --base-url <url>                 Provider API base URL
  --effort <high|max>              Reasoning effort (default: high)
  --thinking <enabled|disabled>    Thinking toggle (default: enabled)
  --max-tokens <n>                 Max output tokens (default: 16384)
  --timeout <ms>                   Per-turn timeout ms (default: 600000)
  --max-tool-turns <n>             Cap tool-call loops (default: unlimited); when reached, request a tools-disabled final report instead of discarding the handoff
  --tool-mode <parallel|sequential>
                                   parallel = concurrent tool calls (default)
                                   sequential = run in order
  --permission <review|ask|full>   Session permission level
  --session <file>                 Session JSON file
  --resume                         Resume from --session or pick from list
  --no-save-session                Don't persist session to disk
  -o, --output <file>              Write a Markdown result file
  --outfile <file>                 Alias for --output
  --no-output                      Suppress terminal output; requires --output/--outfile
  --full-chat                      Write full transcript instead of final answer + touched files
  --dangerously-auto-run-commands  Auto-approve all commands and file writes
  --no-tools                       Disable all workspace tools
  --no-color                       Disable ANSI colors
  -h, --help                       Show help
```

### Doctor

Run a local readiness check:

```powershell
d doctor
```

Doctor reports DeepSeek key status, OpenAI vision status, selected vision model, CLI availability, and discovered skills. It does not print full API keys.

### Local skills

`dsw` can load Codex-style local skills by appending their `SKILL.md` files to the system prompt:

```powershell
switchyard -p "use PBC to inspect the page" --skill pbc --permission full
```

Skill discovery checks, in order:

- directories passed with `--skill-root`
- directories from `DEEPSEEK_SKILLS_DIR` (path-delimited)
- `.deepseek-watch/skills` in the current workspace
- `~/.codex/skills`, including Codex hidden grouping folders such as `.system`

Use `--list-skills` to see discovered skills. During a session, DeepSeek can also call `list_skills` and `read_skill` to inspect skills that were not preloaded.

When you resume with a skill, the wrapper refreshes the saved system message and persists the skill list in the session JSON:

```powershell
switchyard --resume --skill pbc -p "continue"
```

Future resumes of that session reuse the saved skills automatically unless you pass a different `--skill` / `--skills` set.

### Image understanding

`view_image` only exposes image metadata and a data URL. For real visual understanding, set an OpenAI key and let DeepSeek call `analyze_image_openai`:

```powershell
$env:OPENAI_API_KEY = "sk-..."
d -p "read the code in screenshot.png" --permission review
```

To persist the OpenAI key for future terminals on Windows:

```powershell
d config set-openai-key sk-proj-your-full-key
```

This writes `OPENAI_API_KEY` to your Windows user environment. Open a new terminal after running it.

Use `OPENAI_VISION_MODEL` to override the default OpenAI vision model:

```powershell
$env:OPENAI_VISION_MODEL = "gpt-4.1-mini"
```

Quiet outfile mode is meant for detached subagent workflows where console text costs tokens:

```bash
switchyard -p "inspect this repo and write findings" --permission full --no-output --outfile result.md
```

By default the Markdown file contains only the final assistant response and files touched by edit tools. Add `--full-chat` when you want the whole conversation, tool calls, tool results, and reasoning transcript written to the outfile.

---

## dsd — detached runner

```bash
# Foreground — writes result to out.md when done
dsd -p "summarise the last 10 commits" -o out.md

# Background — exits immediately, worker runs detached
dsd -p "..." -o out.md --detach
dswait out.md --timeout 120000   # wait up to 2 min
```

```
  -p, --prompt <text>
  --prompt-file <file>
  --stdin
  -o, --output <file>         Output Markdown file (default: deepseek-result.md)
  --model / --base-url / --effort / --thinking / --max-tokens / --timeout
  --detach                    Spawn background worker and exit
  --no-fallback               Don't fall back to claude -p on error
  --claude-cmd <cmd>          Claude CLI path (default: CLAUDE_CMD or claude)
```

---

## Configuration

```bash
switchyard config set-key <key>   # save to %APPDATA%\deepseek-detached-agent\config.json
switchyard config set-glm-key <key> # save a Z.AI GLM key in the same config file
switchyard config set-anthropic-key <key> # Claude API key
switchyard config set-openai-key <key> # GPT and OpenAI image tools
switchyard config set-google-search-key <key>
switchyard config set-google-search-engine-id <engine-id>
switchyard config path            # show config file location
```

DeepSeek publishes a read-only balance endpoint but no supported payment or
automatic top-up API. Use a one-shot guard in scripts or Task Scheduler:

```powershell
switchyard balance --minimum 10
switchyard balance --minimum 10 --json
```

For long-running agents, an explicitly configured provider can take over when
DeepSeek returns HTTP 402:

```powershell
$env:DSW_BALANCE_FALLBACK_PROVIDER = "glm"
switchyard --resume --agent-id my-worker
```

The fallback is opt-in, requires its own API key, and uses that provider's normal
API billing. It does not automate a payment page or charge a card. The Z.AI
Coding Plan endpoint has separate eligibility and usage restrictions; this
harness continues to use the general GLM API endpoint.

Environment variables (take priority over saved config):

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
GLM_API_KEY=your-z-ai-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
DSW_PROVIDER=deepseek
DSW_BALANCE_FALLBACK_PROVIDER=glm
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_ENGINE_ID=...
WEB_SEARCH_PROVIDER=auto
BRAVE_SEARCH_API_KEY=...
CLAUDE_CMD=claude
NO_COLOR=1
```

`WEB_SEARCH_PROVIDER=auto` uses Google when `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_ENGINE_ID` are set, then Brave when `BRAVE_SEARCH_API_KEY` is set, then DuckDuckGo as the no-key fallback. Use `WEB_SEARCH_PROVIDER=google` to force Google and fail clearly when it is not configured.

If Google returns an access error such as `This project does not have the access to Custom Search JSON API`, `auto` mode reports the Google failure and continues with the next provider. This can happen even after the API is enabled if Google has not granted the project access to Custom Search JSON API.

---

## Session memory

Sessions are saved to `.deepseek-watch/sessions/` in the working directory.

```bash
switchyard --resume                        # arrow-key picker, sorted by last used
switchyard --session path/to/session.json  # explicit file
switchyard --no-save-session               # ephemeral — nothing written
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `HTTP 401: Authentication Fails` | Invalid API key | `switchyard config set-key sk-...` |
| `HTTP 402: Insufficient Balance` | Account needs credit | Top up on DeepSeek Platform |
| `No DeepSeek API key found` | No key set | Set `DEEPSEEK_API_KEY` or run `switchyard config set-key` |

---

## License

MIT © 2026 [gaston1799](https://github.com/gaston1799)
