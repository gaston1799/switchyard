---
name: switchyard-decisions
description: Manage durable Switchyard decisions, escalate to coordinators or the founder, inspect task dependencies, and revalidate work after decision changes.
---

# Switchyard decisions

Use the running Switchyard agent's shared coordination board. Decisions survive
session restart, coordinator replacement and migration; messages alone never
constitute approval. Native Claude/Codex sessions still need an API-backed
Switchyard connection for these model tools. External sessions can receive
decision notifications through `switchyard events watch` and a supported harness
adapter (Claude's native Monitor or its opt-in plugin). Event receipts never
change decision authority; see `docs/external-harness-integration.md`.

1. Check `decision_list` before dependent work. Coordinators review unresolved
   questions on startup, including after replacing another coordinator.
2. Use `decision_create` with a stable project label, one concrete question,
   every applicable category, options, recommendation, reasoning and affected tasks.
   Exact normalized duplicates reuse the ID. Review related wording manually;
   coordinators may supersede duplicates with an explicit `superseded_by` ID.
3. A worker may resolve only its own `routine` implementation decision within
   approved requirements. Escalate unresolved, consequential or cross-agent choices
   to the assigned coordinator with `decision_escalate`.
4. Coordinators resolve `technical`, `architecture`, `library`, `algorithm` and
   `implementation` questions within approved requirements. Product behavior, UX,
   business rules, pricing, legal ownership and major security/financial choices
   require the founder (`product`, `ux`, `business`, `pricing`, `legal`, `security`,
   `financial`). Include all applicable categories; highest authority wins.
5. Use `decision_propose` for research, trade-offs and recommendations. It clears
   previous approval. Batch nonurgent founder questions with context and escalate
   to `human`. Present them to the operator, who resolves through the CLI. Never
   invoke the human approval command on the operator's behalf or invent approval.
6. Use `decision_get` before mutation and pass `expected_revision`. On conflict,
   reload and review intervening history. Include reasoning and resolution text.
7. Declare required IDs in `agent_task_create.decision_dependencies`. Only approved,
   implemented or verified decisions allow claims and normal handoff. Report
   blocking decisions, then choose unrelated approved work.
8. Inspect `decision_get.affectedWork` and `agent_task_list.needsRevalidation`
   after changes. Revalidate implementation, then `agent_claim` again to acknowledge
   current approved revisions. Approval wakes registered parked recipients; resume
   stopped workers through the existing explicit workflow.
9. Record implementation and verification with authorized `decision_resolve`
   transitions (`approved` → `implemented` → `verified`). Human-level transitions
   remain human-authorized. Read `decision_history` for the audit trail.

```sh
switchyard decisions list --authority human --coord-dir /shared/board
switchyard decisions get decision-<32 hex digits> --coord-dir /shared/board
switchyard decisions history decision-<32 hex digits> --coord-dir /shared/board
```

See `docs/decision-management-implementation.md` in the Switchyard repository for
record format, operator resolution examples, recovery and trust boundaries.
