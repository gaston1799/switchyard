import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// Resolve executables without passing prompts or credentials through a shell.
export function resolveNativeCli(name, env = process.env) {
  if (!['codex', 'claude'].includes(name)) throw new Error(`Unknown native backend: ${name}`);
  const override = env[`SWITCHYARD_${name.toUpperCase()}_CLI`];
  if (override) {
    const file = resolve(override);
    if (!existsSync(file) || /\.(cmd|bat|ps1)$/i.test(file)) throw new Error(`${name} override must point to an executable or JavaScript entrypoint.`);
    return /\.[cm]?js$/i.test(file) ? [process.execPath, file] : [file];
  }
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    const exe = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(exe)) return [exe];
    if (process.platform === 'win32') {
      const packageRoot = name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
      const native = join(dir, 'node_modules', packageRoot, 'bin', `${name}.exe`);
      const script = join(dir, 'node_modules', packageRoot, name === 'codex' ? 'bin/codex.js' : 'cli.js');
      if (existsSync(native)) return [native];
      if (existsSync(script)) return [process.execPath, script];
    }
  }
  throw new Error(`${name} CLI not found. Install it and run switchyard login ${name}.`);
}

export function subscriptionEnv(env = process.env) {
  const result = { ...env };
  // Subscription backends must not silently use an inherited API key or proxy.
  for (const key of Object.keys(result)) if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i.test(key)) delete result[key];
  return result;
}

export function spawnNative(name, args, options = {}) {
  const [file, ...prefix] = resolveNativeCli(name, options.env || process.env);
  return spawn(file, [...prefix, ...args], { windowsHide: true, shell: false, env: subscriptionEnv(), ...options });
}

export class JsonProcess extends EventEmitter {
  constructor(name, args, options = {}) {
    super(); this.pending = new Map(); this.sequence = 0; this.stderr = ''; this.closed = false;
    this.child = spawnNative(name, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(new Error(`Invalid ${name} protocol message: ${error.message}`)); }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-8000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => { this.closed = true; this.fail(new Error(`${name} exited (${code}). ${this.stderr.trim()}`)); });
  }
  receive(message) {
    const response = message.type === 'control_response' ? message.response : message;
    const id = response.request_id ?? response.id;
    if (id != null && !message.method && message.type !== 'control_request' && this.pending.has(id)) {
      const pending = this.pending.get(id); this.pending.delete(id); clearTimeout(pending.timer);
      if (response.error || response.subtype === 'error') pending.reject(new Error(typeof response.error === 'string' ? response.error : response.error?.message || 'Native request failed'));
      else pending.resolve(message.type === 'control_response' ? response.response : response.result);
    } else this.emit('message', message);
  }
  send(message) { if (this.closed) throw new Error('Native backend is closed'); this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params = {}, claude = false) {
    const id = `switchyard-${++this.sequence}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.send(claude ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('failure', error);
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && this.child.pid) {
          const killer = spawn('taskkill.exe', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => this.child.kill());
        } else this.child.kill('SIGTERM');
        resolvePromise();
      }, 1500);
      this.child.once('close', () => { clearTimeout(timer); resolvePromise(); });
    });
    this.closed = true; this.lines.close(); this.fail(new Error('Native backend closed'));
  }
}

export async function nativeAuth(name, action = 'status') {
  if (!['login', 'status'].includes(action)) throw new Error('Use login or status.');
  const args = name === 'codex' ? (action === 'login' ? ['login'] : ['login', 'status']) : ['auth', action];
  const child = spawnNative(name, args, { stdio: 'inherit' });
  return new Promise((resolvePromise, reject) => { child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(`${name} authentication exited ${code}`)); else resolvePromise(); }); });
}
