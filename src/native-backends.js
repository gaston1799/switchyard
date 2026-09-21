import { EventEmitter } from 'node:events';
import { JsonProcess, spawnNative } from './native-process.js';

class NativeBackend extends EventEmitter {
  constructor(opts, state = {}, interaction = {}) {
    super(); this.opts = opts; this.state = state; this.interaction = interaction;
    this.messages = new Map(); this.items = new Map(); this.running = null;
  }
  attach(rpc) {
    this.rpc = rpc;
    rpc.on('failure', error => { this.failure = error; this.finish(error); });
    rpc.on('message', message => { Promise.resolve(this.receive(message)).catch(error => this.finish(error)); });
  }
  begin() {
    if (this.failure) throw this.failure;
    if (this.running) throw new Error('A native turn is already running');
    this.messages.clear();
    return new Promise((resolve, reject) => { this.running = { resolve, reject }; });
  }
  finish(error, interrupted = false) {
    if (!this.running) return;
    const pending = this.running; this.running = null;
    if (error) pending.reject(error);
    else pending.resolve({ content: [...this.messages.values()].join('\n\n'), interrupted });
  }
  delta(id, text, reasoning = false) {
    if (!reasoning) this.messages.set(id, (this.messages.get(id) || '') + text);
    this.emit('delta', { id, text, reasoning });
  }
  async confirm(question) { return this.opts.permission !== 'review' && Boolean(await this.interaction.confirm?.(question)); }
  async close() { await this.rpc?.close(); }
}

export class CodexBackend extends NativeBackend {
  async start() {
    this.attach(new JsonProcess('codex', ['app-server', '--stdio'], { cwd: this.opts.cwd }));
    await this.rpc.request('initialize', { clientInfo: { name: 'switchyard', title: 'Switchyard', version: '0.3.0' } });
    this.rpc.send({ method: 'initialized', params: {} });
    const { account } = await this.rpc.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Codex subscription mode requires ChatGPT login. Run: switchyard login codex. For an API key use --backend api --provider openai.');
    this.emit('account', { label: `ChatGPT ${account.planType || ''}`.trim() });
    const config = {
      cwd: this.opts.cwd, modelProvider: 'openai',
      approvalPolicy: this.opts.permission === 'full' ? 'never' : this.opts.permission === 'review' ? 'never' : 'untrusted',
      sandbox: this.opts.permission === 'full' ? 'danger-full-access' : 'read-only',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.system ? { developerInstructions: this.opts.system } : {})
    };
    const result = await this.rpc.request(this.state.id ? 'thread/resume' : 'thread/start', { ...config, ...(this.state.id ? { threadId: this.state.id } : {}) });
    this.state.id = result.thread.id;
    this.emit('session', { id: this.state.id, model: result.model });
    await this.refreshLimits();
  }
  async refreshLimits() {
    try { const data = await this.rpc.request('account/rateLimits/read'); this.emit('limits', data); }
    catch (error) { this.emit('notice', `Codex usage limits unavailable: ${error.message}`); }
  }
  async turn(text) {
    const done = this.begin();
    this.rpc.request('turn/start', { threadId: this.state.id, input: [{ type: 'text', text, text_elements: [] }], ...(this.opts.model ? { model: this.opts.model } : {}) })
      .then(result => { this.turnId = result.turn.id; }).catch(error => this.finish(error));
    return done;
  }
  async interrupt() {
    if (this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.state.id, turnId: this.turnId });
  }
  async receive(message) {
    const p = message.params || {}, method = message.method;
    if (message.id != null && method) {
      let result;
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        const item = this.items.get(p.itemId) || {};
        const approved = await this.confirm(`${p.reason || 'Codex requests permission'}\n${p.command || item.command || JSON.stringify(p.changes || item.changes || { itemId: p.itemId, grantRoot: p.grantRoot })}`);
        result = { decision: approved ? 'accept' : 'decline' };
      } else if (method === 'item/tool/requestUserInput') {
        const answers = {};
        for (const q of p.questions || []) answers[q.id] = { answers: [await this.interaction.prompt?.(`${q.question}\n${(q.options || []).map(o => o.label).join(' / ')}`) || 'Cancelled'] };
        result = { answers };
      } else if (method === 'item/permissions/requestApproval') {
        // Never silently broaden permissions beyond the selected mode.
        result = { permissions: {}, scope: 'turn' };
      } else {
        this.rpc.send({ id: message.id, error: { code: -32601, message: `Switchyard does not support ${method}; request denied` } }); return;
      }
      this.rpc.send({ id: message.id, result }); return;
    }
    if (p.threadId && p.threadId !== this.state.id) return;
    if (method === 'turn/started') this.turnId = p.turn.id;
    if (method === 'item/agentMessage/delta') this.delta(p.itemId, p.delta || '');
    if (method === 'item/reasoning/summaryTextDelta') this.delta(p.itemId, p.delta || '', true);
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item || {};
      if (item.id) this.items.set(item.id, item);
      if (item.type === 'agentMessage' && method === 'item/completed') {
        if (!this.messages.has(item.id)) this.delta(item.id, item.text || '');
        else this.messages.set(item.id, item.text || this.messages.get(item.id));
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall'].includes(item.type)) {
        this.emit('tool', { id: item.id, name: item.type, args: item.command || item.tool || JSON.stringify(item.changes || item.arguments || {}), done: method === 'item/completed', result: item.aggregatedOutput || JSON.stringify(item.result || item.changes || item.status || ''), error: ['failed', 'declined'].includes(item.status), durationMs: item.durationMs || 0 });
      }
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage?.last || p.tokenUsage?.total;
      if (usage) this.emit('usage', { prompt: usage.inputTokens || 0, completion: usage.outputTokens || 0, cached: usage.cachedInputTokens || 0 });
    }
    if (method === 'account/rateLimits/updated') this.emit('limits', p);
    if (method === 'warning' || method === 'configWarning') this.emit('notice', p.message || p.summary || 'Codex configuration warning');
    if (method === 'turn/completed') {
      this.turnId = null;
      this.finish(p.turn.status === 'failed' ? new Error(p.turn.error?.message || 'Codex turn failed') : null, p.turn.status === 'interrupted');
    }
  }
}

export async function claudeAuthStatus() {
  const child = spawnNative('claude', ['auth', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude authentication check timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); try { const result = JSON.parse(text); if (code) throw new Error('Claude login required. Run: switchyard login claude'); resolve(result); } catch (error) { reject(error); } });
  });
}

export class ClaudeBackend extends NativeBackend {
  async start() {
    const account = await claudeAuthStatus();
    if (!account.loggedIn || account.authMethod !== 'claude.ai') throw new Error('Claude subscription mode requires Claude account login. Run: switchyard login claude. For API billing use --backend api --provider anthropic.');
    this.emit('account', { label: `Claude ${account.subscriptionType || ''}`.trim() });
    const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    if (this.state.id) args.push('--resume', this.state.id);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.system) args.push('--append-system-prompt', this.opts.system);
    if (this.opts.permission === 'full') args.push('--permission-mode', 'bypassPermissions');
    else if (this.opts.permission === 'review') args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--strict-mcp-config');
    else args.push('--permission-mode', 'manual');
    this.attach(new JsonProcess('claude', args, { cwd: this.opts.cwd }));
    await this.rpc.request('initialize', {}, true);
  }
  async turn(text) {
    const done = this.begin(); this.interrupted = false; this.streamMessageId = null;
    this.rpc.send({ type: 'user', session_id: this.state.id || '', message: { role: 'user', content: text }, parent_tool_use_id: null });
    return done;
  }
  async interrupt() { this.interrupted = true; await this.rpc.request('interrupt', {}, true); }
  async receive(message) {
    if (message.type === 'control_request') {
      const request = message.request || {}; let response;
      if (request.subtype === 'can_use_tool') {
        if (request.tool_name === 'AskUserQuestion') {
          const answers = {};
          for (const q of request.input?.questions || []) answers[q.question] = await this.interaction.prompt?.(`${q.question}\n${(q.options || []).map(o => o.label).join(' / ')}`) || 'Cancelled';
          response = { behavior: 'allow', updatedInput: { ...request.input, answers } };
        } else {
          const allowed = await this.confirm(`Claude requests ${request.tool_name}\n${JSON.stringify(request.input, null, 2)}`);
          response = allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Declined by Switchyard user or permission mode' };
        }
      } else {
        this.rpc.send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: `Unsupported control request: ${request.subtype}` } }); return;
      }
      this.rpc.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }); return;
    }
    if (message.parent_tool_use_id) return; // Subagent events must not duplicate the main answer.
    if (message.session_id && message.session_id !== this.state.id) { this.state.id = message.session_id; this.emit('session', { id: this.state.id, model: message.model }); }
    if (message.type === 'system' && message.subtype === 'init') this.emit('session', { id: this.state.id, model: message.model });
    if (message.type === 'stream_event') {
      const event = message.event || {};
      if (event.type === 'message_start') this.streamMessageId = event.message?.id;
      if (event.delta?.type === 'text_delta') this.delta(this.streamMessageId || 'answer', event.delta.text || '');
      if (event.delta?.type === 'thinking_delta') this.delta(this.streamMessageId || 'thinking', event.delta.thinking || '', true);
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const block = event.content_block; this.emit('tool', { id: block.id, name: block.name, args: JSON.stringify(block.input || {}), done: false });
      }
    }
    if (message.type === 'assistant') {
      const body = message.message || {};
      for (const block of body.content || []) {
        if (block.type === 'text' && !this.messages.has(body.id)) this.delta(body.id, block.text || '');
        if (block.type === 'tool_use') this.emit('tool', { id: block.id, name: block.name, args: JSON.stringify(block.input || {}), done: false });
      }
    }
    if (message.type === 'user') for (const block of message.message?.content || []) {
      if (block.type === 'tool_result') this.emit('tool', { id: block.tool_use_id, done: true, result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), error: block.is_error });
    }
    if (message.type === 'result') {
      if (!this.messages.size && message.result) this.delta('answer', message.result);
      const usage = message.usage || {};
      this.emit('usage', { prompt: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), completion: usage.output_tokens || 0, cached: usage.cache_read_input_tokens || 0 });
      this.finish(message.is_error && !this.interrupted ? new Error((message.errors || []).join('\n') || message.result || `Claude: ${message.subtype}`) : null, this.interrupted);
    }
    if (message.type === 'rate_limit_event' && message.rate_limit_info?.status !== 'allowed') this.emit('notice', `Claude rate limit: ${message.rate_limit_info?.status || 'updated'}`);
  }
}
