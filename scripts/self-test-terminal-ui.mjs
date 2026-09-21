import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalUI, cellWidth, wrapText } from '../src/terminal-ui.js';

function fixture(t) {
  const input = new PassThrough(); input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  const output = new PassThrough(); output.columns = 70; output.rows = 16;
  let bytes = ''; output.on('data', data => { bytes += data; });
  const error = new PassThrough(); const write = output.write;
  const ui = new TerminalUI({ provider: 'test', model: 'mock', session: 'test' }, input, output, error).start();
  t.after(() => ui.close());
  return { ui, input, output, error, write, bytes: () => bytes };
}
test('Unicode wrapping measures graphemes and strips terminal commands', () => {
  assert.equal(cellWidth('e\u0301中👨‍👩‍👧‍👦'), 5);
  assert.deepEqual(wrapText('ab中c', 4), ['ab中', 'c']);
  assert.deepEqual(wrapText('\x1b[2Jhello', 10), ['hello']);
});
test('stream updates one entry, preserves draft and redraws on resize', t => {
  const { ui, input, output } = fixture(t);
  const writer = ui.writer('assistant'); writer.write('Hello'); writer.write(' world');
  input.write('draft'); ui.render();
  assert.equal(ui.entries.length, 1); assert.equal(ui.entries[0].text, 'Hello world');
  assert.equal(ui.draft.join(''), 'draft');
  output.columns = 22; output.emit('resize'); ui.render();
  assert.ok(ui.frames.every(row => cellWidth(row) <= 21));
  assert.equal(ui.frames.length, 16);
});
test('input queues during work and delivers in order', async t => {
  const { ui, input } = fixture(t);
  input.write('one\rtwo\r');
  assert.equal(await ui.nextPrompt(), 'one'); assert.equal(await ui.nextPrompt(), 'two');
  const next = ui.nextPrompt(); input.write('three\r'); assert.equal(await next, 'three');
});
test('bracketed paste never submits embedded newlines', t => {
  const { ui, input } = fixture(t);
  input.write('\x1b[200~first\nsecond\x1b[201~');
  assert.equal(ui.queue.length, 0); assert.equal(ui.draft.join(''), 'first\nsecond');
});
test('confirmation requests serialize and never consume queued prompts', async t => {
  const { ui, input } = fixture(t);
  input.write('unfinished draft');
  ui.submit('follow up'); const first = ui.confirm('Write file?'); const second = ui.confirm('Run command?');
  input.write('y\rn\r');
  assert.equal(await first, true); assert.equal(await second, false);
  assert.equal(ui.draft.join(''), 'unfinished draft');
  assert.equal(await ui.nextPrompt(), 'follow up');
});
test('tool cards update in place and reveal results on demand', t => {
  const { ui, input } = fixture(t);
  ui.addTool({ id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } });
  ui.finishTool('a', 'secret result', 125); ui.render();
  assert.equal(ui.entries.length, 1); assert.ok(!ui.frames.join('\n').includes('secret result'));
  input.write('\x05'); ui.render(); assert.ok(ui.frames.join('\n').includes('secret result'));
});
test('scrolled history remains anchored as output grows', t => {
  const { ui } = fixture(t);
  for (let i = 0; i < 40; i++) ui.add('user', `message ${i}`);
  ui.render(); ui.key('', { name: 'pageup' }); ui.render(); const before = ui.frames.slice(2, -5);
  ui.add('assistant', 'new output'); ui.render(); assert.deepEqual(ui.frames.slice(2, -5), before);
});
test('close restores stream writers, raw mode and alternate screen', t => {
  const { ui, input, output, error, write, bytes } = fixture(t);
  error.write('diagnostic'); assert.equal(ui.entries.at(-1).text, 'diagnostic');
  ui.close(); assert.equal(output.write, write); assert.equal(input.isRaw, false);
  assert.ok(bytes().endsWith('\x1b[?2004l\x1b[?25h\x1b[?1049l'));
  assert.equal(input.listenerCount('keypress'), 0);
});
test('CLI streams, processes a queued follow-up, saves it and restores terminal', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsw-tui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0, child;
  const server = createServer((req, res) => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    req.resume(); req.on('end', () => {
      requests++;
      if (requests === 1) child.stdin.write('queued follow-up\r/exit\r');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `mock answer ${requests}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); child?.kill(); });
  const cli = new URL('../src/deepseek-watch.js', import.meta.url).href;
  const bootstrap = `Object.defineProperty(process.stdin,'isTTY',{value:true}); Object.defineProperty(process.stdout,'isTTY',{value:true}); process.stdin.setRawMode = v => {process.stdin.isRaw=v}; process.argv=['node','watch',...process.argv.slice(1)]; await import(${JSON.stringify(cli)});`;
  child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, '--', '--no-update-check', '--tui', '-p', 'hello', '--provider', 'deepseek', '--base-url', `http://127.0.0.1:${server.address().port}`, '--no-tools', '--session', join(dir, 'session.json'), '--coord-dir', join(dir, 'coord'), '--agent-id', 'tui-test', '--retry-attempts', '1'], { cwd: dir, windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_TUI_QUIET: '0', TERM: 'xterm-256color' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exit = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout: ' + stdout + stderr)); }, 12000); child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve(code); }); });
  assert.equal(exit, 0, stderr); assert.equal(requests, 2, stdout + stderr);
  assert.ok(stdout.includes('\x1b[?1049h')); assert.ok(stdout.includes('\x1b[?1049l'));
  const session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
  assert.ok(session.messages.some(m => m.content === 'queued follow-up'));
  assert.ok(session.messages.some(m => m.content === 'mock answer 2'));
});

test('visual layout keeps diagnostics quiet and fits narrow viewports', t => {
  const { ui, output } = fixture(t);
  ui.opts.color = true;
  ui.add('user', 'Explain this project');
  ui.add('reasoning', 'hidden internal text');
  ui.add('assistant', 'A readable answer with **emphasis** and `inline code`.');
  ui.usage = { prompt: 26810, completion: 153, share: 98 };
  ui.busy = false;
  for (const columns of [100, 40, 20]) {
    output.columns = columns; ui.render();
    assert.equal(ui.frames.length, output.rows);
    assert.ok(ui.frames.every(row => cellWidth(row) < columns));
    assert.ok(!ui.frames.join('\n').includes('hidden internal text'));
  }
  output.columns = 100; ui.render();
  assert.ok(ui.frames.join('\n').includes('98% cached'));
  assert.ok(ui.frames.join('\n').includes('╭'));
  ui.opts.color = false; ui.render();
  assert.ok(!ui.frames.join('\n').includes('\x1b'));
  assert.deepEqual(wrapText('Words stay together here', 15), ['Words stay', 'together here']);
});

test('picker supports filtering, numeric selection, paging and draft restoration', async t => {
  const { ui, input, output } = fixture(t);
  input.write('saved draft');
  const items = Array.from({ length: 35 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}`, description: 'Account model' }));
  let picked = ui.select('Models', 'Choose one', items);
  input.write('Model 24'); ui.render();
  assert.ok(ui.frames.join('\n').includes('Model 24'));
  input.write('\r'); assert.equal(await picked, 'm24'); assert.equal(ui.draft.join(''), 'saved draft');
  picked = ui.select('Models', 'Choose one', items);
  input.write('12\r'); assert.equal(await picked, 'm11');
  picked = ui.select('Models', 'Choose one', items);
  ui.key('', { name: 'pagedown' }); ui.render();
  assert.ok(ui.selection.index > 0);
  output.columns = 30; output.emit('resize'); ui.render();
  assert.ok(ui.frames.every(row => cellWidth(row) < 30));
  ui.key('', { name: 'escape' }); assert.equal(await picked, null);
  assert.equal(ui.queue.length, 0);
});

test('slash command completion does not submit text', t => {
  const { ui, input } = fixture(t);
  input.write('/mo\t'); assert.equal(ui.draft.join(''), '/model ');
  assert.equal(ui.queue.length, 0);
});
