# External harness integration

Status: provider-independent watcher, Claude Monitor adapter and opt-in plugin
implemented. This extends Decision Management v1 without changing its store,
authority rules, task gates or API-backed agent lifecycle. Research checked against
the official references below and Claude Code 2.1.323 on 2026-11-13.

## Three separate components

| Component | Responsibility | Lifetime / owner |
| --- | --- | --- |
| Existing shell heartbeat | Register the external agent and keep its liveness/identity current | Existing external heartbeat process |
| Switchyard event watcher | Read durable board records and emit relevant NDJSON events | Standalone process or reusable Node API |
| Harness adapter | Deliver events using a mechanism the target harness actually supports | Harness session or caller's supervisor |

Keep the existing shell-based heartbeat unchanged. A watcher starting, expiring,
reconnecting or emitting an event is not evidence that its agent is alive. A
heartbeat rewrite must not wake the model. The checkout's wrapper heartbeat is in
`src/agent-coordination.js`; no replacement external heartbeat is introduced here.
Use the same absolute coordination directory and existing registered agent ID as
your heartbeat. Neither the watcher nor the Claude adapter acquires an agent role,
starts a heartbeat, consumes mailbox messages or grants decision authority.

## Implementation plan and delivered pieces

1. Preserve heartbeat/registration and existing decision/task persistence.
2. Read the existing inbox/processed records, lifecycle/task journal and immutable
   decision revisions through `src/event-watcher.js`. Do not add a second decision
   database, notification-dependent approval, or synthetic heartbeat event stream.
3. Expose `switchyard events watch`, `poll`, and `ack` for all harnesses. Keep the
   stream independent from Claude's tool input and session protocol.
4. Adapt that stream to Claude's native Monitor through
   `src/harness-adapters.js`, `events adapter claude-code`, and the opt-in plugin
   under `integrations/claude-code/`. Validate against the official schema.
5. Persist per-consumer receipts, replay unacknowledged events after restart, and
   recover watcher exits with backoff. Never treat writing stdout as model receipt.
6. Offer callback, blocking-wait and polling interfaces for other harnesses without
   claiming their products support any Claude-specific API.
7. Test notification filtering, missed-event recovery, expiration/renewal, duplicate
   handling, quiet heartbeats, source immutability and CLI/plugin process behavior.

## Event stream and replay contract

```sh
switchyard events watch --coord-dir /shared/board --agent-id worker-one --consumer claude-session-one
switchyard events poll --coord-dir /shared/board --agent-id worker-one --consumer claude-session-one --wait-ms 30000
switchyard events ack sy-<64-hex-digits> --coord-dir /shared/board --agent-id worker-one --consumer claude-session-one
```

`watch` writes one compact JSON object per stdout line, stays quiet when idle, and
supports `--poll-ms` (default 1000) and an optional `--timeout-ms` (0 = no watcher
deadline). `poll` returns one batch immediately, or waits up to `--wait-ms` for an
event; an empty result emits no stdout. Diagnostics go to stderr and repeated
identical diagnostics are suppressed. These commands need no model/provider key.

Each event has `schemaVersion: 1`, a stable `eventId`, `type`, `occurredAt` (or null
for legacy records without a valid timestamp), `source` and compact `data`. Types:

| Type | Source and filtering |
| --- | --- |
| `message.received` | Mail addressed to this agent; moves to `processed/` retain the same event ID |
| `decision.changed` | Every retained revision of relevant decisions: proposer/coordinator, affected claimed work, or a directly addressed notice |
| `task.changed` | Durable task journal entries for work created/claimed by this agent; coordinators see board task activity |
| `agent.lifecycle` | Durable registration/stop events for self, assigned coordinator, or the coordinator's board |

Heartbeat fields and runtime-only rewrites are not event sources. Unrelated worker
tasks do not create wakeups. Decision revisions are read directly, so a crash
between committing approval and writing its mailbox notification does not lose the
change. Matching decision-board mailbox notices collapse into the same revision
event; arbitrary mailbox text is not interpreted as approval. Summaries are bounded;
inspect the current authoritative inbox/task/decision before acting.

Receipts live in `<coord-dir>/subscriptions/<consumer>/`. Choose a stable consumer
per external session, distinct from other sessions even when they observe the same
agent. Reuse it across Monitor renewal, reconnect and intentional session resume.
Each consumer is bound to one agent. Retained source IDs form an acknowledgement
set rather than a timestamp high-water mark: a late file with an older timestamp
still arrives. The existing recursive board migration carries subscriptions too;
event IDs do not depend on the board's absolute path.

Within one watcher process, an event is emitted once. Across restarts or overlapping
watchers, delivery is **at least once until explicitly acknowledged**. A fresh
consumer replays retained relevant history; use the same consumer to avoid replaying
already handled history. Only acknowledge after receipt is durably recorded or
handled. Receipt acknowledgement is separate from inbox acknowledgement and from
decision/task operations. A handler can crash after a side effect and before its
receipt is saved; use `eventId` as its idempotency key. Do not claim exactly-once
side effects. Do not run duplicate monitors for one consumer intentionally.

Malformed/partial sources are retried without blocking unrelated readable sources.
A corrupt receipt causes replay, not silent event loss; stop that consumer and
repair/remove the invalid receipt after verifying durable handler state. Immutable
receipt publication requires hard-link-capable storage, as decision revisions do.
There is no journal pruning or bounded-history compaction; retained history is
rescanned, so large boards may need later indexing/retention work. Never delete
unacknowledged source history and expect replay to recover it.

## Claude Code adapter

Generate the native tool input:

```sh
switchyard events adapter claude-code --coord-dir /shared/board --agent-id worker-one --consumer claude-session-one
```

The result identifies `Monitor` and supplies its required `description`,
`command`, and `timeout_ms` fields. Claude calls **its native tool** with that
`input`; Switchyard does not inject a fictional cross-process tool invocation.
The command runs the provider-independent watcher with shell-quoted paths and no
provider credentials. Availability and permission rules are checked in the actual
Claude session. Use the returned native task ID to stop it with `TaskStop`.

Manual Monitor watches default to 5 minutes, accept up to 30 minutes in interactive
sessions and up to 10 minutes for `claude -p`; the adapter validates these bounds
(`--mode print` for the latter). The native expiry/close notice is the renewal
signal. Reissue the same descriptor with the same consumer if the session still
needs it. Pending/unacknowledged events replay; the watcher emits no heartbeat,
keepalive, synthetic expiration line or periodic "nothing changed" notice.

Claude also supports `ws` watches, but they are a distinct source from `command`,
not a way to tail local files. This implementation needs no WebSocket server.
A future remote-board bridge can map one NDJSON envelope to one text frame and
retain the same receipt protocol. It must reconnect after socket closure, retain
replay and respect Claude's URL/network/frame constraints and native deadline.
No WebSocket transport or automatic socket reconnection is claimed here.

## Automatic Claude startup

The opt-in plugin declares `experimental.monitors` pointing to
`monitors/monitors.json`, with `when: "always"`. Configure the environment before
starting Claude; see [plugin setup](../integrations/claude-code/README.md). The
plugin's small process wrapper invokes the reusable watcher with argv rather than
shell interpolation, forwards NDJSON, and retries unexpected child exits with
bounded exponential backoff. Consumer identity is unchanged, so pending events
replay. SIGINT/SIGTERM stop the child and cancel restart timers. The heartbeat is
never part of this restart tree.

Official plugin monitors follow the interactive session lifetime, unlike bounded
model-started Monitor calls. Their strict configuration supports `name`, `command`,
`description`, and optional `when`; do not invent timeout/restart fields. The
alternative `on-skill-invoke:<skill>` trigger is documented but this opt-in plugin
uses session startup. Configuration comes from ordinary environment variables:
plugin monitor commands cannot use `user_config` values, and Claude's plugin path
substitutions are not exported as monitor environment variables.

Plugin monitors run with the local user's permissions outside Claude's sandbox.
Install/enable this plugin deliberately. It adds no global permission bypass.
After disabling a plugin mid-session, explicitly stop its existing monitor task
or end the session; disabling alone does not stop it.

## Interactive and non-interactive limits

- Interactive: native events can prompt work in an open session; they cannot
  reopen a closed session or prove that the model processed a stdout line.
- `claude -p`: plugin monitors do not autostart. Start a bounded Monitor explicitly
  only if the tool is available, or let the external supervisor poll/wait and use
  its supported session continuation/callback interface. The documented background
  wait ceiling can end a print run; it is not a durable always-on daemon.
- `--bare`/background-disabled configurations can remove Monitor/background work;
  use bounded polling or callbacks rather than changing permission/security mode.
- Windows Monitor requires Git Bash. Feature-flag-disabled/provider deployments
  have documented minimum versions; check tool availability instead of assuming a
  version alone guarantees access.
- Switchyard's existing native Claude transport runs `--print` with stream-json.
  This change does not automatically start interactive plugins there, inject board
  model tools, rewrite that transport, or grant native agents coordinator authority.

## Other harness adapters

`switchyard events adapters` describes the interfaces. The Node exports are
`collectBoardEvents`, `pollEvents`, `watchEvents`, `acknowledgeEvents`,
`claudeMonitorCall`, and `runCallbackAdapter`.

| Harness capability actually available | Adapter behavior |
| --- | --- |
| Supported callback / notification queue | Pass the event to that API using `eventId` as idempotency key; return `{accepted: true}` only after durable acceptance; callback adapter then acknowledges |
| Supported background-task completion notification | Run a bounded `events poll --wait-ms …`; completion carries the NDJSON into that harness's normal notification mechanism; acknowledge after receipt |
| Blocking wait allowed | Use bounded `poll`/`watchEvents({once: true, timeoutMs: …})`, then continue at the harness's own boundary |
| Polling only | Poll periodically from the harness/supervisor; no claim of mid-turn wakeup |
| No external notification input | Keep events durable for later inspection; do not inject stdin, terminal keystrokes, undocumented RPC or fabricated Monitor calls |

An adapter owns transport delivery, reconnect policy, capability checks and handler
receipts. It never owns heartbeat or decision authority. The callback utility is
an integration interface, not a claim that every harness has a particular callback.

## Verification and sources

The new offline suite exercises real CLI/NDJSON and plugin-wrapper subprocesses,
replay across restart and board relocation, receipt races, late files, deduplication,
heartbeat quietness, callback retry, deadline validation and source immutability.
The current official CLI `claude plugin validate integrations/claude-code` passes
with 2.1.323 (directory-listing warnings note the absent icon/marketplace install
entry; this is a local opt-in plugin, not a marketplace publication). Its published
`sdk-tools.d.ts` confirms `MonitorInput` includes required `description` and
`timeout_ms`, plus mutually exclusive `command`/`ws` sources. Authenticated
model event delivery and interactive UI behavior have not been tested here; those
still require a live Claude session with Monitor enabled. No paid model call was made.
See [per-command validation results](external-harness-validation.md).

Primary references (consulted 2026-11-13):

- [Claude tools / Monitor](https://code.claude.com/docs/en/tools-reference#monitor-tool)
- [Plugin monitor components](https://code.claude.com/docs/en/plugins/components#monitors)
- [Plugin monitor manifest](https://code.claude.com/docs/en/plugins/manifest-reference#monitors)
- [Programmatic runs and background work](https://code.claude.com/docs/en/headless#background-tasks-at-exit)
- [Hook matching for Monitor](https://code.claude.com/docs/en/hooks#match-monitor-commands)
- [Anthropic's published Claude Code package](https://www.npmjs.com/package/@anthropic-ai/claude-code), version 2.1.323, `sdk-tools.d.ts`.
