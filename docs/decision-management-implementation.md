# Decision Management v1 implementation

## Inspection and plan

The existing CLI and model tools live in `src/deepseek-watch.js`. The shared board,
mailboxes, ownership leases, heartbeat and task records live in
`src/agent-coordination.js`. Session JSON is atomically written by
`src/session-memory.js`; board selection is saved in session configuration.
`src/migration.js` already copies all coordination files recursively and rewrites
session board paths. Native Claude/Codex tool loops cannot join the API board.

Implementation sequence:

1. Preserve the founder specification in `decision-management-v1.md`.
2. Add a dependency-free decision store on the existing board, using immutable
   revisions, exclusive atomic publication and revision conflict detection.
3. Add model interfaces using trusted runtime identities and a separate local
   operator CLI for human resolutions.
4. Derive task blocking and revalidation from decisions, preserving old records.
5. Retry durable notifications through the existing inbox, on startup, tool
   operations, turn boundaries and parked polling.
6. Cover permissions, duplicate creation, concurrent writes, recovery, migration,
   dependent tasks, CLI and model integration with automated tests.
7. Run the existing suites, update swarm guidance, and prepare a PR.

## Storage and recovery

Each board gains `decisions/decision-<hash>/<revision>.json`. The ID hashes the
normalized project and original question (case and whitespace insensitive).
Each revision contains the complete record and actor-stamped history. Revision
numbers start at 1; temporary files never count as commits. Write, fsync, then
exclusive hard-link publication prevents partial JSON and lost updates without
stale process locks. Directory fsync runs on POSIX. A revision mismatch or competing
publication returns a conflict; callers must reload rather than blindly retry.

The filesystem must support atomic exclusive hard links (e.g. local NTFS/ext4).
Unsupported storage fails explicitly; there is no unsafe overwrite fallback.
Orphan `.tmp-*` files after a crash can be removed when no writer is active.
Committed malformed JSON, schema errors or revision gaps fail closed: restore
from a verified backup rather than skipping an unreadable approval.

No decision approval is cached in session transcripts. Restarted/replaced agents
use the saved board and read current revisions. Migration's existing recursive
copy includes decision history without changing IDs or project labels. Explicit
`--coord-dir` continues to select legacy directories.

## Authority and lifecycle

Categories are arrays; the highest authority applies. `routine` allows the
proposing worker to resolve; `technical`, `architecture`, `library`, `algorithm`
and `implementation` require a coordinator. `product`, `ux`, `business`, `pricing`,
`legal`, `security` and `financial` require a human. Use the technical categories
for routine implementation of already approved security/financial requirements;
new security/financial policy belongs in the human categories. Categories cannot
reduce a decision's established authority. Any coordinator can resolve a technical
decision after replacement; the assigned coordinator ID remains the routing hint.

Model tool authority comes from the running agent record, never tool arguments,
messages, session text or a claimed approval. Review permission blocks mutations.
The operator's `switchyard decisions resolve` is the human entry point.

This follows the existing trusted-local-filesystem security model. It is not an
OS sandbox: anyone who can modify board files, run arbitrary shell commands as
the operator, or launch a different agent role can bypass application checks.
Use Switchyard permissions and OS isolation for untrusted code. Tool-level role
checks cannot authenticate the truth of a model's category classification; agents
must include all applicable categories and escalate ambiguous requirements.

Creation starts `proposed`. Proposals can become `classified`, `pending` or
`blocked` and clear prior approval. An authorized resolution can approve, reject,
block, cancel or supersede an unresolved decision. Approved decisions progress to
implemented, then verified; they may also be cancelled/superseded. Rejected
decisions may be cancelled/superseded. Cancelled/superseded records are terminal.
Reopen other decisions using `decision_propose`, then obtain fresh approval.
Every mutation requires `expected_revision` and reasoning; resolutions also
require resolution text. Supersession requires a different existing decision in
the same project and never silently transfers dependencies or approvals.

Exact normalized duplicates reuse the existing record without changing history.
Higher-authority duplicate submissions fail with instructions to escalate the
existing decision. Coordinators handle related, differently worded questions by
researching and explicitly superseding duplicates; there is no semantic merging.

## Tasks and notifications

`agent_task_create.decision_dependencies` lists required IDs. Unknown IDs are
rejected. Existing tasks with no dependencies behave as before. `agent_task_list`
and `switchyard tasks` expose `decisionBlockers`, `changedDecisions`,
`needsRevalidation`, and observed/current revision maps. Only approved,
implemented or verified decisions carrying approval evidence permit work.
Task claims pin current revisions; handoff checks them again. A changed or
unresolved dependency blocks handoff except a `blocked` report. After reviewing
and revalidating changed work, call `agent_claim` again to acknowledge the current
approved revisions, then hand off. Completed tasks remain visible with a
revalidation flag after later decision changes. Any revision change conservatively
requires review, including lifecycle or recommendation changes.

The decision's optional `affected_tasks` links are advisory. Those tasks appear
in `affectedWork` with `advisoryRevalidation` after changes even without an explicit
dependency; only task `decision_dependencies` enforce blocking and pinned revisions.

Revalidation acknowledgements use atomic lease-specific sidecars under `claims/`
so they cannot overwrite a concurrently replaced claim owner. Existing readers
ignore these files. Unreadable acknowledgements require explicit review/reclaim.

Decision records and task records are separate atomic files, not a database
transaction. A decision can change immediately after a task check; subsequent
listing/handoff detects it. This does not cancel already running commands.

Current revisions serve as durable notification intents. Deterministic mailbox
IDs make retry idempotent, including after acknowledgement. Proposers, assigned
coordinators and claim owners receive updates; live replacement coordinators
also receive unresolved questions. A parked process polls for recovery. If a
recipient is not registered yet, the decision remains queryable and later retry
delivers it after registration. Notification errors are reported separately from
successful commits. Operators see human questions with `decisions list
--authority human`; there is no external messaging or automatic human approval.
Approval wakes registered parked recipients. A stopped agent resumes through the
existing explicit resume workflow; decision notifications do not create agents.

## Operator examples

```sh
switchyard decisions list --authority human --coord-dir /shared/board
switchyard decisions get decision-<32 hex digits> --coord-dir /shared/board
switchyard decisions history decision-<32 hex digits> --coord-dir /shared/board
switchyard decisions resolve decision-<32 hex digits> --expected-revision 2 \
  --status approved --resolution "Use option A" --reasoning "Approved after reviewing trade-offs" \
  --coord-dir /shared/board
```

Commands emit JSON and require no provider connection. Inspect the question,
options, recommendation, affected work and revision before resolving. Stale
revisions fail instead of approving an unseen change. The same resolve command
records rejection or later lifecycle states with `--status`.

## Scope and founder questions

The dedicated TUI panel is deferred under the specification's scope allowance;
the existing TUI can use decision tools and the CLI exposes all operator actions.
No product-level question currently blocks this implementation. No rental
platform work, deployment or merge is included.
