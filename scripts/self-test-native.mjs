import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CodexBackend, ClaudeBackend } from '../src/native-backends.js';
import { subscriptionEnv, resolveNativeCli } from '../src/native-process.js';
import { discoverModels, applyApiModel, parseSlash } from '../src/connection-picker.js';
import { contextLimitFor } from '../src/providers.js';

const mock = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'pro'}));process.exit(0); }
const send=x=>console.log(JSON.stringify(x));
const codex=args[0]==='app-server';
let turn=0;
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(process.env.NATIVE_TEST_LOG) appendFileSync(process.env.NATIVE_TEST_LOG,JSON.stringify(m)+'\\n');
 const reply=result=>send({id:m.id,result});
 if(codex) {
  if(m.method==='initialize') reply({});
  if(m.method==='model/list') reply({data:[{model:'model-a',displayName:'Model A'},{model:'model-b',displayName:'Model B'}],nextCursor:null});
  if(m.method==='account/read') reply({account:{type:process.env.NATIVE_BAD_AUTH?'apiKey':'chatgpt',planType:'plus'}});
  if(m.method==='thread/start'||m.method==='thread/resume') reply({thread:{id:m.params.threadId||'native-123'},model:m.params.model||'mock-gpt'});
  if(m.method==='account/rateLimits/read') reply({rateLimits:{primary:{usedPercent:20,windowDurationMins:300}}});
  if(m.method==='turn/start') {
   turn++; reply({turn:{id:'t'+turn}});
   send({method:'turn/started',params:{threadId:'native-123',turn:{id:'t'+turn}}});
   const text=m.params.input[0].text;
   if(text==='crash') {process.exit(2);}
   if(text==='wait') continue;
   if(text==='approval') send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{command:'write test.txt'}});
   send({method:'item/agentMessage/delta',params:{itemId:'a'+turn,delta:'answer '+turn}});
   send({method:'item/completed',params:{item:{id:'a'+turn,type:'agentMessage',text:'answer '+turn}}});
   send({method:'turn/completed',params:{turn:{status:'completed'}}});
  }
  if(m.method==='turn/interrupt') {reply({});send({method:'turn/completed',params:{turn:{status:'interrupted'}}});}
 } else {
  if(m.type==='control_request') {
   send({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{}}});
   if(m.request.subtype==='interrupt') send({type:'result',session_id:'claude-123',result:'',usage:{}});
  }
  if(m.type==='user') {
   turn++;const text=m.message.content;
   send({type:'system',subtype:'init',session_id:'claude-123',model:'mock-claude'});
   if(text==='crash') process.exit(2);
   if(text==='wait') continue;
   if(text==='approval') send({type:'control_request',request_id:'approval-1',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'test.txt',content:'hello'}}});
   send({type:'stream_event',event:{type:'message_start',message:{id:'a'+turn}}});
   send({type:'stream_event',event:{delta:{type:'text_delta',text:'answer '+turn}}});
   send({type:'assistant',message:{id:'a'+turn,content:[{type:'text',text:'answer '+turn}]}});
   send({type:'result',session_id:'claude-123',result:'answer '+turn,usage:{input_tokens:20,output_tokens:3,cache_read_input_tokens:10}});
  }
 }
}
`;

const resources = new Map();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'switchyard-native-test-'));
  resources.set(dir, []);
  const file = join(dir, 'mock.mjs'); await writeFile(file, mock);
  const old = { ...process.env };
  process.env.SWITCHYARD_CODEX_CLI = file; process.env.SWITCHYARD_CLAUDE_CLI = file;
  process.env.NATIVE_TEST_LOG = join(dir, 'requests.jsonl');
  t.after(async () => { for (const backend of resources.get(dir)) await backend.close(); for (const key of ['SWITCHYARD_CODEX_CLI', 'SWITCHYARD_CLAUDE_CLI', 'NATIVE_TEST_LOG', 'NATIVE_BAD_AUTH']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } await rm(dir, { recursive: true, force: true }); });
  return { dir, file, log: async () => (await readFile(process.env.NATIVE_TEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('subscription environment strips API credentials without mutating parent', () => {
  const source = { OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'proxy', PATH: 'path', CODEX_HOME: 'saved' };
  assert.deepEqual(subscriptionEnv(source), { PATH: 'path', CODEX_HOME: 'saved' });
  assert.equal(source.OPENAI_API_KEY, 'secret');
  assert.throws(() => resolveNativeCli('other'), /Unknown/);
});

for (const [name, Type] of [['codex', CodexBackend], ['claude', ClaudeBackend]]) {
  test(`${name}: stream deduplication, follow-up and saved native resume ID`, async t => {
    const { dir, log } = await fixture(t);
    const state = {}; const backend = new Type({ cwd: dir, permission: 'ask' }, state, {});
    resources.get(dir).push(backend);
    const deltas = []; backend.on('delta', e => deltas.push(e.text));
    await backend.start(); assert.equal((await backend.turn('first')).content, 'answer 1');
    assert.equal((await backend.turn('second')).content, 'answer 2');
    assert.deepEqual(deltas, ['answer 1', 'answer 2']); assert.ok(state.id);
    await backend.close();
    const resumed = new Type({ cwd: dir, permission: 'ask' }, state, {});
    resources.get(dir).push(resumed); await resumed.start(); await resumed.turn('third');
    if (name === 'codex') assert.ok((await log()).some(x => x.method === 'thread/resume' && x.params.threadId === state.id));
  });
  test(`${name}: approval denials are returned to the native engine`, async t => {
    const { dir, log } = await fixture(t); let confirmations = 0;
    const backend = new Type({ cwd: dir, permission: 'ask' }, {}, { confirm: async () => { confirmations++; return false; } });
    resources.get(dir).push(backend); await backend.start(); await backend.turn('approval');
    await new Promise(resolve => setTimeout(resolve, 20));
    const messages = await log(); assert.equal(confirmations, 1);
    assert.ok(messages.some(m => m.id === 'approval-1' && m.result?.decision === 'decline' || m.response?.request_id === 'approval-1' && m.response.response?.behavior === 'deny'));
  });
  test(`${name}: interrupt completes a waiting turn; crashed subprocess rejects`, async t => {
    const { dir } = await fixture(t); const backend = new Type({ cwd: dir, permission: 'review' }, {}, {});
    resources.get(dir).push(backend); await backend.start();
    const turn = backend.turn('wait'); await new Promise(resolve => setTimeout(resolve, 30)); await backend.interrupt(); await turn;
    await assert.rejects(backend.turn('crash'), /exited/);
  });
}

test('Codex API-key authentication is rejected in subscription mode', async t => {
  const { dir } = await fixture(t); process.env.NATIVE_BAD_AUTH = '1';
  const backend = new CodexBackend({ cwd: dir, permission: 'review' }, {}, {});
  resources.get(dir).push(backend); await assert.rejects(backend.start(), /ChatGPT login/);
});

test('CLI saves native session metadata and resumes the backend automatically', async t => {
  const { dir } = await fixture(t);
  const cli = new URL('../src/deepseek-watch.js', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const session = join(dir, 'session.json'), output = join(dir, 'answer.md');
  async function run(args) {
    const child = spawn(process.execPath, [fileURLToPath(cli), ...args, '--session', session, '--no-update-check', '--permission', 'review', '-o', output], { cwd: dir, env: process.env, windowsHide: true });
    let text = ''; child.stdout.on('data', x => { text += x; }); child.stderr.on('data', x => { text += x; });
    const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    assert.equal(code, 0, text);
  }
  await run(['--backend', 'codex', '-p', 'first']);
  let saved = JSON.parse(await readFile(session, 'utf8'));
  assert.equal(saved.config.backend, 'codex'); assert.equal(saved.native.id, 'native-123');
  await run(['--resume', '-p', 'follow-up']); saved = JSON.parse(await readFile(session, 'utf8'));
  assert.equal(saved.messages.filter(x => x.role === 'user').length, 2);
  assert.match(await readFile(output, 'utf8'), /answer/);
});

test('API provider changes retain complete tool pairs and update the context budget', () => {
  const messages = [{ role: 'user', content: 'task' }, { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_text_file', arguments: '{}' } }], providerState: { provider: 'deepseek', model: 'old' } }, { role: 'tool', tool_call_id: 't1', content: 'result' }];
  const session = { provider: 'deepseek', model: 'old', messages, config: {} };
  const opts = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' };
  applyApiModel(opts, session, 'glm', 'glm-4.7', contextLimitFor);
  assert.equal(session.messages, messages); assert.equal(messages[1].tool_calls[0].id, messages[2].tool_call_id);
  assert.equal(messages[1].providerState, undefined); assert.equal(session.provider, 'glm');
  assert.equal(session.config.contextLimit, 204800); assert.equal(opts.model, 'glm-4.7');
  assert.deepEqual(parseSlash('/model glm-4.7'), { name: 'model', argument: 'glm-4.7' });
});

test('model catalog follows native account model-list responses', async t => {
  await fixture(t);
  const models = await discoverModels({ backend: 'codex' });
  assert.deepEqual(models.map(m => m.id), ['model-a', 'model-b']);
});

test('no-argument startup selects connection/model and local commands never reach the model', { timeout: 15000 }, async t => {
  const { dir, log } = await fixture(t);
  const cli = new URL('../src/deepseek-watch.js', import.meta.url).href;
  const bootstrap = `Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});process.stdout.columns=100;process.stdout.rows=36;process.stdin.setRawMode=v=>{process.stdin.isRaw=v};process.argv=['node','watch'];await import(${JSON.stringify(cli)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: dir, windowsHide: true, env: { ...process.env, DSW_NO_UPDATE_CHECK: '1', DEEPSEEK_TUI_QUIET: '0', TERM: 'xterm-256color' } });
  t.after(() => child.kill());
  let output = '', phase = 0, error = '';
  const steps = [
    ['New run', '1\r'], ['Choose a connection', '1\r'], ['Choose a model', '2\r'],
    ['Permission level', '1\r'], ['Ask Switchyard', '/commands\r'],
    ['/commands or /help', 'first\r/exit\r']
  ];
  child.stdout.on('data', data => {
    output += data;
    if (phase < steps.length && output.includes(steps[phase][0])) {
      child.stdin.write(steps[phase][1]); phase++; output = '';
    }
  });
  child.stderr.on('data', data => { error += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup stuck at ${phase}: ${output} ${error}`)); }, 12000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, error); assert.equal(phase, steps.length);
  const requests = await log();
  const turns = requests.filter(m => m.method === 'turn/start');
  assert.equal(turns.length, 1); assert.equal(turns[0].params.input[0].text, 'first');
  assert.equal(turns[0].params.model, 'model-b');
});
