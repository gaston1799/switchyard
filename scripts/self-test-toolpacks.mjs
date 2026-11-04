import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLPACKS, toolpackSchemas, slackRequest } from '../src/toolpacks.js';

test('optional tools are absent until loaded and pack names are deduplicated', () => {
  assert.deepEqual(toolpackSchemas(), []);
  assert.equal(toolpackSchemas(['development', 'development']).length, TOOLPACKS.development.schemas.length);
});

test('Slack is bounded, reports pagination, and does not expose tokens', async () => {
  const env = { SWITCHYARD_SLACK_BOT_TOKEN: 'fixture-secret' };
  assert.equal((await slackRequest({ action: 'status' }, { env: {} })).configured, false);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    assert.equal(init.headers.authorization, 'Bearer fixture-secret');
    if (url.endsWith('auth.test')) return Response.json({ ok: true, team: 'Test', token: 'must-not-leak', user_id: 'U123456' });
    if (url.endsWith('conversations.history')) return Response.json({ ok: true, messages: [{ text: 'untrusted message', ts: '1.0', secret: 'omit' }], has_more: true, response_metadata: { next_cursor: 'next' } });
    return Response.json({ ok: true, channel: 'D123456', ts: '2.0' });
  };
  assert.doesNotMatch(JSON.stringify(await slackRequest({ action: 'status' }, { env, fetchImpl })), /must-not-leak|fixture-secret/);
  const history = await slackRequest({ action: 'read', channel: 'D123456', limit: 1000 }, { env, fetchImpl });
  assert.equal(requests.at(-1).body.limit, 15);
  assert.equal(history.next_cursor, 'next');
  assert.match(history.content_trust, /untrusted/);
  assert.equal(history.messages[0].secret, undefined);
  assert.equal((await slackRequest({ action: 'send', channel: 'D123456', text: 'fixture', thread_ts: '1.0' }, { env, fetchImpl })).sent, true);
  assert.equal(requests.at(-1).body.unfurl_links, false);
  await assert.rejects(slackRequest({ action: 'send', channel: 'bad', text: 'x' }, { env, fetchImpl }), /conversation ID/);
  let calls = 0;
  await assert.rejects(slackRequest({ action: 'send', channel: 'D123456', text: 'x' }, { env, fetchImpl: async () => { calls++; throw Error('fixture-secret'); } }), /delivery is unconfirmed/);
  assert.equal(calls, 1);
  await assert.rejects(slackRequest({ action: 'read', channel: 'D123456' }, { env, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }) }), /retry_after=60/);
});

test('real CLI loads/persists packs and executes checks, Git, service and diagnostics without paid calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'switchyard-toolpacks-'));
  const session = join(dir, 'session.json');
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"', build: 'node -e "process.exit(1)"' } }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  await mkdir(join(dir, '.deepseek-watch'));
  await writeFile(join(dir, 'stdout.log'), 'x'.repeat(500) + 'last service output');
  await writeFile(join(dir, 'stderr.log'), 'fixture error log');
  await writeFile(join(dir, '.deepseek-watch', 'processes.json'), JSON.stringify({ processes: [{ name: 'fixture', pid: victim.pid, creation_id: 'wrong-creation-id', shell: 'cmd', command: 'fixture', workdir: '.', stdout_log: 'stdout.log', stderr_log: 'stderr.log', started_at: new Date().toISOString() }] }));
  const steps = [
    ['name_chat', { title: 'Toolpack checks' }], ['list_toolpacks', {}], ['load_toolpack', { name: 'development' }],
    ['project_checks', { action: 'discover' }], ['project_checks', { action: 'run', scripts: ['check', 'build'] }],
    ['git_review', {}], ['service_inspect', { name: 'fixture', max_bytes: 40 }], ['session_diagnostics', {}],
    ['load_toolpack', { name: 'slack' }], ['slack', { action: 'status' }], ['slack', { action: 'send', channel: 'D123456', text: 'must not send' }],
    ['process_manage', { action: 'stop', name: 'fixture' }]
  ];
  if (process.platform === 'win32') steps.push(
    ['process_manage', { action: 'start', name: 'owned-fixture', shell: 'cmd', command: 'node -e "setInterval(()=>{},1000)"' }],
    ['process_manage', { action: 'stop', name: 'owned-fixture' }]
  );
  let turn = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"deepseek-flash"}]}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const step = steps[turn++];
    const delta = step ? { reasoning_content: 'fixture', tool_calls: [{ index: 0, id: `step_${turn - 1}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { content: 'fixture complete' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  steps[6][1].ready_url = `http://127.0.0.1:${server.address().port}/health`;
  steps[6][1].timeout_ms = 1000;
  async function run(extra = []) {
    return new Promise((resolve, reject) => {
      const cliExe = process.env.SWITCHYARD_TEST_CLI_EXE;
      const child = spawn(cliExe || process.execPath, [...(cliExe ? [] : [fileURLToPath(new URL('../src/deepseek-watch.js', import.meta.url))]), '--provider', 'deepseek', '--model', 'deepseek-flash', '--base-url', `http://127.0.0.1:${server.address().port}`, '--session', session, '--permission', 'full', '--no-output', '--outfile', join(dir, 'result.md'), '--no-update-check', '--retry-attempts', '1', '--max-tool-turns', '20', ...extra, '-p', 'fixture only'], { cwd: dir, env: { ...process.env, DEEPSEEK_API_KEY: 'fixture', SWITCHYARD_SLACK_BOT_TOKEN: '', SLACK_BOT_TOKEN: '' }, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', data => stderr += data);
      const timer = setTimeout(() => { child.kill(); reject(Error(`timeout: ${stderr}`)); }, 30000);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); resolve({ code, stderr }); });
    });
  }
  try {
    const result = await run();
    assert.equal(result.code, 0, result.stderr);
    const names = index => requests[index].tools.map(tool => tool.function.name);
    assert(!names(1).includes('project_checks'));
    assert(names(3).includes('project_checks'));
    assert(!names(3).includes('slack'));
    assert(names(9).includes('slack'));
    const saved = JSON.parse(await readFile(session, 'utf8'));
    assert.deepEqual(saved.config.toolpacks, ['development', 'slack']);
    const output = step => saved.messages.find(message => message.role === 'tool' && message.tool_call_id === `step_${step}`).content;
    assert.equal(JSON.parse(output(3)).executed, false);
    assert.equal(JSON.parse(output(4)).passed, false);
    assert.equal(JSON.parse(output(5)).status.ok, true);
    assert.equal(JSON.parse(output(6)).logs.stdout.truncated, true);
    assert.match(JSON.parse(output(6)).logs.stdout.text, /last service output$/);
    assert.equal(JSON.parse(output(6)).readiness.ready, true);
    assert.equal(JSON.parse(output(7)).model, 'deepseek-flash');
    assert.equal(JSON.parse(output(9)).configured, false);
    assert.match(output(10), /interactive user confirmation/);
    assert.match(output(11), /ownership cannot be verified/);
    assert.doesNotThrow(() => process.kill(victim.pid, 0), 'PID mismatch must leave the process alive');
    if (process.platform === 'win32') {
      assert.ok(output(12).startsWith('{'), output(12));
      assert.equal(JSON.parse(output(12)).started, true);
      assert.equal(JSON.parse(output(12)).running, true);
      assert.ok(JSON.parse(output(12)).creation_id);
      assert.ok(output(13).startsWith('{'), output(13));
      assert.equal(JSON.parse(output(13)).stopped, true);
    }
    const beforeResume = requests.length;
    const resumed = await run(['--resume']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert(requests[beforeResume].tools.some(tool => tool.function.name === 'project_checks'));
    const reviewStart = turn;
    while (steps.length < turn) steps.push(null);
    steps.push(['project_checks', { action: 'run', scripts: ['check'] }], ['slack', { action: 'send', channel: 'D123456', text: 'must not send' }]);
    const review = await run(['--resume', '--permission', 'review']);
    assert.equal(review.code, 0, review.stderr);
    const reviewSession = JSON.parse(await readFile(session, 'utf8'));
    for (const index of [reviewStart, reviewStart + 1]) assert.match(reviewSession.messages.find(message => message.role === 'tool' && message.tool_call_id === `step_${index}`).content, /review only/);
  } finally {
    victim.kill();
    const registry = JSON.parse(await readFile(join(dir, '.deepseek-watch', 'processes.json'), 'utf8'));
    for (const record of registry.processes.filter(record => record.name === 'owned-fixture')) {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(record.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
