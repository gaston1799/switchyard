# External harness integration validation

Validated on Linux, Node v24.22.1, 2026-11-13.

## Results

All 37 root npm check/test/smoke scripts, the two standalone automated suites,
and the real Claude plugin validator were executed: **39 of 40 commands passed**.
The watcher suite was rerun after the final stdout-disconnect test was added:
**19/19 watcher/adapter tests pass**. All **15/15 decision tests** also pass.
`git diff --check` passes.

After the final standalone-executable descriptor compatibility review, `check`,
`test:events` and `smoke` were rerun. The adapter test covers both JavaScript and
standalone executable command prefixes; actual Windows execution remains a live
platform validation item.

The full sweep used `SWITCHYARD_NO_SUPPORT_PROMPT=1`, as in the prior decision
management validation, to prevent the optional donation prompt from interrupting
scripted terminal input. No paid model call was made.

| Command | Result |
| --- | --- |
| `npm run check` | PASS |
| `npm run test:patch` | PASS |
| `npm run test:skills` | PASS |
| `npm run test:agent-session` | PASS |
| `npm run test:migration` | PASS |
| `npm run test:retry` | PASS |
| `npm run test:security` | PASS |
| `npm run test:offensive` | PASS |
| `npm run test:re` | PASS |
| `npm run test:runtime` | PASS |
| `npm run test:fuzz` | PASS |
| `npm run test:bounty` | PASS |
| `npm run test:tui` | PASS |
| `npm run test:update` | PASS |
| `npm run test:docker` | PASS |
| `npm run test:computer` | FAIL: existing Windows-only runtime on Linux |
| `npm run test:balance` | PASS |
| `npm run test:history` | PASS |
| `npm run test:workspace-paths` | PASS |
| `npm run test:support-prompt` | PASS |
| `npm run test:native` | PASS |
| `npm run test:providers` | PASS |
| `npm run test:compaction` | PASS |
| `npm run test:search` | PASS |
| `npm run test:sandbox` | PASS |
| `npm run test:task-state` | PASS |
| `npm run test:triage` | PASS |
| `npm run test:toolpacks` | PASS |
| `npm run test:foundation` | PASS |
| `npm run test:coordination` | PASS |
| `npm run test:dashboard` | PASS |
| `npm run test:ui` | PASS |
| `npm run test:coordination:e2e` | PASS |
| `npm run smoke` | PASS |
| `npm run test:pricing` | PASS |
| `npm run test:decisions` | PASS |
| `npm run test:events` | PASS |
| `node --test scripts/self-test-model-catalog.mjs` | PASS |
| `node scripts/self-test-project-routing.mjs` | PASS |
| `claude plugin validate integrations/claude-code (2.1.323)` | PASS |

## New coverage

- Real CLI NDJSON with multiline/Unicode messages and no provider connection.
- Per-consumer durable acknowledgements; independent receipts for different sessions.
- Replay across process restart, watcher expiration/renewal and board relocation.
- Concurrent receipt publication, idempotent ack, unknown IDs and consumer binding.
- Late older journal files and corrupted/partial source retry without data loss.
- Quiet heartbeats, quiet idle polling and unrelated-task filtering.
- Relevant task/lifecycle routing and direct immutable decision revision recovery.
- Deduplication across inbox-to-processed moves and matching decision notifications.
- Corrupt decision fallback to the addressed mailbox notice, without inferred approval.
- Callback retry and acknowledgement only after declared durable acceptance.
- Required native Monitor fields, shell quoting, interactive/print deadline limits.
- Real plugin-wrapper child processes, restart backoff and stable-consumer replay.
- SIGTERM cleanup, unconfigured plugin stdout silence, and stdout disconnect recovery.
- Byte-for-byte heartbeat and decision record preservation during observation/receipt.

## Official Claude verification

Installed Anthropic's published `@anthropic-ai/claude-code@2.1.323` in a scratch
prefix solely for schema/CLI validation. No runtime dependency or lockfile change
was added to Switchyard. Its `sdk-tools.d.ts` declares required Monitor
`description`/`timeout_ms`, optional `command`/`ws`, native task IDs and persistent
monitor output. The adapter includes the required fields and validates documented
time limits.

The actual `claude plugin validate integrations/claude-code` command passes.
It also emits non-blocking plugin-directory listing warnings about no icon or
marketplace install line: this is an opt-in local plugin, not a marketplace
publication. Monitor fields/paths were accepted without inventing schema keys.

`claude auth status` reports `loggedIn: false`, `authMethod: none` here. Therefore
actual authenticated native Monitor notifications, interactive plugin startup
inside a signed-in session, and real provider/platform availability remain live
client checks. The tests exercise the real process bridge and the documented tool
input, not a claim that a paid Claude session was tested.

Research sources and mode limits are preserved in
[the integration plan](external-harness-integration.md#verification-and-sources).

## Existing platform limitation

`test:computer` fails the same eight native Windows checks as before this change.
Windows PowerShell, .NET Framework assemblies and Windows UI APIs are unavailable
on this Linux host (`powershell.exe ENOENT`, `Computer Use is Windows-only`).
Windows Monitor/Git Bash behavior remains untested here.

The standalone browser snippets still require an isolated preview fixture absent
from the repository; the registered automated UI suites pass. The external-target
manual live security smoke script was not run.

## Compatibility review

No changes were made to `src/agent-coordination.js`, `src/decisions.js`,
`src/decision-tools.js`, `src/session-memory.js`, or `src/native-backends.js`.
Existing heartbeat, registration, inbox delivery, task/decision permissions and
native session transport remain intact. Only additive `events` CLI routing,
observer modules, opt-in plugin files, documentation and tests are introduced.
The existing recursive migration includes `subscriptions/` without a migration
rewrite. Existing sessions/boards require no schema migration.
