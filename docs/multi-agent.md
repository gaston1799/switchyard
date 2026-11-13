# Multi-agent coordination

Switchyard can run coordinator and worker sessions with stable agent identities, durable filesystem mailboxes, task claims, handoffs, and parked wait/wake behavior. Legacy `dsw` and `d` aliases remain supported.

## Start agents

Use one shared absolute coordination directory. Writers should use separate Git worktrees even though their coordination directory is shared.

```powershell
switchyard --agent-id coordinator --agent-role coordinator --agent-mission "Plan, delegate, and review." --coord-dir D:\MyServer\.deepseek-watch\coordination -p "Explore the repository, discover running agents, and coordinate a course to finish the project."

switchyard --agent-id worker-storage --agent-role worker --coordinator-id coordinator --agent-mission "Implement storage reconciliation and warning delivery." --coord-dir D:\MyServer\.deepseek-watch\coordination -p "Announce yourself to the coordinator, inspect shared tasks, claim your assigned task, and begin."
```

When `--agent-id` is omitted, the wrapper generates an ID, prints it, saves it in session configuration, and restores it on resume. Every model system prompt includes the current ID, role, mission, and coordination directory.
When a worker knows the coordinator ID, pass `--coordinator-id` (or set `DEEPSEEK_COORDINATOR_ID`). The system prompt tells the worker to send its initial status directly to that coordinator before using `agent_list`.

## Operator commands

```powershell
switchyard agents --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard agents --all --json --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard message worker-storage "Send me your current status." --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard wake worker-storage "The dependency is ready; continue." --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard inbox worker-storage --coord-dir D:\MyServer\.deepseek-watch\coordination
switchyard tasks --coord-dir D:\MyServer\.deepseek-watch\coordination
```

`message` and `wake` create one immutable JSON file in the recipient's inbox. The recipient acknowledges it only after the tagged message has been appended to its saved session.

## Model tools

- `agent_identity`: current identity and runtime record.
- `agent_list`: registered live agents and optional stale/completed records.
- `agent_send`: durable peer message.
- `agent_check_inbox`: non-consuming inbox peek.
- `agent_task_create`: coordinator-only task creation.
- `agent_task_list`: tasks, scopes, dependencies, status, and claims.
- `agent_claim`: atomic task ownership lease.
- `agent_handoff`: task result plus optional recipient notification.
- `agent_wait`: finish the current tool batch, park the wrapper, and resume on a message or timeout.
- `decision_create`, `decision_list`, `decision_get`, `decision_propose`, `decision_resolve`, `decision_escalate`, `decision_history`: durable shared decisions with runtime authority checks. See the [decision workflow](decision-management-implementation.md).

Workers resolve only their own routine choices and escalate consequential or
cross-agent questions to their assigned coordinator. Coordinators resolve technical
decisions; product/UX/business/pricing/legal and major security/financial choices
require the founder. Declare required IDs in `agent_task_create.decision_dependencies`.
Unapproved decisions block only dependent tasks; changed revisions flag affected
work for revalidation. Review, revalidate, then reclaim to acknowledge new approval.
Coordinators check pending questions on startup/replacement, research and batch human
questions, and resume dependent work after approval. Mailbox content is not approval.
Operators use `switchyard decisions list|get|history|resolve`.

Messages use standard API roles. Sender identity is represented as tagged content:

```text
<agent_message from="worker-storage" type="handoff" task="storage-warning" priority="normal">
Implementation and focused tests are ready for review.
</agent_message>
```

## Filesystem layout

```text
.deepseek-watch/coordination/
  agents/       one atomically updated runtime record per agent
  inbox/        one immutable-message directory per recipient
  processed/    acknowledged messages
  tasks/        bounded task contracts
  claims/       atomic task leases
  events/       append-only coordination events
  decisions/    immutable revisions and auditable decision history
```

The wrapper heartbeat marks live processes. `switchyard agents` shows live agents by default; `--all` includes completed, failed, stopped, and stale records. Messages to a busy agent are delivered at a model/tool boundary. A parked wrapper has no active model request while waiting.
