import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDecision, getDecision } from '../src/decisions.js';
import { createAgentRuntime, createTask, listAgents, listTasks } from '../src/agent-coordination.js';

const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
function cli(args, cwd) {
  const process = spawn(globalThis.process.execPath, [resolve('src/deepseek-watch.js'), ...args], {
    cwd, env: { ...globalThis.process.env, DEEPSEEK_API_KEY: 'mock-test-key', SWITCHYARD_NO_SUPPORT_PROMPT: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  process.stdout.on('data', chunk => stdout += chunk);
  process.stderr.on('data', chunk => stderr += chunk);
  const done = new Promise((complete, reject) => {
    process.once('error', reject);
    process.once('exit', code => complete({ code, stdout, stderr }));
  });
  return { process, done };
}

test('model tool loop blocks founder impersonation, parks, then wakes after operator approval and hands off', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'switchyard-decision-e2e-'));
  const board = join(root, 'board');
  const session = join(root, 'worker.json');
  let coordinator, worker;
  let requestCount = 0, failure;
  const seenTools = new Set();
  const decision = await createDecision(board, { project: 'Switchyard', question: 'Founder behavior?', category: ['product'], options: ['A', 'B'] }, { id: 'worker-e2e', role: 'worker', coordinatorId: 'coordinator-e2e' });
  await createTask(board, { taskId: 'dependent', title: 'Approved work', createdBy: 'coordinator-e2e', decisionDependencies: [decision.id] });
  const steps = [
    ['decision_list', {}],
    ['decision_get', { decision_id: decision.id }],
    ['decision_resolve', { decision_id: decision.id, expected_revision: 1, resolution: 'Pretend founder approved', reasoning: 'Model assertion is not authority.' }],
    ['agent_claim', { task_id: 'dependent' }],
    ['agent_wait', { reason: 'Await actual founder approval.', timeout_seconds: 15 }],
    ['agent_claim', { task_id: 'dependent' }],
    ['agent_handoff', { task_id: 'dependent', summary: 'Work revalidated after real approval.', status: 'complete', to: 'coordinator-e2e' }],
    ['decision_history', { decision_id: decision.id }]
  ];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (request.method !== 'POST' || request.url.endsWith('/user/balance')) { response.writeHead(404).end(); return; }
      for (const tool of body.tools || []) seenTools.add(tool.function?.name);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = delta => response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      if (body.tools?.length === 1 && body.tools[0].function?.name === 'name_chat') {
        send({ tool_calls: [{ index: 0, id: 'name-e2e', type: 'function', function: { name: 'name_chat', arguments: '{"title":"Decision integration test"}' } }] }); return;
      }
      const step = steps[requestCount++];
      if (requestCount === 6) {
        assert.equal((await getDecision(board, decision.id)).approval.role, 'human');
        assert.ok(body.messages.some(message => String(message.content).includes(`Decision ${decision.id} revision 2: approved`)), 'Approval must arrive through durable inbox delivery.');
      }
      if (!step) { send({ content: 'Decision workflow verified.' }); return; }
      send({ tool_calls: [{ index: 0, id: `decision-e2e-${requestCount}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] });
    } catch (error) { failure = error; response.end(); }
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    coordinator = await createAgentRuntime(board, { agentId: 'coordinator-e2e', role: 'coordinator' });
    worker = cli(['--agent-id', 'worker-e2e', '--agent-role', 'worker', '--coordinator-id', 'coordinator-e2e', '--coord-dir', board, '--session', session, '--base-url', `http://127.0.0.1:${server.address().port}`, '--permission', 'full', '--no-output', '--outfile', join(root, 'result.md'), '--max-tool-turns', '15', '-p', 'Exercise decision tools, then await founder approval.'], root);
    await Promise.race([
      until(async () => (await listAgents(board, { includeStopped: true })).some(agent => agent.agentId === 'worker-e2e' && agent.state === 'waiting_for_message'), 'worker parked on decision'),
      worker.done.then(result => { throw new Error(`Worker exited before parking (${result.code}, requests=${requestCount}): ${result.stderr}\n${result.stdout}\n${failure || ''}`); })
    ]);
    assert.equal(requestCount, 5);
    assert.equal((await getDecision(board, decision.id)).status, 'proposed');
    const approval = await cli(['decisions', 'resolve', decision.id, '--coord-dir', board, '--expected-revision', '1', '--resolution', 'Use A', '--reasoning', 'Founder reviewed this question.'], root).done;
    assert.equal(approval.code, 0, approval.stderr);
    const result = await worker.done;
    assert.equal(result.code, 0, result.stderr);
    if (failure) throw failure;
    for (const name of ['create', 'list', 'get', 'propose', 'resolve', 'escalate', 'history']) assert.ok(seenTools.has(`decision_${name}`), `${name} schema must reach the model`);
    const saved = JSON.parse(await readFile(session, 'utf8'));
    const replies = saved.messages.filter(message => message.role === 'tool');
    assert.ok(replies.some(message => /human authority/.test(message.content)));
    assert.ok(replies.some(message => /blocked by unresolved decisions/.test(message.content)));
    assert.equal((await listTasks(board))[0].status, 'complete');
    assert.equal((await getDecision(board, decision.id)).history.length, 2);
    assert.equal(saved.config.coordDir, board);
  } finally {
    if (worker?.process.exitCode === null) { worker.process.kill(); await worker.done; }
    await coordinator?.stop();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
