import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { runEventsCli } from '../src/event-cli.js';
import { collectBoardEvents, pollEvents, acknowledgeEvents, watchEvents } from '../src/event-watcher.js';
import { claudeMonitorCall, runCallbackAdapter } from '../src/harness-adapters.js';
import { initializeCoordination, sendAgentMessage, acknowledgeAgentMessages, readAgentInbox, createTask, claimTask } from '../src/agent-coordination.js';
import { createDecision, changeDecision } from '../src/decisions.js';
import { reconcileDecisionNotifications } from '../src/decision-tools.js';

const CLI = resolve('src/deepseek-watch.js');
const PLUGIN = resolve('integrations/claude-code');
const pause = ms => new Promise(done => setTimeout(done, ms));
const options = (root, consumer = 'session-one', agentId = 'worker') => ({ root, agentId, consumer });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'switchyard-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeCoordination(root);
  await writeFile(join(root, 'agents', 'worker.json'), JSON.stringify({ agentId: 'worker', role: 'worker', coordinatorId: 'coord', heartbeatAt: '2026-01-01T00:00:00Z', state: 'working' }));
  await writeFile(join(root, 'agents', 'coord.json'), JSON.stringify({ agentId: 'coord', role: 'coordinator' }));
  return root;
}
const message = (root, body = 'New work', to = 'worker') => sendAgentMessage(root, { from: 'coord', to, body });
const cli = (root, command, consumer = 'session-one') => spawnSync(process.execPath, [CLI, 'events', ...command, '--coord-dir', root, '--agent-id', 'worker', '--consumer', consumer], { encoding: 'utf8', timeout: 5000 });
async function until(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
function pluginProcess(root, overrides = {}) {
  const child = spawn(process.execPath, [join(PLUGIN, 'scripts', 'watch.mjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SWITCHYARD_CLI_JS: CLI, SWITCHYARD_COORD_DIR: root, SWITCHYARD_AGENT_ID: 'worker', SWITCHYARD_EVENT_CONSUMER: 'session-one', ...overrides } });
  const state = { child, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => state.stdout += chunk);
  child.stderr.on('data', chunk => state.stderr += chunk);
  state.done = new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => done(code)); });
  state.stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await state.done; };
  return state;
}

test('NDJSON watcher emits structured relevant messages and explicit receipt survives process restart', async t => {
  const root = await fixture(t);
  const sent = await message(root, 'Line one\nLine two — Unicode');
  await message(root, 'Unrelated coordinator message', 'coord');
  const first = cli(root, ['poll']);
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.type, 'message.received');
  assert.equal(event.source.id, sent.id);
  assert.match(event.data.summary, /Line two/);
  assert.equal(JSON.parse(cli(root, ['poll']).stdout).eventId, event.eventId, 'Stdout delivery is not acknowledgement.');
  const ack = cli(root, ['ack', event.eventId]);
  assert.equal(ack.status, 0, ack.stderr);
  assert.equal(cli(root, ['poll']).stdout, '');
  assert.equal((await readAgentInbox(root, 'worker')).length, 1, 'Watcher receipts must not consume inbox.');
  assert.equal(JSON.parse(cli(root, ['poll'], 'other-session').stdout).eventId, event.eventId);
});

test('inbox to processed moves keep a single event ID without consuming or duplicating delivery', async t => {
  const root = await fixture(t);
  await message(root);
  const [before] = await pollEvents(options(root));
  await acknowledgeAgentMessages(root, 'worker', await readAgentInbox(root, 'worker'));
  const after = await pollEvents(options(root));
  assert.equal(after.length, 1);
  assert.equal(after[0].eventId, before.eventId);
  await acknowledgeEvents({ ...options(root), eventIds: [before.eventId] });
  assert.deepEqual(await pollEvents(options(root)), []);
});

test('bounded watcher expiration followed by renewal replays unacknowledged events with the same IDs', async t => {
  const root = await fixture(t);
  await message(root);
  const first = cli(root, ['watch', '--timeout-ms', '120', '--poll-ms', '50']);
  assert.equal(first.status, 0, first.stderr);
  const event = JSON.parse(first.stdout.trim());
  const renewed = cli(root, ['watch', '--timeout-ms', '120', '--poll-ms', '50']);
  assert.equal(renewed.status, 0, renewed.stderr);
  assert.equal(JSON.parse(renewed.stdout.trim()).eventId, event.eventId);
  assert.equal(cli(root, ['ack', event.eventId]).status, 0);
  assert.equal(cli(root, ['watch', '--timeout-ms', '120', '--poll-ms', '50']).stdout, '');
});

test('a disconnected stdout consumer stops cleanly without acknowledging a lost event', async t => {
  const root = await fixture(t);
  await message(root);
  const output = new Writable({ write(_chunk, _encoding, done) { const error = new Error('Monitor disconnected'); error.code = 'EPIPE'; done(error); } });
  await runEventsCli(['watch', '--coord-dir', root, '--agent-id', 'worker', '--consumer', 'session-one'], { output });
  assert.equal((await pollEvents(options(root))).length, 1);
});

test('late older journal files are replayed after newer events have been acknowledged', async t => {
  const root = await fixture(t);
  await message(root, 'Newer event');
  const events = await pollEvents(options(root));
  await acknowledgeEvents({ ...options(root), eventIds: events.map(event => event.eventId) });
  await writeFile(join(root, 'events', 'old-late.json'), JSON.stringify({ id: 'late-old-id', type: 'task_handoff', agentId: 'worker', taskId: 'late', createdAt: '2000-01-01T00:00:00Z', status: 'complete' }));
  const [late] = await pollEvents(options(root));
  assert.equal(late.source.id, 'late-old-id');
  assert.equal(late.type, 'task.changed');
});

test('heartbeats, runtime rewrites and unrelated tasks never produce wake events', async t => {
  const root = await fixture(t);
  await createTask(root, { taskId: 'other', title: 'Other work', createdBy: 'coord' });
  const emitted = [];
  const watching = watchEvents({ ...options(root), pollMs: 50, timeoutMs: 220, onEvent: async event => emitted.push(event) });
  for (let count = 0; count < 3; count++) {
    await writeFile(join(root, 'agents', 'worker.json'), JSON.stringify({ agentId: 'worker', role: 'worker', heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'working' }));
    await writeFile(join(root, 'events', `heartbeat-${count}.json`), JSON.stringify({ id: `heartbeat-${count}`, type: 'agent_heartbeat', agentId: 'worker', createdAt: new Date().toISOString() }));
    await pause(25);
  }
  await watching;
  assert.deepEqual(emitted, []);
});

test('one process emits each unacknowledged event once and does not starve later pages', async t => {
  const root = await fixture(t);
  for (let index = 0; index < 5; index++) await message(root, `Message ${index}`);
  const emitted = [];
  await watchEvents({ ...options(root), pollMs: 50, timeoutMs: 220, limit: 2, onEvent: async event => emitted.push(event) });
  assert.equal(emitted.length, 5);
  assert.equal(new Set(emitted.map(event => event.eventId)).size, 5);
  assert.equal((await pollEvents({ ...options(root), limit: 10 })).length, 5, 'An unacknowledged restart replays all outstanding events.');
});

test('decision revision replay recovers commits without notifications and collapses matching mailbox duplicates', async t => {
  const root = await fixture(t);
  let decision = await createDecision(root, { project: 'Switchyard', question: 'Choose product behavior?', category: ['product'] }, { id: 'worker', role: 'worker', coordinatorId: 'coord' });
  decision = await changeDecision(root, decision.id, { expected_revision: 1, reasoning: 'Actual founder approval.', resolution: 'A' }, { id: 'operator', role: 'human' }, 'resolve');
  let events = await pollEvents(options(root));
  assert.deepEqual(events.map(event => event.source.revision), [1, 2]);
  assert.equal(events[1].data.status, 'approved');
  assert.equal((await readAgentInbox(root, 'worker')).length, 0, 'Watcher does not synthesize decision notifications.');
  await reconcileDecisionNotifications(root);
  events = await pollEvents(options(root));
  assert.equal(events.length, 2, 'Decision + its mailbox notification must not wake the same consumer twice.');
  const before = await readFile(join(root, 'decisions', decision.id, '2.json'), 'utf8');
  await acknowledgeEvents({ ...options(root), eventIds: events.map(event => event.eventId) });
  assert.deepEqual(await pollEvents(options(root)), []);
  assert.equal(await readFile(join(root, 'decisions', decision.id, '2.json'), 'utf8'), before, 'Receipt must never change decision authorization/history.');
});

test('decision changes are routed to affected task claimants and replacement coordinators', async t => {
  const root = await fixture(t);
  let decision = await createDecision(root, { project: 'Switchyard', question: 'Parser?', category: ['technical'] }, { id: 'other-worker', role: 'worker' });
  decision = await changeDecision(root, decision.id, { expected_revision: 1, resolution: 'A', reasoning: 'Technical review.' }, { id: 'coord', role: 'coordinator' }, 'resolve');
  await createTask(root, { taskId: 'work', title: 'Dependent', createdBy: 'coord', decisionDependencies: [decision.id] });
  assert.equal((await collectBoardEvents(root, { agentId: 'worker' })).length, 0);
  await claimTask(root, { taskId: 'work', agentId: 'worker' });
  assert.ok((await collectBoardEvents(root, { agentId: 'worker' })).some(event => event.source.kind === 'decision'));
  const replacement = await pollEvents(options(root, 'replacement-session', 'coord'));
  assert.ok(replacement.some(event => event.source.kind === 'decision'));
});

test('partial source files are retried, while other messages still arrive', async t => {
  const root = await fixture(t);
  const path = join(root, 'events', 'partial.json');
  await writeFile(path, '{');
  await message(root);
  const diagnostics = [];
  assert.equal((await pollEvents({ ...options(root), onDiagnostic: entry => diagnostics.push(entry) })).length, 1);
  assert.equal(diagnostics.length, 1);
  await writeFile(path, JSON.stringify({ id: 'recovered', type: 'agent_stopped', agentId: 'worker', createdAt: '2026-01-01T00:00:00Z' }));
  assert.ok((await pollEvents(options(root))).some(event => event.source.id === 'recovered'));
});

test('unreadable decision state does not suppress its addressed mailbox notification', async t => {
  const root = await fixture(t);
  const decision = await createDecision(root, { project: 'Switchyard', question: 'Recover this decision?', category: ['product'] }, { id: 'worker', role: 'worker', coordinatorId: 'coord' });
  await reconcileDecisionNotifications(root);
  await writeFile(join(root, 'decisions', decision.id, '1.json'), '{');
  const events = await pollEvents(options(root));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message.received');
  assert.match(events[0].data.summary, /Recover this decision/);
});

test('receipts are idempotent across writers, scoped to consumer/agent and survive board migration', async t => {
  const root = await fixture(t);
  await message(root);
  const [event] = await pollEvents(options(root));
  await Promise.all(Array.from({ length: 6 }, () => acknowledgeEvents({ ...options(root), eventIds: [event.eventId] })));
  assert.deepEqual(await pollEvents(options(root)), []);
  await assert.rejects(pollEvents(options(root, 'session-one', 'coord')), /different agent/);
  await assert.rejects(acknowledgeEvents({ ...options(root), eventIds: [`sy-${'0'.repeat(64)}`] }), /Unknown event/);
  await assert.rejects(pollEvents(options(root, '../escape')), /agent id/);
  const destination = join(root, 'migrated');
  await mkdir(destination);
  for (const name of ['agents', 'inbox', 'processed', 'events', 'tasks', 'claims', 'subscriptions']) await cp(join(root, name), join(destination, name), { recursive: true });
  assert.deepEqual(await pollEvents(options(destination)), []);
  assert.equal((await pollEvents(options(destination, 'new-session')))[0].eventId, event.eventId);
});

test('truncated acknowledgement files fail open to replay, never to event loss', async t => {
  const root = await fixture(t);
  await message(root);
  const [event] = await pollEvents(options(root));
  const receipt = join(root, 'subscriptions', 'session-one', 'acks', `${event.eventId}.json`);
  await writeFile(receipt, '{');
  assert.equal((await pollEvents(options(root)))[0].eventId, event.eventId);
  await assert.rejects(acknowledgeEvents({ ...options(root), eventIds: [event.eventId] }), /Invalid acknowledgement/);
});

test('bounded wait discovers a new event, and an unavailable board expires without stdout', async t => {
  const root = await fixture(t);
  const emitted = [];
  const waiting = watchEvents({ ...options(root), once: true, timeoutMs: 1000, pollMs: 50, onEvent: async event => emitted.push(event) });
  await pause(80); await message(root);
  await waiting;
  assert.equal(emitted.length, 1);
  const started = Date.now();
  const errors = [];
  await watchEvents({ ...options(join(root, 'missing')), once: true, timeoutMs: 150, pollMs: 50, onEvent: () => assert.fail('No source exists'), onDiagnostic: error => errors.push(error) });
  assert.ok(Date.now() - started < 1500);
  assert.equal(errors.length, 1, 'Repeated identical diagnostics are suppressed.');
});

test('callback adapter retries rejected delivery and acknowledges only durable acceptance', async t => {
  const root = await fixture(t);
  await message(root);
  const calls = [];
  await runCallbackAdapter({ ...options(root), pollMs: 50, timeoutMs: 180 }, async event => { calls.push(event.eventId); return { accepted: calls.length > 1 }; });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(await pollEvents(options(root)), []);
});

test('Claude adapter matches required Monitor input, shell-quotes paths, and enforces mode deadlines', async t => {
  const root = await fixture(t);
  const specialDir = join(root, "path with spaces ' quote");
  await mkdir(specialDir);
  const script = join(specialDir, 'fake-cli.mjs');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const call = claudeMonitorCall({ ...options(root), cliPath: script, mode: 'print', timeoutMs: 600000 });
  assert.equal(call.tool, 'Monitor');
  assert.equal(call.input.description, 'Switchyard events for worker');
  assert.equal(call.input.timeout_ms, 600000);
  assert.equal(call.input.ws, undefined);
  const result = spawnSync('bash', ['-c', call.input.command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['events', 'watch', '--coord-dir', root, '--agent-id', 'worker', '--consumer', 'session-one']);
  assert.throws(() => claudeMonitorCall({ ...options(root), cliPath: CLI, mode: 'print', timeoutMs: 600001 }), /600000/);
  assert.throws(() => claudeMonitorCall({ ...options(root), cliPath: CLI, timeoutMs: 1800001 }), /1800000/);
  assert.throws(() => claudeMonitorCall({ ...options(root), cliPath: CLI, mode: 'unknown' }), /mode/);
  const standalone = claudeMonitorCall({ ...options(root), cliPath: '/opt/switchyard.exe', standalone: true });
  assert.ok(standalone.input.command.startsWith("'/opt/switchyard.exe' 'events' 'watch'"));
});

test('opt-in plugin wrapper carries real NDJSON, leaves heartbeat intact and replays only unacknowledged events', async t => {
  const root = await fixture(t);
  const heartbeat = await readFile(join(root, 'agents', 'worker.json'));
  await message(root);
  const first = pluginProcess(root);
  try {
    await until(() => first.stdout.includes('\n'), 'plugin initial event');
    const event = JSON.parse(first.stdout.trim());
    assert.equal(event.type, 'message.received');
    const ack = cli(root, ['ack', event.eventId]);
    assert.equal(ack.status, 0, ack.stderr);
    await message(root, 'Second, still unacknowledged');
    await until(() => first.stdout.trim().split('\n').length === 2, 'second plugin event');
  } finally { await first.stop(); }
  const second = pluginProcess(root);
  try {
    await until(() => second.stdout.includes('\n'), 'plugin reconnect replay');
    assert.match(JSON.parse(second.stdout.trim()).data.summary, /Second/);
    await pause(100);
    assert.equal(second.stdout.trim().split('\n').length, 1);
  } finally { await second.stop(); }
  assert.equal(createHash('sha256').update(await readFile(join(root, 'agents', 'worker.json'))).digest('hex'), createHash('sha256').update(heartbeat).digest('hex'));
});

test('plugin wrapper reconnects failed watcher with backoff and a stable consumer', async t => {
  const root = await fixture(t);
  const script = join(root, 'fail-once.mjs'), counter = join(root, 'attempts');
  await writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs'; const file=process.env.SWITCHYARD_TEST_COUNTER; let n=0;try{n=Number(readFileSync(file,'utf8'));}catch{} writeFileSync(file,String(++n)); if(n===1)process.exit(9); console.log(JSON.stringify({consumer:process.argv.at(-1)}));setInterval(()=>{},1000);`);
  const running = pluginProcess(root, { SWITCHYARD_CLI_JS: script, SWITCHYARD_TEST_COUNTER: counter });
  try {
    await until(() => running.stdout.includes('\n'), 'plugin reconnect');
    assert.equal(await readFile(counter, 'utf8'), '2');
    assert.equal(JSON.parse(running.stdout).consumer, 'session-one');
    assert.match(running.stderr, /reconnecting with the same consumer/);
  } finally { await running.stop(); }
});

test('plugin format is strict and an unconfigured monitor is quiet on stdout', async t => {
  const root = await fixture(t);
  const manifest = JSON.parse(await readFile(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const monitors = JSON.parse(await readFile(join(PLUGIN, 'monitors', 'monitors.json'), 'utf8'));
  assert.equal(manifest.experimental.monitors, './monitors/monitors.json');
  assert.deepEqual(Object.keys(monitors[0]).sort(), ['command', 'description', 'name', 'when']);
  assert.equal(monitors[0].when, 'always');
  assert.ok(!monitors[0].command.includes('user_config'));
  const result = pluginProcess(root, { SWITCHYARD_AGENT_ID: '' });
  assert.equal(await result.done, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /SWITCHYARD_AGENT_ID/);
});
