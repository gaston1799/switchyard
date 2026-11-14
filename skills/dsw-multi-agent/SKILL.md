---
name: dsw-multi-agent
description: Coordinate Switchyard agents with stable IDs, durable messages, bounded task claims, shared decisions, handoffs, coordinator-only spawning/resume, context compaction, and parked wait/wake sessions.
---

# Switchyard multi-agent coordination

The historical `dsw-multi-agent` skill ID and CLI aliases remain compatible.

## External harness notifications

Keep three components separate: **existing shell heartbeat**, the provider-independent
**Switchyard event watcher**, and the **harness-specific notification adapter**.
Preserve the existing external heartbeat/registration and use its absolute board
and agent ID. Watchers do not establish liveness or acquire decision authority.

In Claude Code, use the native `Monitor` tool, not a silent background Bash tail:
`switchyard events adapter claude-code --agent-id ID --consumer STABLE-SESSION-ID
--coord-dir /shared/board` returns the native tool input. Pass that `input` to
Monitor only after checking availability and permissions. Each stdout line is one
structured event; heartbeat rewrites and quiet polls emit nothing. Renew an expired
manual Monitor with the same consumer (default 5 minutes, max 30 interactive / 10
for `-p`). An opt-in plugin in `integrations/claude-code/` can start a persistent
monitor automatically in interactive sessions; plugin monitors do not start in
`-p` runs. Check `/tasks` before starting another watch. Read its setup and
`docs/external-harness-integration.md` for current version/platform limitations.

Deduplicate by `eventId` and inspect current authoritative state before acting.
After durably recording/handling receipt, run `switchyard events ack EVENT_ID`
with the same board, agent ID and consumer. Writing stdout is not acknowledgement.
Unacknowledged events replay after crash/reconnect/expiration; handlers must be
idempotent. This receipt does not consume the inbox, approve decisions or claim
tasks. It never substitutes for founder approval.

Other harnesses use a supported callback, background-task completion notification,
bounded `switchyard events poll --wait-ms 30000`, or ordinary polling. Do not assume
they implement Claude Monitor or use undocumented stdin/terminal injection. Native
Switchyard Claude runs in print/stream-json mode, so do not assume the interactive
plugin autostarts there. Closed sessions require the harness's supported resume
mechanism; neither a heartbeat nor an event file can wake an ended model process.

## Decision workflow

Read `switchyard-decisions` for the full procedure. Check `decision_list` before
dependent work; coordinators also review pending questions on startup/replacement.
Use `decision_create/get/propose/resolve/escalate/history` for durable records.
Workers resolve only their own routine implementation choices within approved
requirements. Escalate unresolved, consequential and cross-agent questions to the
assigned coordinator. Coordinators resolve technical questions and research product
options; product behavior, UX, business rules, pricing, legal ownership and major
security/financial decisions require the founder. Include all applicable categories;
highest authority wins. Never invent human approval or run the operator resolution
command on the founder's behalf. Batch nonurgent questions with context, trade-offs
and a recommendation. Use explicit supersession to deduplicate related questions.

Declare task `decision_dependencies`. Unresolved decisions block only dependent
tasks. After approval, resume dependent work; approval wakes registered parked
recipients, while stopped agents use explicit resume. Changes expose affected
tasks and `needsRevalidation`: review the new revision, revalidate work and call
`agent_claim` again before handoff. Decision mutations need `expected_revision`;
reload and review conflicts. Human operators use `switchyard decisions list`,
`get`, `resolve` and `history`.

Every Switchyard session has an `agent_id`, even when `--agent-id` is omitted. Use:

- `agent_identity` to confirm your own ID, role, mission, workspace, and state.
- `agent_list` to discover live peers before planning or delegating.
- `agent_send` for messages, status requests, delegation, and wakeups.
- `agent_task_create` as a coordinator to define bounded scope and acceptance criteria.
- `agent_task_list` and `agent_claim` before changing files for shared work.
- `agent_handoff` to record results and notify a coordinator or dependent worker.
- `compact_session` — compact your OWN session now (free up context; `force: true` below the auto threshold).
- `agent_compact <agent_id>` — compact another agent (live target: inbox request applied on its next wake/turn; stopped target: session file compacted directly with a `.compact-bak`).
- `spawn_agent` / `resume_agent` — COORDINATOR-ONLY swarm growth (see below).
- `agent_wait` only after saving/checkpointing current work and when no tool operation is still required.

Messages to a working agent queue until a safe turn boundary. Messages to an agent parked with `agent_wait` wake the wrapper and resume the same saved session. The sender appears inside an `<agent_message from="...">` block; API message roles remain standard.

Messages (`message`, `handoff`, or `wake`) sent to an agent that ended normally with state `completed` automatically start that agent's saved session headlessly and deliver the inbox message. This is not applied to `failed` agents, which remain stopped for diagnosis; use an explicit resume after fixing the failure.

Do not edit a scope claimed by another agent unless it explicitly hands the task off. Use separate Git worktrees for agents that write source files. All agents in separate worktrees must receive the same absolute `--coord-dir`.

## Resuming agents and sessions

- In the interactive startup flow, API-backed new runs ask whether this session is a **Coordinator** or **Worker**. The flow creates a stable agent ID and uses the central per-workspace board under `~/.switchyard/coordination/workspaces/` by default (or an explicit legacy `--coord-dir`); enter the same absolute directory in every worktree to share a board across them. Coordinators can enter a mission; workers can enter a coordinator ID and mission, or leave the ID blank to discover a coordinator from the board.
- Native Codex and Claude provider-owned tool loops do not automatically expose Switchyard's API-backed coordination tools. An externally registered session may observe the board through the event watcher and its supported notification adapter; this does not grant model-tool mutation authority. Choose an API-backed connection for the existing complete swarm tool workflow.

- `switchyard --resume` with a shared coordination board containing agents now offers a combined picker: **coordination agents first** (id, state, session), then saved sessions. Picking an agent resumes that agent's session and identity.
- `switchyard --agent-id <existing>` (no `--session`, no `--new`) auto-resumes that agent's most recent session — via the workspace session list, falling back to the agent's **coordination record** (which stores the definitive absolute session path, so it works from any cwd).
- Resuming an id that is **currently live** fails with "already active" — one process per id.

## Coordinator-only swarm growth

Workers are FORBIDDEN from spawning agents — the tools reject them. Only `--agent-role coordinator` may grow the swarm:

- `spawn_agent {agent_id, display_name, prompt, role?, mission?, model?, permission?}` — spawns a NEW agent as a **detached headless background process** (non-blocking: the coordinator keeps working). Always choose a concise, descriptive `display_name` for the dashboard; use `agent_id` as the stable routing identity. The caller's working directory and shared `--coord-dir` are pulled automatically. **Fails if `agent_id` already exists** and tells you to use `resume_agent` instead.
- `resume_agent {agent_id, prompt, ...}` — spawns an EXISTING id as a detached background process, resuming its saved session (state, mission, claims). **Fails if the id has no coordination record** (use `spawn_agent`) or is **currently live**.

Spawned workers run headless (no window — console windows can't be created reliably from the wrapper context; that is why a node-spawned `powershell.exe`/`cmd /c start` window opens but never executes). The tool verifies registration by polling the agent's coordination record (fresh heartbeat) and reports the registered PID. For **tiled, visible windows**, use `launch.ps1` from a terminal instead — it spawns via `Start-Process` which does create real windows.

After spawning, verify with `agent_list`, then `agent_send`/`wake` the new id as usual. The spawned agent registers under the same coordination directory, so it appears on the shared board immediately.

## Compaction coordination

Sessions auto-compact at `--compact-at` (default 0.9) of the messages budget (`--compact-limit` minus completion). In coordination:

- `compact_session [force]` — an agent compacts its own in-memory transcript on demand; returns before/after token estimates.
- `agent_compact <agent_id> [method]` — compacts another agent: if the target is **live**, an inbox `compact` request is applied mechanically on its next wake/turn (the wrapper compacts and replies with the result; no LLM involvement in the mechanics); if the target is **stopped/failed**, its session file is compacted directly (`.compact-bak` kept) so its next launch resumes compacted.

## Operator commands

```powershell
switchyard agents --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard message worker-1 "Please report current status." --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard wake worker-1 "The dependency is ready; continue." --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard tasks --coord-dir D:\MyServer\.deepseek-watch\coordination
```

`agent_wait` parks indefinitely when `timeout_seconds` is omitted or zero. A finite timeout resumes the model with an explicit timeout event.

## Example launch

```powershell
switchyard --agent-id coordinator --agent-role coordinator --agent-mission "Plan, delegate, and review; do not implement worker tasks." --coord-dir D:\MyServer\.deepseek-watch\coordination -p "Explore the repository, discover agents, and coordinate the remaining work."
```
