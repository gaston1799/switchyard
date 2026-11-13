import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDecision, changeDecision, getDecision, listDecisions } from '../src/decisions.js';
import { DECISION_TOOL_SCHEMAS, runDecisionTool, runDecisionsCli, reconcileDecisionNotifications } from '../src/decision-tools.js';
import { createTask, claimTask, completeTask, listTasks, createAgentRuntime, readAgentInbox, acknowledgeAgentMessages, waitForAgentMessages } from '../src/agent-coordination.js';
import { newSession, readSession, writeSession } from '../src/session-memory.js';
import { migrateLegacyData } from '../src/migration.js';

const worker = { id: 'worker-one', role: 'worker', coordinatorId: 'coordinator-one' };
const coordinator = { id: 'coordinator-one', role: 'coordinator' };
const human = { id: 'operator', role: 'human' };
const proposal = (category = ['technical'], question = 'Which parser?') => ({ project: 'Switchyard', question, category, options: ['A', 'B'], recommendation: 'A', reasoning: 'Preserves existing behavior.' });
const resolution = (record, status = 'approved') => ({ expected_revision: record.revision, status, resolution: 'Use A', reasoning: 'Reviewed requirements and trade-offs.' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'switchyard-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const opts = (root, actor = worker, permission = 'full') => ({ coordDir: root, permission, agentRuntime: { record: { agentId: actor.id, role: actor.role, coordinatorId: actor.coordinatorId } } });
function child(code, args = []) {
  return new Promise((done, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    process.stdout.on('data', chunk => output += chunk);
    process.stderr.on('data', chunk => error += chunk);
    process.once('error', reject);
    process.once('exit', code => done({ code, output, error }));
  });
}

test('tool permissions use runtime identity, highest category, and never accept human impersonation', async t => {
  const root = await fixture(t);
  assert.deepEqual(DECISION_TOOL_SCHEMAS.map(item => item.function.name).sort(), ['decision_create', 'decision_escalate', 'decision_get', 'decision_history', 'decision_list', 'decision_propose', 'decision_resolve'].sort());
  for (const category of ['product', 'ux', 'business', 'pricing', 'legal', 'security', 'financial']) {
    const record = await runDecisionTool('decision_create', proposal(['technical', category], `Question ${category}?`), opts(root));
    assert.equal(record.assignedAuthority, 'human');
    for (const actor of [worker, coordinator]) {
      await assert.rejects(runDecisionTool('decision_resolve', { decision_id: record.id, ...resolution(record) }, opts(root, actor)), /human authority/);
    }
    for (const spoof of [{ role: 'human' }, { actor: human }, { human: true }, { approved_by: 'founder' }]) {
      await assert.rejects(runDecisionTool('decision_resolve', { decision_id: record.id, ...resolution(record), ...spoof }, opts(root)), /cannot be supplied/);
    }
    await assert.rejects(runDecisionTool('decision_resolve', { decision_id: record.id, ...resolution(record) }, opts(root, { id: 'spoof', role: 'human' })), /worker or coordinator runtime/);
    assert.equal((await getDecision(root, record.id)).revision, 1);
  }
  const routine = await createDecision(root, proposal(['routine']), worker);
  await assert.rejects(changeDecision(root, routine.id, resolution(routine), { id: 'other', role: 'worker' }, 'resolve'), /worker authority/);
  assert.equal((await runDecisionTool('decision_resolve', { decision_id: routine.id, ...resolution(routine) }, opts(root))).status, 'approved');
  const technical = await createDecision(root, proposal(['architecture'], 'Storage?'), worker);
  await assert.rejects(runDecisionTool('decision_resolve', { decision_id: technical.id, ...resolution(technical) }, opts(root)), /coordinator authority/);
  assert.equal((await runDecisionTool('decision_resolve', { decision_id: technical.id, ...resolution(technical) }, opts(root, coordinator))).status, 'approved');
  await assert.rejects(runDecisionTool('decision_create', proposal(), opts(root, worker, 'review')), /session permission/);
  assert.ok(Array.isArray(await runDecisionTool('decision_list', {}, opts(root, worker, 'review'))));
});

test('escalation is durable, cannot lower authority, and survives coordinator replacement', async t => {
  const root = await fixture(t);
  let record = await createDecision(root, proposal(['routine']), worker);
  record = await runDecisionTool('decision_escalate', { decision_id: record.id, expected_revision: record.revision, reasoning: 'Cross-agent impact.' }, opts(root));
  assert.equal(record.assignedAuthority, 'coordinator');
  const replacement = { id: 'replacement', role: 'coordinator' };
  record = await runDecisionTool('decision_resolve', { decision_id: record.id, ...resolution(record) }, opts(root, replacement));
  assert.equal(record.approval.actor, 'replacement');
  record = await changeDecision(root, record.id, { expected_revision: record.revision, reasoning: 'Product implications.' }, replacement, 'escalate');
  assert.equal(record.assignedAuthority, 'human');
  assert.equal(record.approval, undefined);
  await assert.rejects(changeDecision(root, record.id, { expected_revision: record.revision, authority: 'coordinator', reasoning: 'Skip human.' }, worker, 'escalate'), /cannot lower/);
  record = await changeDecision(root, record.id, { expected_revision: record.revision, category: ['routine'], reasoning: 'Attempted downgrade.' }, worker, 'propose');
  assert.equal(record.assignedAuthority, 'human');
  await assert.rejects(changeDecision(root, record.id, resolution(record), coordinator, 'resolve'), /human authority/);
});

test('exact duplicate questions deduplicate safely, including simultaneous creates', async t => {
  const root = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => createDecision(root, { ...proposal(), question: index % 2 ? ' WHICH  parser? ' : 'Which parser?' }, worker)));
  assert.equal(new Set(results.map(item => item.id)).size, 1);
  assert.equal((await listDecisions(root)).length, 1);
  assert.equal((await getDecision(root, results[0].id)).history.length, 1);
  await assert.rejects(createDecision(root, proposal(['product']), worker), /escalate the existing/);
  const anotherProject = await createDecision(root, { ...proposal(), project: 'Other project' }, worker);
  assert.notEqual(anotherProject.id, results[0].id);
});

test('concurrent revision publication has exactly one winner and rejects stale updates', async t => {
  const root = await fixture(t);
  const record = await createDecision(root, proposal(), worker);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => changeDecision(root, record.id, resolution(record), coordinator, 'resolve')));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.ok(results.filter(item => item.status === 'rejected').every(item => /revision conflict/.test(item.reason.message)));
  const saved = await getDecision(root, record.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.history.length, 2);
  await assert.rejects(changeDecision(root, record.id, resolution(record), coordinator, 'resolve'), /revision conflict/);
});

test('independent processes cannot overwrite a committed revision', async t => {
  const root = await fixture(t);
  const record = await createDecision(root, proposal(), worker);
  const code = `import { changeDecision } from './src/decisions.js';
    try { await changeDecision(process.argv[1], process.argv[2], { expected_revision: 1, resolution: 'A', reasoning: 'Cross-process test' }, { id: 'coordinator-one', role: 'coordinator' }, 'resolve'); console.log('committed'); }
    catch (e) { console.log(e.message); process.exitCode = 2; }`;
  const results = await Promise.all(Array.from({ length: 6 }, () => child(code, [root, record.id])));
  assert.equal(results.filter(item => item.code === 0).length, 1);
  assert.ok(results.filter(item => item.code !== 0).every(item => item.code === 2 && /revision conflict/.test(item.output)));
  assert.equal((await getDecision(root, record.id)).history.length, 2);
});

test('restart and interrupted publication preserve committed records and history', async t => {
  const root = await fixture(t);
  let record = await createDecision(root, proposal(['product']), worker);
  record = await changeDecision(root, record.id, resolution(record), human, 'resolve');
  await writeFile(join(root, 'decisions', record.id, '.tmp-crashed-writer'), '{partial');
  const emptyId = `decision-${'f'.repeat(32)}`;
  await mkdir(join(root, 'decisions', emptyId));
  await writeFile(join(root, 'decisions', emptyId, '.tmp-orphan'), '{');
  const result = await child(`import { getDecision, listDecisions } from './src/decisions.js'; console.log(JSON.stringify({ record: await getDecision(process.argv[1], process.argv[2]), count: (await listDecisions(process.argv[1])).length }));`, [root, record.id]);
  assert.equal(result.code, 0, result.error);
  const restored = JSON.parse(result.output);
  assert.deepEqual(restored.record, record);
  assert.equal(restored.count, 1);
  const sessionPath = join(root, 'old-session.json');
  const session = newSession({ workspace: root, systemPrompt: 'legacy', config: { coordDir: root } });
  await writeSession(sessionPath, session);
  assert.deepEqual(await readSession(sessionPath), JSON.parse(JSON.stringify(session)));
  assert.equal((await getDecision((await readSession(sessionPath)).config.coordDir, record.id)).approval.role, 'human');
});

test('corrupt committed records and revision gaps fail closed', async t => {
  const root = await fixture(t);
  const record = await createDecision(root, proposal(), worker);
  await writeFile(join(root, 'decisions', record.id, '3.json'), '{}');
  await assert.rejects(getDecision(root, record.id), /revision gap/);
  await rm(join(root, 'decisions', record.id, '3.json'));
  await writeFile(join(root, 'decisions', record.id, '1.json'), '{');
  await assert.rejects(listDecisions(root), SyntaxError);
  await createTask(root, { taskId: 'legacy', title: 'Old task', createdBy: coordinator.id });
  await writeFile(join(root, 'tasks', 'dependent.json'), JSON.stringify({ taskId: 'dependent', status: 'open', decisionDependencies: [record.id] }));
  const tasks = await listTasks(root);
  assert.ok(tasks.find(task => task.taskId === 'dependent').decisionBlockers.length);
  await assert.rejects(claimTask(root, { taskId: 'dependent', agentId: worker.id }), /blocked by unresolved/);
});

test('only dependent tasks block; approval resumes work and decision changes require revalidation', async t => {
  const root = await fixture(t);
  let record = await createDecision(root, proposal(['product']), worker);
  await createTask(root, { taskId: 'dependent', title: 'Use decision', createdBy: coordinator.id, decisionDependencies: [record.id] });
  await createTask(root, { taskId: 'unrelated', title: 'Unrelated', createdBy: coordinator.id });
  await assert.rejects(claimTask(root, { taskId: 'dependent', agentId: worker.id }), /blocked by unresolved/);
  await claimTask(root, { taskId: 'unrelated', agentId: worker.id });
  assert.equal((await completeTask(root, { taskId: 'unrelated', agentId: worker.id, status: 'complete' })).status, 'complete');
  record = await changeDecision(root, record.id, resolution(record), human, 'resolve');
  await claimTask(root, { taskId: 'dependent', agentId: worker.id });
  await completeTask(root, { taskId: 'dependent', agentId: worker.id, status: 'complete' });
  record = await changeDecision(root, record.id, { expected_revision: record.revision, recommendation: 'B', reasoning: 'New evidence.' }, coordinator, 'propose');
  let task = (await listTasks(root)).find(item => item.taskId === 'dependent');
  assert.equal(task.needsRevalidation, true);
  assert.equal(task.decisionBlockers.length, 1);
  assert.deepEqual(task.changedDecisions, [record.id]);
  assert.notEqual(task.observedDecisionRevisions[record.id], task.decisionRevisions[record.id]);
  await assert.rejects(completeTask(root, { taskId: 'dependent', agentId: worker.id }), /revalidation/);
  record = await changeDecision(root, record.id, resolution(record), human, 'resolve');
  await assert.rejects(completeTask(root, { taskId: 'dependent', agentId: worker.id }), /revalidation/);
  await claimTask(root, { taskId: 'dependent', agentId: worker.id });
  await completeTask(root, { taskId: 'dependent', agentId: worker.id, status: 'complete' });
  task = (await listTasks(root)).find(item => item.taskId === 'dependent');
  assert.equal(task.needsRevalidation, false);
  assert.equal(task.decisionBlockers.length, 0);
  const detailed = await runDecisionTool('decision_get', { decision_id: record.id }, opts(root));
  assert.equal(detailed.affectedWork[0].taskId, 'dependent');
  await createTask(root, { taskId: 'advisory', title: 'Potentially affected work', createdBy: coordinator.id });
  const revised = await runDecisionTool('decision_propose', { decision_id: record.id, expected_revision: record.revision, affected_tasks: ['advisory'], reasoning: 'Identify other potentially affected work.' }, opts(root, coordinator));
  assert.equal(revised.affectedWork.find(task => task.taskId === 'advisory').advisoryRevalidation, true);
  // Advisory links identify work to inspect without inventing required dependencies.
  assert.equal((await claimTask(root, { taskId: 'advisory', agentId: worker.id })).agentId, worker.id);
});

test('dependency missing after recovery stays blocked; blocked handoffs remain possible', async t => {
  const root = await fixture(t);
  const record = await createDecision(root, proposal(), worker);
  await assert.rejects(createTask(root, { taskId: 'missing', createdBy: coordinator.id, decisionDependencies: [`decision-${'0'.repeat(32)}`] }), /ENOENT/);
  let approved = await changeDecision(root, record.id, resolution(record), coordinator, 'resolve');
  await createTask(root, { taskId: 'task', title: 'Task', createdBy: coordinator.id, decisionDependencies: [record.id] });
  await claimTask(root, { taskId: 'task', agentId: worker.id });
  await changeDecision(root, approved.id, { expected_revision: approved.revision, reasoning: 'Requires new research.' }, worker, 'propose');
  assert.equal((await completeTask(root, { taskId: 'task', agentId: worker.id, status: 'blocked' })).status, 'blocked');
  await rm(join(root, 'decisions', record.id), { recursive: true });
  const task = (await listTasks(root))[0];
  assert.equal(task.decisionBlockers[0].reason, 'missing');
});

test('all lifecycle states and auditable supersession follow authorization and transitions', async t => {
  const root = await fixture(t);
  let record = await createDecision(root, proposal(), worker);
  record = await changeDecision(root, record.id, { expected_revision: record.revision, status: 'classified', reasoning: 'Technical.' }, worker, 'propose');
  record = await changeDecision(root, record.id, { expected_revision: record.revision, status: 'pending', reasoning: 'Await review.' }, worker, 'propose');
  record = await changeDecision(root, record.id, resolution(record, 'blocked'), coordinator, 'resolve');
  record = await changeDecision(root, record.id, resolution(record), coordinator, 'resolve');
  await assert.rejects(changeDecision(root, record.id, resolution(record, 'verified'), coordinator, 'resolve'), /Invalid decision transition/);
  record = await changeDecision(root, record.id, resolution(record, 'implemented'), coordinator, 'resolve');
  record = await changeDecision(root, record.id, resolution(record, 'verified'), coordinator, 'resolve');
  const successor = await createDecision(root, proposal(['technical'], 'Replacement?'), worker);
  record = await changeDecision(root, record.id, { ...resolution(record, 'superseded'), superseded_by: successor.id }, coordinator, 'resolve');
  assert.equal(record.supersededBy, successor.id);
  assert.deepEqual(record.history.map(item => item.status), ['proposed', 'classified', 'pending', 'blocked', 'approved', 'implemented', 'verified', 'superseded']);
  assert.ok(record.history.every((item, index) => item.actor && item.at && item.revision === index + 1));
  await assert.rejects(changeDecision(root, record.id, { expected_revision: record.revision, reasoning: 'Reopen' }, coordinator, 'propose'), /Terminal/);
  let rejected = await changeDecision(root, successor.id, resolution(successor, 'rejected'), coordinator, 'resolve');
  rejected = await changeDecision(root, rejected.id, resolution(rejected, 'cancelled'), coordinator, 'resolve');
  assert.equal(rejected.status, 'cancelled');
});

test('outbox recovery delivers escalation, approval wake and replacement coordinator notices idempotently', async t => {
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); });
  const root = await fixture(t);
  for (const actor of [worker, coordinator]) runtimes.push(await createAgentRuntime(root, { agentId: actor.id, role: actor.role, coordinatorId: actor.coordinatorId }));
  let record = await createDecision(root, proposal(['routine']), worker);
  record = await changeDecision(root, record.id, { expected_revision: record.revision, reasoning: 'Needs coordinator.' }, worker, 'escalate');
  // Simulates a crash after commit but before sending the corresponding inbox message.
  assert.equal((await readAgentInbox(root, coordinator.id)).length, 0);
  assert.deepEqual(await reconcileDecisionNotifications(root), []);
  let inbox = await readAgentInbox(root, coordinator.id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].body, /authority=coordinator/);
  await acknowledgeAgentMessages(root, coordinator.id, inbox);
  await reconcileDecisionNotifications(root);
  assert.equal((await readAgentInbox(root, coordinator.id)).length, 0);
  runtimes.push(await createAgentRuntime(root, { agentId: 'replacement', role: 'coordinator' }));
  await reconcileDecisionNotifications(root);
  assert.equal((await readAgentInbox(root, 'replacement')).length, 1);
  await acknowledgeAgentMessages(root, worker.id, await readAgentInbox(root, worker.id));
  record = await changeDecision(root, record.id, resolution(record), coordinator, 'resolve');
  const wake = await waitForAgentMessages(root, worker.id, { timeoutMs: 1000, beforePoll: () => reconcileDecisionNotifications(root) });
  assert.equal(wake.timedOut, false);
  assert.match(wake.messages[0].body, /approved/);
});

test('legacy boards, old sessions, and project migration preserve decision records', async t => {
  const root = await fixture(t);
  assert.deepEqual(await listDecisions(root), []);
  await createTask(root, { taskId: 'legacy', title: 'Legacy', createdBy: coordinator.id });
  await claimTask(root, { taskId: 'legacy', agentId: worker.id });
  assert.equal((await completeTask(root, { taskId: 'legacy', agentId: worker.id })).status, 'ready_for_review');
  const watchRoot = join(root, 'old-project', '.deepseek-watch');
  const board = join(watchRoot, 'coordination');
  const record = await createDecision(board, proposal(['product']), worker);
  const approved = await changeDecision(board, record.id, resolution(record), human, 'resolve');
  await mkdir(join(watchRoot, 'sessions'), { recursive: true });
  const session = newSession({ workspace: join(root, 'old-project'), systemPrompt: 'Legacy prompt', config: { coordDir: board } });
  await writeSession(join(watchRoot, 'sessions', 'legacy.json'), session);
  const report = await migrateLegacyData({ watchRoots: [watchRoot], dataRoot: join(root, 'central'), copy: true });
  assert.equal(report.copyErrors.length, 0);
  const destination = report.coordinationRoots.find(item => item.source === board).destination;
  assert.deepEqual(await getDecision(destination, record.id), approved);
  const copyRoot = join(root, 'copied-board');
  await cp(destination, copyRoot, { recursive: true });
  assert.equal((await getDecision(copyRoot, record.id)).approval.role, 'human');
  // A genuinely parked runtime must prevent copying an active coordination board.
  await mkdir(join(board, 'agents'), { recursive: true });
  await writeFile(join(board, 'agents', 'parked.json'), JSON.stringify({ agentId: 'parked', pid: process.pid, state: 'waiting_for_message', heartbeatAt: new Date().toISOString(), session: join(watchRoot, 'sessions', 'legacy.json') }));
  const active = await migrateLegacyData({ watchRoots: [watchRoot], dataRoot: join(root, 'active-destination'), copy: true });
  assert.equal(active.copiedCoordinationFiles, 0);
  assert.equal(active.skippedActiveSessions.length, 1);
});

test('operator CLI resolves human decisions, rejects stale approval and needs no provider', async t => {
  const root = await fixture(t);
  const record = await createDecision(root, proposal(['product']), worker);
  const command = ['resolve', record.id, '--coord-dir', root, '--expected-revision', '1', '--resolution', 'Use A', '--reasoning', 'Founder approved.'];
  const approved = await runDecisionsCli(command);
  assert.equal(approved.approval.role, 'human');
  await assert.rejects(runDecisionsCli(command), /revision conflict/);
  const cli = await child(`import { spawnSync } from 'node:child_process'; const result = spawnSync(process.execPath, ['src/deepseek-watch.js', 'decisions', 'get', process.argv[2], '--coord-dir', process.argv[1]], { encoding: 'utf8', env: { ...process.env, DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' } }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status;`, [root, record.id]);
  assert.equal(cli.code, 0, cli.error);
  assert.equal(JSON.parse(cli.output).status, 'approved');
  assert.equal((await runDecisionsCli(['history', record.id, '--coord-dir', root])).length, 2);
  await assert.rejects(runDecisionsCli(['resolve', record.id, '--coord-dir', root]), /revision conflict/);
});

test('a notification recovery error does not disguise a successful committed decision', async t => {
  const root = await fixture(t);
  const broken = await createDecision(root, proposal(['technical'], 'Broken unrelated record?'), worker);
  await writeFile(join(root, 'decisions', broken.id, '1.json'), '{');
  const output = await runDecisionTool('decision_create', proposal(['product'], 'Valid new question?'), opts(root));
  assert.equal(output.result.status, 'proposed');
  assert.ok(output.notificationErrors.length);
  assert.equal((await getDecision(root, output.result.id)).revision, 1);
});
