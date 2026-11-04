import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import Module, { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { listAgents, listAgentMessages, createAgentRuntime } from '../src/agent-coordination.js';
import { getProviderApiKey } from '../src/config.js';
import { getProviderBalance, selectCurrencyBalance } from '../src/provider-balance.js';
import { modelPrice } from '../src/model-pricing.js';

const live = process.argv.includes('--live');
const liveKey = live ? await getProviderApiKey('deepseek') : '';
const initialBalance = live ? selectCurrencyBalance(await getProviderBalance('deepseek', { apiKey: liveKey }))?.total : 0;
const livePrice = live ? modelPrice('deepseek', 'deepseek-flash') : null;
if (live && (!Number.isFinite(initialBalance) || initialBalance < 3.5 || !livePrice || livePrice.input > 2 || livePrice.output > 10)) throw new Error('Live test stopped: balance/cost cannot safely preserve $3.');
let reservedCost = 0;
let liveRequests = 0;
const model = live ? 'deepseek-flash' : 'deepseek-chat';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'switchyard-project-test-'));
const children = [];
const calls = new Map();
const handlers = new Map();
const requestId = () => `${Date.now()}-${randomUUID()}`;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, label) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
const server = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] })); return; }
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  const input = JSON.parse(text);
  if (live) {
    try {
      // Count every input byte as a token and use rates above the checked model
      // price. Reservations are never refunded, including failed requests.
      input.max_tokens = Math.min(input.max_tokens || 2048, 2048);
      const bound = Buffer.byteLength(JSON.stringify(input)) * 2 / 1e6 + input.max_tokens * 10 / 1e6;
      const currentBalance = selectCurrencyBalance(await getProviderBalance('deepseek', { apiKey: liveKey }))?.total;
      if (++liveRequests > 24 || !Number.isFinite(currentBalance) || currentBalance - bound < 3 || initialBalance - reservedCost - bound < 3) throw new Error('Live test budget guard stopped the request.');
      reservedCost += bound;
      const upstream = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${liveKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(60000) });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream' });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (error) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
    return;
  }
  const sse = delta => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`); };
  const tool = (name, args) => ({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  if (input.tools?.length === 1 && input.tools[0].function.name === 'name_chat') { sse(tool('name_chat', { title: 'Project routing test' })); return; }
  const system = input.messages.find(message => message.role === 'system')?.content || '';
  const worker = system.includes('agent_id: routing-worker');
  const coordinator = system.includes('agent_role: coordinator');
  const key = worker ? 'worker' : coordinator ? 'coordinator' : 'other';
  const count = (calls.get(key) || 0) + 1; calls.set(key, count);
  if (coordinator && count === 1) { sse(tool('spawn_agent', { agent_id: 'routing-worker', display_name: 'Routing worker', prompt: 'Park, acknowledge operator messages, then park again.', provider: 'deepseek', model: 'deepseek-chat' })); return; }
  if (worker && count <= 2) { sse({ content: count === 2 ? 'Acknowledged direct user instruction.' : '', ...tool('agent_wait', { reason: 'Waiting for user', timeout_seconds: 120 }) }); return; }
  sse({ content: 'Routing test complete.' });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
process.env.SWITCHYARD_DATA_DIR = root;
process.env.DEEPSEEK_UI_WORKSPACE = root;
process.env.DEEPSEEK_UI_CLI_EXE = process.argv.includes('--packaged') ? join(repo, 'dist/exe/d.exe') : process.execPath;
process.env.DEEPSEEK_UI_CLI_SCRIPT = process.argv.includes('--packaged') ? '' : join(repo, 'src/deepseek-watch.js');
process.env.DSW_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DEEPSEEK_API_KEY = liveKey || 'mock-only';
process.env.APPDATA = join(root, 'config');
const mainFile = join(repo, 'src/ui/main.cjs');
const realRequire = createRequire(mainFile);
const module = new Module(mainFile);
module.filename = mainFile; module.paths = Module._nodeModulePaths(dirname(mainFile));
module.require = name => {
  if (name === 'electron') return { app: { requestSingleInstanceLock: () => false, quit() {}, on() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, Menu: {}, BrowserWindow: {}, shell: {} };
  if (name === 'node:child_process') return { spawn(exe, args, options) { const child = realRequire(name).spawn(exe, [...args, '--max-tokens', live ? '2048' : '256', '--max-tool-turns', '4'], options); children.push(child); return child; } };
  return realRequire(name);
};
module._compile((await readFile(mainFile, 'utf8')) + '\nmodule.exports = { projectStore, dispatchChat, safeSession, listSessionSummaries, runs };', mainFile);
const ui = module.exports;
try {
  const aDir = join(root, 'project-a'), bDir = join(root, 'project-b');
  await mkdir(aDir); await mkdir(bDir);
  const a = await ui.projectStore.add(aDir), b = await ui.projectStore.add(bDir);
  assert.equal((await ui.projectStore.add(aDir)).id, a.id);
  assert.notEqual(a.coordDir, b.coordDir);
  assert.equal((await realRequire('./projects.cjs').createProjectStore(root).list()).length, 2);
  const workerPrompt = 'This is a bounded messaging test. Name the chat and announce to the coordinator if required, then call agent_wait with reason Waiting for user and timeout_seconds 120. Do no file or shell work. When a direct user message asks for acknowledgement, say exactly Acknowledged direct user instruction. and call agent_wait again. When the user says Finish now or Resume once after stopping, just say Routing test complete. and finish without parking.';
  const start = { requestId: requestId(), projectId: a.id, prompt: live ? `This is a bounded test. Name your chat if required, then spawn exactly one worker using spawn_agent: agent_id routing-worker, display_name Routing worker, provider deepseek, model ${model}, prompt: ${workerPrompt} . After spawn returns, finish your response without parking or other tools. Do not inspect files or run commands.` : 'Launch test worker.', permission: 'full', agentRole: 'coordinator', provider: 'deepseek', backend: 'api', model };
  const [first, duplicate] = await Promise.all([ui.dispatchChat(start), ui.dispatchChat(start)]);
  assert.equal(first.id, duplicate.id);
  assert.equal(children.length, 1, 'Duplicate IPC submissions must launch only once');
  const parked = await until(async () => (await listAgents(a.coordDir, { includeStopped: true })).find(agent => agent.agentId === 'routing-worker' && agent.state === 'waiting_for_message'), 'spawned worker parks');
  assert.equal(resolve(parked.workspace), resolve(aDir));
  assert.equal(resolve(parked.coordinationRoot), resolve(a.coordDir));
  await until(() => [...ui.runs.values()].every(run => run.status !== 'running'), 'coordinator finishes');
  const before = live ? liveRequests : calls.get('worker'); await pause(800); assert.equal(live ? liveRequests : calls.get('worker'), before, 'Parking must make no requests');
  const send = { ...start, requestId: requestId(), sessionPath: parked.session, agentRole: 'worker', prompt: 'Please say exactly Acknowledged direct user instruction. then call agent_wait again.' };
  const [queued, retry] = await Promise.all([ui.dispatchChat(send), ui.dispatchChat(send)]);
  assert.equal(queued.delivery.id, retry.delivery.id);
  assert.equal(children.length, 1, 'A live worker must receive an inbox message, not a new process');
  await until(async () => (await ui.safeSession(parked.session)).messages.some(message => message.content.includes('Acknowledged direct')), 'reply persists');
  const woke = await until(async () => (await listAgents(a.coordDir, { includeStopped: true })).find(agent => agent.agentId === parked.agentId && agent.state === 'waiting_for_message'), 'worker re-parks');
  assert.equal(woke.pid, parked.pid);
  assert.equal(woke.state, 'waiting_for_message');
  assert.equal((await listAgentMessages(a.coordDir, parked.agentId)).filter(message => message.id === send.requestId).length, 1);
  assert.equal((await listAgentMessages(a.coordDir, parked.coordinatorId)).filter(message => message.id === `${send.requestId}-notice`).length, 1);
  const summary = (await ui.listSessionSummaries()).find(session => session.path === parked.session);
  assert.equal(summary.active, true); assert.equal(summary.agentState, 'waiting_for_message');
  await ui.dispatchChat({ ...send, requestId: requestId(), prompt: 'Finish now.' });
  await until(async () => !(await listAgents(a.coordDir, { includeStopped: true })).find(agent => agent.agentId === parked.agentId)?.live, 'worker stops');
  const resumed = await ui.dispatchChat({ ...send, requestId: requestId(), prompt: 'Resume once after stopping.' });
  await until(() => ui.runs.get(resumed.id)?.status !== 'running', 'stopped worker resumes');
  assert.equal(children.length, 2);
  const second = await ui.dispatchChat({ ...start, requestId: requestId(), projectId: b.id, agentRole: 'worker', prompt: 'Finish standalone.' });
  await until(() => ui.runs.get(second.id)?.status !== 'running', 'second project completes');
  const bSession = await ui.safeSession(second.sessionPath);
  assert.equal(resolve(bSession.workspace), resolve(bDir)); assert.equal(resolve(bSession.coordDir), resolve(b.coordDir));
  assert.equal((await listAgents(b.coordDir, { includeStopped: true })).some(agent => agent.agentId === parked.agentId), false);
  const ownerSession = join(root, 'owner.json');
  const owner = await createAgentRuntime(a.coordDir, { agentId: 'owner-one', session: ownerSession, heartbeatMs: 60000 });
  await assert.rejects(createAgentRuntime(b.coordDir, { agentId: 'owner-two', session: ownerSession }), /already active/);
  const ownerFile = join(a.coordDir, 'agents', 'owner-one.json');
  await writeFile(ownerFile, JSON.stringify({ ...owner.record, heartbeatAt: '2000-01-01T00:00:00Z' }));
  assert.equal((await listAgents(a.coordDir, { includeStopped: true })).find(agent => agent.agentId === 'owner-one').live, false);
  await owner.stop();
  console.log('Project routing integration passed: persistence, isolation, spawn inheritance, park/wake, re-park, receipt deduplication, coordinator notice, stopped resume, ownership, stale heartbeat.');
  if (live) {
    const finalBalance = selectCurrencyBalance(await getProviderBalance('deepseek', { apiKey: liveKey }))?.total;
    console.log(JSON.stringify({ initialBalance, finalBalance, requests: liveRequests, conservativeReservedUSD: reservedCost }));
  }
} finally {
  for (const child of children) if (child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
  for (const project of await ui.projectStore.list()) {
    for (const agent of await listAgents(project.coordDir, { includeStopped: true })) {
      if (agent.live && agent.pid !== process.pid && agent.workspace.startsWith(root)) { try { process.kill(agent.pid); } catch {} }
    }
  }
  await new Promise(done => server.close(done));
  assert.ok(basename(root).startsWith('switchyard-project-test-') && dirname(root) === resolve(tmpdir()));
  await pause(500);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
