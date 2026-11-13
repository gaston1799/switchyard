# Decision Management v1 validation

Validated on Linux with Node v24.22.1 on 2026-11-13. Dependencies were installed
with `npm ci --ignore-scripts --no-audit --no-fund`; package and lockfile dependency
versions were not changed. No live model credentials or paid requests were used.

All 36 root npm check/test/smoke scripts and two additional standalone automated
suites were executed: **37 passed, 1 failed**. The new decision suite contains
**15 passing tests**, including a mock-provider CLI/inbox/task end-to-end flow.

The run sets `SWITCHYARD_NO_SUPPORT_PROMPT=1` so an optional donation prompt cannot
interrupt scripted terminal input. Without it, the unchanged native startup test
also failed during the initial baseline. With it, that suite passes.

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
| `npm run test:computer` | FAIL: Windows-only runtime unavailable on Linux |
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
| `node --test scripts/self-test-model-catalog.mjs` | PASS |
| `node scripts/self-test-project-routing.mjs` | PASS |

## Existing platform failure

`test:computer` fails eight checks because the native Computer Use implementation
requires Windows PowerShell 5.1, .NET Framework reference assemblies and Windows
UI APIs. The Linux errors include `Computer Use is Windows-only` and
`spawn powershell.exe ENOENT`. This suite also failed on the unchanged baseline.
The opt-in input self-test was not enabled. No unrelated toolpack changes were made.

## Coverage and limits

The decision tests exercise worker/coordinator/human permissions, mixed categories,
role impersonation attempts, review mode, classification changes, escalation,
replacement coordinators, all lifecycle states, history, supersession, exact
duplicates, same-process and independent-process write conflicts, stale revisions,
interrupted publication, restart, old session JSON, missing/corrupt records,
dependency blocking, unrelated tasks, revalidation, durable notification retry,
acknowledgement idempotence, parked wake, human CLI resolution, and migration.

The two browser snippet files (`self-test-ui-browser.js` and
`self-test-sidebar-browser.js`) require an isolated renderer preview/PBC fixture;
that fixture is not shipped in the repository. They are not npm test scripts and
were not executed. The automated renderer syntax/transcript/dashboard/file-review
suites passed. `live-test-security.mjs` is a manual external-target smoke script,
not an offline automated suite, and was not run. Native Windows behavior still
requires a Windows validation run.

After the final review, `check`, `test:decisions`, `test:coordination`,
`test:coordination:e2e` and `git diff --check` were rerun for the final changes.
