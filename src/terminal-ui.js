import { emitKeypressEvents } from 'node:readline';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const chars = (s) => [...segmenter.segment(String(s))].map(x => x.segment);
export const cleanText = (s) => String(s ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export function cellWidth(s) {
  return chars(cleanText(s)).reduce((n, c) => {
    const p = c.codePointAt(0);
    return n + (/^[\p{Mark}\u200d\ufe0f]+$/u.test(c) ? 0 : /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c) || p >= 0x1100 && (p <= 0x115f || p >= 0x2e80 && p <= 0xa4cf || p >= 0xac00 && p <= 0xd7af || p >= 0xf900 && p <= 0xfaff || p >= 0xfe10 && p <= 0xfe6f || p >= 0xff01 && p <= 0xff60 || p >= 0x20000) ? 2 : 1);
  }, 0);
}
export function wrapText(text, width) {
  width = Math.max(1, width);
  const rows = [];
  for (const line of cleanText(text).replace(/\t/g, '    ').split('\n')) {
    let row = '', size = 0;
    for (const c of chars(line)) {
      const w = cellWidth(c);
      if (size + w > width && row) {
        const space = row.lastIndexOf(' ');
        if (space > 0 && c !== ' ') { rows.push(row.slice(0, space)); row = row.slice(space + 1); size = cellWidth(row); }
        else { rows.push(row); row = ''; size = 0; if (c === ' ') continue; }
      }
      if (w <= width) { row += c; size += w; }
    }
    rows.push(row);
  }
  return rows;
}
const clip = (s, w) => wrapText(s, w)[0] || '';

// All terminal writes pass through this owner while the interactive view is open.
export class TerminalUI {
  constructor(opts, input = process.stdin, output = process.stdout, error = process.stderr) {
    this.opts = opts; this.input = input; this.output = output; this.error = error;
    this.entries = []; this.tools = new Map(); this.queue = []; this.confirmations = [];
    this.draft = []; this.cursor = 0; this.offset = 0; this.phase = 'Ready';
    this.results = false; this.reasoning = false; this.busy = true;
    this.rawWrite = output.write.bind(output); this.frames = []; this.closed = false;
  }
  start(messages = []) {
    this.oldRaw = this.input.isRaw; this.oldPaused = this.input.isPaused();
    this.oldOut = this.output.write; this.oldErr = this.error.write;
    const capture = (chunk, encoding, cb) => {
      const text = cleanText(Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : chunk).trim();
      if (text) this.add('notice', text);
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (callback) queueMicrotask(callback);
      return true;
    };
    this.output.write = capture; this.error.write = capture;
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        if (m.content) this.add(m.role, m.content);
        if (m.reasoning_content) this.add('reasoning', m.reasoning_content);
        for (const call of m.tool_calls || []) this.addTool(call);
      } else if (m.role === 'tool') this.finishTool(m.tool_call_id, m.content);
    }
    emitKeypressEvents(this.input);
    this.onKey = (str, key) => this.key(str, key || {});
    this.onResize = () => { this.frames = []; this.schedule(); };
    this.onExit = () => this.close();
    this.onEnd = () => {
      for (const pending of this.confirmations.splice(0)) pending.resolve(false);
      this.interrupt?.(); this.stopRequested = true; this.submit('/exit');
    };
    this.input.on('keypress', this.onKey); this.output.on('resize', this.onResize);
    this.input.once('end', this.onEnd);
    process.once('exit', this.onExit);
    this.input.setRawMode(true); this.input.resume();
    this.rawWrite('\x1b[?1049h\x1b[?2004h\x1b[2J');
    this.tick = setInterval(() => this.schedule(), 1000); this.tick.unref();
    this.render(); return this;
  }
  add(kind, text) {
    const entry = { kind, text: String(text ?? '') }; this.entries.push(entry); this.schedule(); return entry;
  }
  writer(kind) {
    let entry;
    return { write: text => { entry ||= this.add(kind, ''); entry.text += text; entry.cache = null; this.schedule(); }, flush() {} };
  }
  status(phrase, initial = 0) {
    const owner = {}; this.statusOwner = owner; this.phase = phrase; this.tokens = initial; this.started = Date.now(); this.schedule();
    let active = true;
    return { isActive: () => active, addTokens: value => { this.tokens += typeof value === 'number' ? value : Math.ceil(String(value).length / 4); this.schedule(); }, setTokens: n => { this.tokens = n; }, setPhrase: s => { this.phase = s; this.schedule(); }, setBlocked() {}, refresh() {}, clear() {}, stop: () => { active = false; if (this.statusOwner === owner) { this.phase = this.busy ? 'Working' : 'Ready'; this.schedule(); } } };
  }
  addTool(call) {
    const entry = this.add('tool', call.function?.name || 'tool');
    Object.assign(entry, { id: call.id, args: call.function?.arguments || '', state: 'running' });
    this.tools.set(call.id, entry); return call.id;
  }
  finishTool(id, result, ms = 0, error = false) {
    const entry = this.tools.get(id); if (!entry) return;
    Object.assign(entry, { result: String(result), state: error ? 'failed' : 'done', ms, cache: null }); this.schedule();
  }
  submit(text) {
    if (this.confirmations.length) {
      const pending = this.confirmations.shift();
      pending.resolve(pending.text ? text : /^y(es)?$/i.test(text.trim()));
      if (!this.confirmations.length && this.savedDraft) {
        [this.draft, this.cursor] = this.savedDraft; this.savedDraft = null;
      }
      this.schedule(); return;
    }
    if (!text.trim()) return;
    if (this.onSubmit) { this.onSubmit(text); return; }
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(text); }
    else this.queue.push(text);
    this.schedule();
  }
  nextPrompt() {
    this.busy = false; this.phase = 'Ready'; this.schedule();
    return this.queue.length ? Promise.resolve(this.queue.shift()) : new Promise(resolve => { this.waiter = resolve; });
  }
  ask(question) {
    if (!this.confirmations.length) { this.savedDraft = [this.draft, this.cursor]; this.draft = []; this.cursor = 0; }
    return new Promise(resolve => { this.confirmations.push({ question, resolve, text: true }); this.schedule(); });
  }
  select(title, hint, items) {
    if (this.selection) throw new Error('A selection is already open');
    const saved = [this.draft, this.cursor, this.offset];
    this.draft = []; this.cursor = 0;
    return new Promise(resolve => {
      this.selection = { title, hint, items, index: 0, saved, resolve };
      this.schedule();
    });
  }
  selectionItems() {
    const query = this.draft.join('').trim().toLowerCase();
    return !query || /^\d+$/.test(query) ? this.selection.items : this.selection.items.filter(item => `${item.label} ${item.id} ${item.description || ''}`.toLowerCase().includes(query));
  }
  finishSelection(value) {
    const selection = this.selection; if (!selection) return;
    [this.draft, this.cursor, this.offset] = selection.saved;
    this.selection = null; this.lastRowCount = null;
    selection.resolve(value); this.schedule();
  }
  confirm(question) {
    if (!this.confirmations.length) { this.savedDraft = [this.draft, this.cursor]; this.draft = []; this.cursor = 0; }
    return new Promise(resolve => { this.confirmations.push({ question, resolve }); this.schedule(); });
  }
  key(str, key) {
    if (this.selection) {
      const items = this.selectionItems();
      if (key.name === 'escape' || key.ctrl && key.name === 'c') { this.finishSelection(null); return; }
      if (['up', 'down', 'pageup', 'pagedown'].includes(key.name)) {
        const step = key.name.startsWith('page') ? Math.max(1, Math.floor(((this.output.rows || 24) - 12) / 2)) : 1;
        this.selection.index = Math.max(0, Math.min(items.length - 1, this.selection.index + (['up', 'pageup'].includes(key.name) ? -step : step)));
      } else if (key.name === 'return' || key.name === 'enter') {
        const query = this.draft.join('').trim();
        const selected = /^\d+$/.test(query) ? items[Number(query) - 1] : items[this.selection.index];
        if (selected) this.finishSelection(selected.id);
      } else if (key.name === 'backspace') { this.draft.pop(); this.cursor = this.draft.length; this.selection.index = 0; }
      else if (!key.ctrl && !key.meta && str && !str.startsWith('\x1b')) { this.draft.push(...chars(cleanText(str))); this.cursor = this.draft.length; this.selection.index = 0; }
      this.schedule(); return;
    }
    if (key.name === 'tab' && this.draft.join('').startsWith('/')) {
      const command = ['/commands', '/help', '/model', '/provider', '/usage', '/session', '/exit'].find(value => value.startsWith(this.draft.join('')));
      if (command) { this.draft = chars(command + ' '); this.cursor = this.draft.length; this.schedule(); }
      return;
    }
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; return; }
    if (this.pasting) { this.insert(str || ''); return; }
    if (key.ctrl && key.name === 'r') { this.reasoning = !this.reasoning; this.schedule(); return; }
    if (key.ctrl && key.name === 'e') { this.results = !this.results; this.schedule(); return; }
    if (key.ctrl && key.name === 'l') { this.frames = []; this.schedule(); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') { this.offset = Math.max(0, this.offset + (key.name === 'pageup' ? 1 : -1) * Math.max(1, (this.output.rows || 24) - 8)); this.schedule(); return; }
    if (key.name === 'escape' || key.ctrl && key.name === 'c') {
      if (this.confirmations.length) this.submit('n');
      else if (this.interrupt) this.interrupt();
      else if (this.busy) { this.stopRequested = true; this.phase = 'Stopping after current tools'; }
      else this.submit('/exit');
      this.schedule(); return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (key.meta || key.shift) this.insert('\n');
      else { const text = this.draft.join(''); this.draft = []; this.cursor = 0; this.submit(text); }
    } else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.draft.length, this.cursor + 1);
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') { this.cursor = this.draft.length; if (key.ctrl) this.offset = 0; }
    else if (key.name === 'backspace' && this.cursor) this.draft.splice(--this.cursor, 1);
    else if (key.name === 'delete') this.draft.splice(this.cursor, 1);
    else if (!key.ctrl && !key.meta && str && !str.startsWith('\x1b')) this.insert(str);
    this.schedule();
  }
  insert(str) { const value = chars(cleanText(str).replace(/\r/g, '\n')); this.draft.splice(this.cursor, 0, ...value); this.cursor += value.length; this.schedule(); }
  schedule() { if (!this.closed && !this.pending) this.pending = setTimeout(() => { this.pending = null; this.render(); }, 40); }
  render() {
    if (this.closed) return;
    const width = Math.max(1, (this.output.columns || 80) - 1), height = Math.max(4, this.output.rows || 24);
    const paint = (code, text) => this.opts.color === false || process.env.NO_COLOR != null ? text : `\x1b[${code}m${text}\x1b[0m`;
    const muted = text => paint('90', text);
    const contentWidth = Math.max(1, Math.min(96, width - 4));
    const line = (text, code = '') => {
      const safe = clip(text, Math.max(1, width - 2));
      return ' '.repeat(Math.min(2, width - 1)) + (code ? paint(code, safe) : safe);
    };
    const rows = [];
    for (const entry of this.entries) {
      const cacheKey = `${width}/${this.results}/${this.reasoning}/${this.opts.color}`;
      if (!entry.cache || entry.cache.key !== cacheKey) {
        let rendered = [];
        if (entry.kind === 'reasoning' && !this.reasoning) {
          rendered = []; // Hidden reasoning should not interrupt the answer.
        } else if (entry.kind === 'tool') {
          const icon = entry.state === 'running' ? '◌' : entry.state === 'failed' ? '✗' : '✓';
          const code = entry.state === 'failed' ? '91' : entry.state === 'running' ? '93' : '90';
          rendered.push(line(`${icon} ${entry.text}  ·  ${entry.state}${entry.ms ? `  ${(entry.ms / 1000).toFixed(1)}s` : ''}`, code));
          if (this.results || entry.state === 'failed') {
            for (const text of wrapText(`${entry.args}\n${entry.result || ''}`, contentWidth - 2)) rendered.push(line(`│ ${text}`, '90'));
            rendered.push('');
          }
        } else if (['user', 'assistant', 'reasoning'].includes(entry.kind)) {
          const code = entry.kind === 'user' ? '1;96' : entry.kind === 'assistant' ? '1;92' : '90';
          const label = entry.kind === 'user' ? 'YOU' : entry.kind === 'assistant' ? 'SWITCHYARD' : 'REASONING';
          rendered.push('', line(label, code));
          let fenced = false;
          for (const raw of cleanText(entry.text).split('\n')) {
            if (raw.trim().startsWith('```')) { fenced = !fenced; rendered.push(line(fenced ? `┌─ ${raw.trim().slice(3) || 'code'}` : '└─', '90')); continue; }
            for (const text of wrapText(raw, Math.max(1, contentWidth - (fenced ? 2 : 0)))) {
              if (fenced) rendered.push(line(`│ ${text}`, '36'));
              else if (/^#{1,6} /.test(text)) rendered.push(line(text.replace(/^#{1,6} /, ''), '1'));
              else {
                const styled = text.replace(/`([^`]+)`/g, (_, value) => paint('36', value)).replace(/\*\*([^*]+)\*\*/g, (_, value) => paint('1', value));
                rendered.push(' '.repeat(Math.min(2, width - 1)) + styled);
              }
            }
          }
          rendered.push('');
        } else {
          for (const text of wrapText(entry.text, contentWidth)) rendered.push(line(text, ['warn', 'error'].includes(entry.kind) ? '93' : '90'));
        }
        entry.cache = { key: cacheKey, rows: rendered };
      }
      rows.push(...entry.cache.rows);
    }
    const modal = this.confirmations[0];
    const footer = modal ? wrapText(`${modal.text ? "Question" : "Permission"}: ${modal.question}${modal.text ? "" : " [y/N]"}`, width).slice(-Math.max(1, height - 8)).map(text => paint('93', text)) : [];
    const bodyHeight = Math.max(0, height - 7 - footer.length);
    if (this.selection) {
      const selection = this.selection, items = this.selectionItems();
      selection.index = Math.max(0, Math.min(selection.index, items.length - 1));
      const details = wrapText(items[selection.index]?.description || '', Math.max(1, width - 4)).slice(0, Math.max(0, Math.min(3, bodyHeight - 8)));
      const pageSize = Math.max(1, Math.floor((bodyHeight - 5 - details.length) / 2));
      const start = Math.floor(selection.index / pageSize) * pageSize;
      rows.splice(0, rows.length, '', line(selection.title, '1;96'), line(selection.hint, '90'), '');
      items.slice(start, start + pageSize).forEach((item, index) => {
        const number = start + index;
        rows.push(line(`${number === selection.index ? '›' : ' '} ${number + 1}. ${item.label}`, number === selection.index ? '1;96' : '37'));
        rows.push(line(`     ${item.description || item.id}`, '90'));
      });
      if (!items.length) rows.push(line('No matching choices. Backspace to change the filter.', '93'));
      for (const detail of details) rows.push(line(detail, '90'));
      rows.push(line(`${items.length} choices · ↑/↓ select · PgUp/Dn page · Esc back`, '90'));
      this.offset = Math.max(0, rows.length - bodyHeight); this.lastRowCount = rows.length;
    }
    // Keep the same history in view when new rows arrive while scrolled up.
    if (this.offset && this.lastRowCount != null) this.offset += Math.max(0, rows.length - this.lastRowCount);
    this.lastRowCount = rows.length; this.offset = Math.min(this.offset, Math.max(0, rows.length - bodyHeight));
    const end = rows.length - this.offset;
    const view = rows.slice(Math.max(0, end - bodyHeight), end);
    while (view.length < bodyHeight) view.push('');
    const elapsed = this.busy && this.started ? ` · ${Math.floor((Date.now() - this.started) / 1000)}s` : '';
    const usage = this.usage ? ` · ${this.usage.prompt.toLocaleString()} in · ${this.usage.completion.toLocaleString()} out · ${this.usage.share}% cached` : this.busy ? ` · ~${this.tokens || 0} generated` : '';
    const status = `${this.accountLimits ? this.accountLimits + ' · ' : ''}${this.phase}${elapsed}${this.queue.length ? ` · ${this.queue.length} queued` : ''}${this.offset ? ` · ↑ ${this.offset} rows` : ''}${usage}`;
    const before = this.draft.slice(0, this.cursor).join('').replace(/\n/g, '↵');
    const after = this.draft.slice(this.cursor).join('').replace(/\n/g, '↵');
    const available = Math.max(1, width - 7); let visible = chars(before);
    while (cellWidth(visible.join('')) >= available && visible.length) visible.shift();
    const inputText = clip(visible.join('') + after, Math.max(1, width - 6));
    const placeholder = this.selection ? 'Type a number or filter…' : modal ? (modal.text ? 'Your answer…' : 'Approve? y / N') : this.busy ? 'Queue a follow-up…' : 'Ask Switchyard…';
    const inputBody = inputText || clip(placeholder, Math.max(1, width - 6));
    const border = (left, text, right) => clip(left + text + '─'.repeat(Math.max(0, width - cellWidth(left + text + right))) + right, width);
    const frame = [
      line(`SWITCHYARD  /  ${this.opts.model}  ·  ${this.opts.provider}`, '1;96'),
      muted('─'.repeat(width)),
      ...view, ...footer,
      line(status, this.busy ? '93' : '90'),
      muted(border('╭─ ', modal ? ' Permission ' : ' Message ', '╮')),
      muted('│ ') + paint('96', '› ') + (inputText ? inputBody : muted(inputBody)) + ' '.repeat(Math.max(0, width - cellWidth(inputBody) - 5)) + muted('│'),
      muted(border('╰', '', '╯')),
      muted(clip(this.draft.join('').startsWith('/') && !this.selection ? '/commands  /model  /provider  /usage  /session  /exit · Tab complete' : width < 75 ? 'Enter send · PgUp/Dn scroll · Ctrl+E tools' : 'Enter send   Esc stop   PgUp/Dn scroll   Ctrl+R reasoning   Ctrl+E tools', width))
    ];
    if (height < 8) {
      frame.splice(0, frame.length, clip('Switchyard', width), ...Array.from({ length: height - 3 }, () => ''), clip(status, width), clip('> ' + inputText, width));
    }
    let out = '\x1b[?25l';
    for (let i = 0; i < frame.length; i++) if (frame[i] !== this.frames[i]) out += `\x1b[${i + 1};1H\x1b[2K${frame[i]}`;
    out += `\x1b[${height < 8 ? height : height - 2};${Math.min(width, (height < 8 ? 3 : 5) + cellWidth(visible.join('')))}H\x1b[?25h`;
    this.rawWrite(out); this.frames = frame;
  }
  close() {
    if (this.closed) return; this.closed = true;
    if (this.selection) this.finishSelection(null);
    clearTimeout(this.pending); clearInterval(this.tick);
    this.input.off('keypress', this.onKey); this.output.off('resize', this.onResize); process.off('exit', this.onExit);
    this.input.off('end', this.onEnd);
    this.output.write = this.oldOut; this.error.write = this.oldErr;
    try { this.input.setRawMode(Boolean(this.oldRaw)); } catch {}
    if (this.oldPaused) this.input.pause();
    this.rawWrite('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    for (const pending of this.confirmations) pending.resolve(false);
    if (this.waiter) this.waiter('/exit');
  }
}
