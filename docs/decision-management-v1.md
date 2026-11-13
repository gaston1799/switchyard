# Decision Management v1

Authoritative initial specification supplied by the founder on 2026-11-13.

## Objective

Implement a native decision management system in Switchyard, integrated with the existing coordinator/worker architecture, coordination board, agent lifecycle, session persistence, CLI, and Claude swarm skill.

Do not rewrite existing systems unnecessarily.

## Decision authority

Worker autonomy:
Workers can make routine implementation decisions within approved requirements. Unresolved, consequential, or cross-agent decisions must go to their assigned coordinator.

Coordinator autonomy:
Coordinators can resolve technical decisions, including architecture, libraries, algorithms, and implementation strategies, provided they remain within approved requirements and security constraints.

Human authority:
Product behavior, UX requirements, business rules, pricing, legal ownership, and major security or financial decisions require my approval.

If a decision spans multiple categories, apply the highest required authority.

## Decision lifecycle

Implement persistent decision records supporting:

* Proposed
* Classified
* Pending
* Approved
* Rejected
* Blocked
* Implemented
* Verified
* Superseded
* Cancelled

Each record should include a unique ID, project, question, category, proposer, assigned authority, status, options, recommendation, resolution, reasoning, timestamps, affected tasks, and history.

## Decision tools

Implement interfaces equivalent to:

* decision_create
* decision_list
* decision_get
* decision_propose
* decision_resolve
* decision_escalate
* decision_history

Adapt naming and signatures to existing Switchyard conventions.

Enforce authorization in the tool layer, not just agent prompts. A worker must never be able to approve a founder-level decision.

## Task integration

Tasks may declare dependencies on decisions.

Unresolved required decisions block dependent tasks, not unrelated work.

Changing a decision must identify potentially affected work for revalidation.

## Coordinator responsibilities

* Receive worker escalations.
* Deduplicate related questions.
* Resolve authorized technical decisions.
* Research options for product-level decisions.
* Present human decisions with context, trade-offs, and recommendations.
* Batch nonurgent questions where appropriate.
* Resume dependent work after approval.
* Never fabricate human approval.

## Persistence and recovery

Decision records must survive session restarts, coordinator replacement, crashes, and project migration.

Reuse the existing coordination persistence architecture wherever practical.

Support concurrent agents safely, including conflict detection and atomic updates.

Maintain an auditable decision history.

## CLI and TUI

Provide CLI access for listing, inspecting, resolving, and viewing decision history.

Use naming consistent with the existing CLI.

A dedicated TUI decision panel is desirable, but can be deferred if it would significantly expand scope.

## Compatibility

Preserve existing agent messaging, spawning, resumption, coordination boards, heartbeat lifecycle, session persistence, and Claude swarm integration.

Update the swarm skill and relevant documentation to describe the decision workflow.

## Testing

Test authorization boundaries, escalation, concurrent updates, duplicate decisions, persistence, restart recovery, dependency blocking, decision changes, and backward compatibility.

## Execution instructions

1. Inspect the existing repository architecture.
2. Save this specification in the repository.
3. Produce an implementation plan.
4. Make routine technical decisions autonomously.
5. Implement Decision Management v1.
6. Add automated tests.
7. Run existing and new tests.
8. Update documentation and swarm guidance.
9. Create a pull request with results and limitations.

Work in a dedicated feature branch. Do not merge or deploy.

Do not begin the rental platform.

If a genuinely unresolved product decision blocks implementation, ask me. Otherwise, proceed using your technical judgment.
