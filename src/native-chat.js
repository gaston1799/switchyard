import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CodexBackend, ClaudeBackend } from './native-backends.js';
import { newSessionPath, readSession, writeSession, touchSession } from './session-memory.js';
import { TerminalUI, cleanText } from './terminal-ui.js';
import { chooseModel, SLASH_HELP, parseSlash } from './connection-picker.js';

export async function runNativeChat(opts, helpers) {
  if (opts.providerExplicit || opts.baseUrlExplicit || opts.balanceFallbackProvider) throw new Error('--backend codex/claude uses native account login. Use --backend api for --provider, --base-url, or balance fallback.');
  if (opts.agentId || opts.coordinatorId || opts.scopeFile || opts.allowedTargets?.length || opts.skills?.length || !opts.tools) throw new Error('Native backends use their own tools, skills and permissions. Switchyard agent coordination, scope flags, --skill and --no-tools require --backend api.');
  const prior = opts.resume ? await readSession(opts.session) : null;
  if (prior && prior.config?.backend !== opts.backend) throw new Error(`This session belongs to ${prior.config?.backend || 'api'}. Resume it with that backend or start a new ${opts.backend} session.`);
  opts.permission ||= prior?.config?.permission || 'ask';
  opts.model = opts.modelExplicit ? opts.model : prior?.model || null;
  opts.cwd = resolve(process.cwd());
  if (prior?.workspace && resolve(prior.workspace).toLowerCase() !== opts.cwd.toLowerCase()) throw new Error(`Resume this native session from its workspace: ${prior.workspace}`);
  opts.session ||= newSessionPath();
  opts.provider = opts.backend === 'codex' ? 'ChatGPT / Codex' : 'Claude account';
  if (opts.systemFile) opts.system = await readFile(resolve(opts.systemFile), 'utf8');
  const session = prior || { version: 1, createdAt: new Date().toISOString(), workspace: opts.cwd, messages: [], config: { backend: opts.backend, permission: opts.permission }, native: {} };
  session.native ||= {};
  session.config.permission = opts.permission;
  let saves = Promise.resolve(), backend, ui, lastAnswer = '', failed = false;
  const save = () => {
    if (!opts.saveSession) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(touchSession(session)));
    saves = saves.then(() => writeSession(opts.session, snapshot));
    return saves;
  };
  const notice = text => { if (ui) ui.add('notice', text); else if (!opts.noOutput) process.stderr.write(`${cleanText(text)}\n`); };
  const writeOutput = async () => {
    if (!opts.output) return;
    const file = resolve(opts.output); await mkdir(dirname(file), { recursive: true });
    const text = opts.fullChat ? session.messages.map(m => `## ${m.role}\n\n${m.content || ''}`).join('\n\n') : lastAnswer;
    await writeFile(file, text + '\n', 'utf8');
  };
  try {
    if (opts.interactiveChat && !opts.noOutput && !opts.tuiQuiet && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb') {
      ui = new TerminalUI({ ...opts, model: opts.model || `${opts.backend} default` }).start(session.messages);
      ui.add('notice', `${opts.backend === 'codex' ? 'Codex' : 'Claude Code'} manages tools and context · permissions: ${opts.permission}`);
    }
    const interaction = {
      confirm: question => ui ? ui.confirm(question) : !opts.noOutput && process.stdin.isTTY ? helpers.confirm(question) : Promise.resolve(false),
      prompt: question => ui ? ui.ask(question) : !opts.noOutput && process.stdin.isTTY ? helpers.prompt(`${question}\n> `) : Promise.resolve('Cancelled')
    };
    backend = opts.backend === 'codex' ? new CodexBackend(opts, session.native, interaction) : new ClaudeBackend(opts, session.native, interaction);
    let writers = new Map(), toolCalls = new Map();
    backend.on('delta', ({ id, text, reasoning }) => {
      if (opts.noOutput) return;
      if (ui) {
        const key = `${reasoning ? 'r' : 'a'}:${id}`;
        if (!writers.has(key)) writers.set(key, ui.writer(reasoning ? 'reasoning' : 'assistant'));
        writers.get(key).write(text);
      } else if (!reasoning) process.stdout.write(cleanText(text));
    });
    backend.on('tool', event => {
      if (!toolCalls.has(event.id) && event.name) {
        const call = { id: event.id, function: { name: event.name, arguments: event.args || '{}' } };
        toolCalls.set(event.id, call);
        if (ui) ui.addTool(call);
        else if (!opts.noOutput) process.stdout.write(`\n› ${event.name}\n`);
      }
      if (ui?.tools.has(event.id) && event.args) { const card = ui.tools.get(event.id); card.args = event.args; card.cache = null; }
      if (event.done) {
        ui?.finishTool(event.id, event.result, event.durationMs, event.error);
        const call = toolCalls.get(event.id);
        if (call) {
          session.messages.push({ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: event.id, content: String(event.result || '') });
          toolCalls.delete(event.id);
        }
      }
    });
    backend.on('notice', notice);
    backend.on('account', ({ label }) => { if (ui) { ui.opts.provider = label; ui.schedule(); } else notice(`Connected: ${label}`); });
    backend.on('session', ({ id, model }) => {
      session.native.id = id;
      if (model) { session.model = model; if (ui) ui.opts.model = model; }
      // Persist the native ID before the first answer so interrupted runs can resume.
      void save().catch(error => { failed = true; notice(`Session save failed: ${error.message}`); });
    });
    backend.on('usage', usage => { if (ui) { ui.usage = { ...usage, share: usage.prompt ? Math.round(usage.cached / usage.prompt * 100) : 0 }; ui.schedule(); } });
    backend.on('limits', data => {
      const buckets = Object.values(data.rateLimitsByLimitId || { codex: data.rateLimits });
      const bucket = buckets.find(x => x?.limitId === 'codex') || buckets.find(Boolean);
      const limits = [bucket?.primary, bucket?.secondary].filter(Boolean).map(x => `${Math.max(0, 100 - x.usedPercent)}% left (${Math.round(x.windowDurationMins / 60 * 10) / 10}h window${x.resetsAt ? `; resets ${new Date(x.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''})`).join(' · ');
      if (ui) { ui.accountLimits = limits; ui.schedule(); } else if (limits) notice(`Codex allowance: ${limits}`);
    });
    await backend.start();
    await save();
    let prompt = opts.promptFile ? await readFile(resolve(opts.promptFile), 'utf8') : opts.stdin ? await helpers.stdin() : opts.prompt;
    while (true) {
      if (!prompt) {
        if (!opts.interactiveChat) break;
        prompt = ui ? await ui.nextPrompt() : await helpers.prompt('> ');
      }
      const command = String(prompt).trim();
      if (['/exit', '/quit', 'exit', 'quit'].includes(command.toLowerCase())) break;
      if (!command) { prompt = null; continue; }
      const slash = parseSlash(command);
      if (slash) {
        try {
          if (['commands', 'help'].includes(slash.name)) notice(SLASH_HELP);
          else if (slash.name === 'session') notice(`${opts.backend} · ${session.model || 'CLI default'}\n${resolve(opts.session)}`);
          else if (slash.name === 'provider') notice('This native history belongs to ' + opts.backend + '. Use /model to change models here. A different engine needs a new session with a context handoff.');
          else if (slash.name === 'usage') { if (opts.backend === 'codex') await backend.refreshLimits(); else notice('Claude reports rate-limit events; remaining quota is not exposed by this CLI.'); }
          else if (slash.name === 'model') {
            const choose = async (title, hint, items) => {
              if (ui) return ui.select(title, hint, items);
              notice(title + '\n' + items.map((item, i) => `${i + 1}. ${item.label} — ${item.description || ''}`).join('\n'));
              const answer = await helpers.prompt('Number (Enter to cancel)> ');
              return items[Number(answer) - 1]?.id || null;
            };
            const model = slash.argument || await chooseModel(opts, choose, interaction.prompt, notice, backend.rpc);
            if (model) {
              if (opts.backend === 'claude') await backend.rpc.request('set_model', { model }, true);
              opts.model = model; session.model = model;
              if (ui) { ui.opts.model = model; ui.schedule(); }
              notice(`Model selected: ${model}. Conversation kept.`); await save();
            }
          } else notice(`Unknown command /${slash.name}.\n${SLASH_HELP}`);
        } catch (error) { notice(error.message); }
        prompt = null; continue;
      }
      writers = new Map(); toolCalls = new Map();
      session.messages.push({ role: 'user', content: prompt }); await save();
      if (ui) { ui.busy = true; ui.add('user', prompt); ui.interrupt = () => { void backend.interrupt().catch(error => notice(error.message)); }; }
      const onInterrupt = () => { void backend.interrupt().catch(error => notice(error.message)); };
      process.on('SIGINT', onInterrupt);
      const status = ui?.status(`Working · ${opts.backend}`);
      const timeout = setTimeout(() => { notice('Native turn timed out'); void backend.close(); }, opts.timeout);
      try {
        const result = await backend.turn(prompt);
        lastAnswer = result.content + (result.interrupted ? '\n\n[interrupted]' : '');
        session.messages.push({ role: 'assistant', content: lastAnswer });
        await save(); await writeOutput();
        if (result.interrupted) notice('Interrupted');
      } catch (error) {
        const partial = [...backend.messages.values()].join('\n\n');
        session.messages.push({ role: 'assistant', content: partial + `\n\n[run stopped: ${error.message}]` });
        await save(); throw error;
      } finally {
        clearTimeout(timeout); process.off('SIGINT', onInterrupt); status?.stop();
        for (const id of toolCalls.keys()) ui?.finishTool(id, 'Turn ended before this tool completed', 0, true);
        if (ui) { ui.interrupt = null; ui.busy = false; }
        else if (!opts.noOutput) process.stdout.write('\n');
      }
      if (!opts.interactiveChat) break;
      prompt = null;
    }
    if (failed) throw new Error('A native session could not be saved');
  } finally {
    await backend?.close();
    ui?.close(); if (ui) process.stdin.pause();
    await saves;
  }
}
