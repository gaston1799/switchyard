# Watch CLI

Switchyard's decision commands are `switchyard decisions list|get|history|resolve`.
See [Decision Management v1](decision-management-implementation.md) for authority,
resolution examples, task dependencies and recovery. The historical command and
path names below remain compatibility aliases.

`deepseek-watch` is the visible terminal wrapper. Use it when you want to watch DeepSeek's reasoning stream and tool-call requests before moving the same workflow into detached mode.

```powershell
deepseek-watch
```

Running with no args opens the dashboard:

- New run
- Resume session
- Show config path
- Show help
- Quit

Dashboard runs stay in chat mode after the first answer. Type `/exit`, `/quit`, `/end`, `exit`, or `quit` to end the session.

Press `Esc` at the prompt to add an interruption marker to the session. During streaming, `Esc` aborts the current response and records it as interrupted.

New dashboard sessions ask for a permission level:

- `review`: read-only tools only.
- `ask`: shell commands are allowed only after terminal confirmation.
- `full`: shell commands auto-run. This is the dangerous continuous-agent mode.

The chosen permission is saved into that session and reused when you resume it.

Direct prompt mode:

```powershell
deepseek-watch -p "List the repo files, then summarize the project."
```

The loop works like this:

1. The model thinks and either returns final text or asks for tool calls.
2. The wrapper prints the requested tool calls and executes them.
3. Tool results are appended to session memory.
4. The full remembered context is sent back to the model.
5. The loop stops when the model returns final text with no tool calls.

Tool execution mode:

```powershell
deepseek-watch --tool-mode sync -p "Inspect independent files."
deepseek-watch --tool-mode async -p "Run dependent steps in order."
```

`sync` is the default and runs tool calls from the same model turn in parallel when safe. `async` runs them in order, which is better when commands depend on previous command output. Shell tools still run sequentially unless `--dangerously-auto-run-commands` is enabled, because overlapping terminal prompts are clown behavior.

By default, each new run creates a timestamped session here:

```text
.deepseek-watch/sessions/
```

Use a custom session file:

```powershell
deepseek-watch --session .\out\agent-session.json -p "Inspect the repo."
```

Resume and append a new prompt:

```powershell
deepseek-watch --resume --session .\out\agent-session.json -p "Now explain the last result."
```

Resume without specifying a file:

```powershell
deepseek-watch --resume -p "Continue."
```

In an interactive terminal, this opens a picker sorted by last used. Use arrow keys and press Enter. In a non-interactive shell, it resumes the most recently updated session.

Disable session writes:

```powershell
deepseek-watch --no-save-session -p "One-off question."
```

Save your API key once:

```powershell
deepseek-watch config set-key sk-...
```

Show where it is stored:

```powershell
deepseek-watch config path
```

Error smoke tests should produce clean one-line messages:

```text
DeepSeek HTTP 401: Authentication Fails... code=invalid_request_error type=authentication_error
DeepSeek HTTP 402: Insufficient Balance code=invalid_request_error type=unknown_error
```

The default system prompt lives at:

```text
prompts/default-system.md
```

It supports this placeholder:

```text
{{context}}
```

The wrapper replaces it with runtime context:

- ISO date
- device OS
- username
- workspace folder
- shell
- Node version
- git branch when available

## Built-In Tools

Tools are read-only by default:

- `get_runtime_context`
- `list_workspace_files`
- `read_text_file`
- `run_cmd`
- `run_powershell`

File inspection tools are read-only. Shell tools ask for terminal approval before running.

`read_text_file` does not print file contents to the terminal anymore; it only shows which file was read. The full content still goes back to the model. If a file is larger than `max_bytes`, the tool tells the model to read it in chunks with `offset`/`max_bytes` or use a shell command like `Get-Content`.

If you reject a command, the tool result saved into session memory is:

```text
blocked by user
```

For continuous agents that should run commands without prompting:

```powershell
deepseek-watch --permission full -p "Run the test suite and fix failures."
```

`--dangerously-auto-run-commands` still exists as an alias-like override for full access. The loud name is there because, yeah, it is doing the dangerous thing.

Disable tools:

```powershell
deepseek-watch --no-tools -p "Answer without workspace tools."
```

Disable ANSI styling:

```powershell
deepseek-watch --no-color -p "Plain output."
```

Print the rendered system prompt:

```powershell
deepseek-watch --print-system
```

## Agent sessions

When you pass `--agent-id <id>`, the CLI ties that id to a single session file
instead of scattering one session per launch:

- The first launch with `--agent-id X` creates a session (in
  `.deepseek-watch/sessions/`) and records `config.agentId = X` in it.
- Later launches with `--agent-id X` automatically resume the agent's most
  recently updated session (matched by the saved `agentId`) and append the new
  prompt, so the agent keeps its memory across launches.
- Pass `--new` to start a fresh session for that agent id anyway.

An explicit `--session <file>` always wins over the lookup, and `--resume`
keeps its existing meaning. `--resume` and `--new` are mutually exclusive.

Example:

```powershell
deepseek-watch --agent-id worker-1 -p "Continue your assigned work."
deepseek-watch --agent-id worker-1 --new -p "Start over with a clean session."
```

## Fetch retries

The CLI retries transient fetch failures instead of crashing:

- Network blips (`ECONNRESET`, `ECONNREFUSED`, DNS failures, undici errors)
- Per-turn timeouts (`--timeout`, default 600000 ms)
- HTTP 408/425/429 (rate limits) and 5xx responses

Auth/config errors (400/401/402/403/404) are terminal and still fail fast with
a clean one-line message. Esc/Ctrl+C during a turn still marks it interrupted
and stops the retry loop.

Retry backoff doubles per attempt:

```text
--retry-attempts <number>    Max retries. 0 (default) = keep retrying forever.
--retry-delay <ms>           Initial backoff. Default: 1000
--retry-max-delay <ms>       Backoff cap. Default: 30000
```

The detached worker (`dsd`) uses the same retry policy and passes these flags
through `--detach`.
