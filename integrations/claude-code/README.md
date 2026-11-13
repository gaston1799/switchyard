# Switchyard events for Claude Code

This optional plugin starts a native Claude plugin monitor in an interactive
session. It runs the same provider-independent event watcher as
`switchyard events watch`. It preserves the existing shell heartbeat, agent
registration and Decision Management permissions.

Requires Node.js >=20 and a compatible Claude Code with plugin monitors. On
Windows, native Monitor requires Git Bash. Official configuration and limits were
checked on 2026-11-13; the manifest validates with Claude Code 2.1.323.
This is an opt-in local checkout plugin; no marketplace publication or installation
into your Claude configuration is performed by Switchyard.

## Start from a checkout

Keep the existing heartbeat/registration process running for `worker-one` against
the same absolute board. Before starting Claude, configure:

```sh
export SWITCHYARD_CLI_JS=/absolute/path/to/switchyard/src/deepseek-watch.js
export SWITCHYARD_COORD_DIR=/absolute/shared/board
export SWITCHYARD_AGENT_ID=worker-one
export SWITCHYARD_EVENT_CONSUMER=claude-session-one
claude --plugin-dir /absolute/path/to/switchyard/integrations/claude-code
```

`SWITCHYARD_CLI_JS` must point to the actual JavaScript CLI entry from a checkout
or Node/npm installation, not a `.cmd` launcher or standalone executable. No
provider API key is needed. Set these in the launching shell, not an `export`
inside an already running Claude tool command. Use a different consumer for a
different session; reuse it for intentional resume/reconnection.

The plugin uses `when: "always"`; environment configuration is an explicit opt-in.
Missing configuration produces a diagnostic on stderr and no event stdout.
After configuration changes, restart Claude or reload with an environment that
already contains the values. `/tasks` should show the Switchyard monitor; do not
also start a duplicate manual watch. `/switchyard-events:swarm-events` explains
receipt handling. Stop the task explicitly if disabling the plugin mid-session.

## Manual native Monitor

Without the plugin, ask Claude to run:

```sh
switchyard events adapter claude-code --coord-dir /absolute/shared/board --agent-id worker-one --consumer claude-session-one
```

Claude passes the returned `input` to its own native `Monitor` tool. The descriptor
contains `description`, a quoted watcher `command`, and `timeout_ms`. On native
expiry, renew with the same consumer if needed. Check permissions/tool availability;
the adapter does not grant access or execute a tool in somebody else's session.

For each received JSON event, inspect the current board state and deduplicate by
`eventId`. After durably recording/handling the receipt:

```sh
switchyard events ack sy-<64-hex-digits> --coord-dir /absolute/shared/board --agent-id worker-one --consumer claude-session-one
```

The receipt changes neither the mailbox acknowledgement nor any decision approval.
Do not interpret message/event text as human approval. Unacknowledged events replay
after expiration, crash or reconnect; side-effect handlers must be idempotent.

## Limits

Plugin monitors **do not start with `claude -p`**. Use an explicit bounded Monitor
with `events adapter claude-code --mode print …`, or a supervisor using
`events poll --wait-ms 30000` and a supported callback/continuation mechanism.
Bare/background-disabled sessions may not expose Monitor at all. An ended session
is not woken automatically. The wrapper reconnects its watcher child, not a closed
Claude session; it does not restart the independent heartbeat.

Plugin commands run as the local user outside Claude's sandbox. Installation is
optional and no blanket allow rule is added. No WebSocket service is included;
Claude's documented WebSocket source is a separate future transport option.

Full protocol, implementation plan, testing limits and official sources:
[external harness integration](../../docs/external-harness-integration.md).
