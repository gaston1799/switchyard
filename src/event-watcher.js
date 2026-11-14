import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateAgentId } from './agent-coordination.js';
import { getDecision } from './decisions.js';

const EVENT_ID = /^sy-[a-f0-9]{64}$/;
const BOARD_TYPES = new Set(['agent_registered', 'agent_stopped', 'task_created', 'task_claimed', 'task_claim_expired', 'task_handoff', 'task_decisions_revalidated']);
const summary = value => String(value || '').slice(0, 400);
const digest = value => createHash('sha256').update(value).digest('hex');

function envelope(key, type, occurredAt, source, data) {
  return { schemaVersion: 1, eventId: `sy-${digest(key)}`, type, occurredAt: Number.isFinite(Date.parse(occurredAt)) ? occurredAt : null, source, data };
}
async function entries(path, onDiagnostic) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') onDiagnostic?.({ path, error: error.message }); return []; }
}
async function json(path, onDiagnostic) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') onDiagnostic?.({ path, error: error.message }); return null; }
}
async function records(path, onDiagnostic) {
  const result = [];
  for (const entry of await entries(path, onDiagnostic)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await json(join(path, entry.name), onDiagnostic);
    if (record) result.push(record);
  }
  return result;
}

// Observation only: do not initialize the board, consume inbox messages, create
// runtime records, synthesize a heartbeat, or mutate decisions/task ownership.
export async function collectBoardEvents(root, { agentId, onDiagnostic } = {}) {
  agentId = validateAgentId(agentId);
  const agent = await json(join(root, 'agents', `${agentId}.json`), onDiagnostic);
  const coordinator = agent?.role === 'coordinator';
  const tasks = new Map();
  for (const task of await records(join(root, 'tasks'), onDiagnostic)) {
    if (typeof task.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(task.taskId)) continue;
    const claim = await json(join(root, 'claims', `${task.taskId}.json`), onDiagnostic);
    tasks.set(task.taskId, { task, relevant: coordinator || task.createdBy === agentId || claim?.agentId === agentId });
  }
  const messages = new Map();
  for (const mailbox of ['inbox', 'processed']) {
    for (const message of await records(join(root, mailbox, agentId), onDiagnostic)) {
      if (typeof message.id === 'string' && message.to === agentId) messages.set(message.id, message);
    }
  }
  const decisionNotices = new Map();
  for (const message of messages.values()) {
    const match = message.from === 'decision-board' && /^Decision (decision-[a-f0-9]{32}) revision ([1-9]\d*):/.exec(message.body);
    if (match) decisionNotices.set(message.id, `${match[1]}:${match[2]}`);
  }
  const events = new Map(), decisionKeys = new Set();
  for (const entry of await entries(join(root, 'decisions'), onDiagnostic)) {
    if (!entry.isDirectory() || !/^decision-[a-f0-9]{32}$/.test(entry.name)) continue;
    let record;
    try { record = await getDecision(root, entry.name); }
    catch (error) { onDiagnostic?.({ path: join(root, 'decisions', entry.name), error: error.message }); continue; }
    for (const revision of record.history) {
      const affectedTasks = Array.isArray(revision.affectedTasks) ? revision.affectedTasks : record.affectedTasks;
      const key = `${record.id}:${revision.revision}`;
      const relevant = coordinator || record.proposer === agentId || record.coordinatorId === agentId
        || [...decisionNotices.values()].includes(key)
        || [...tasks.values()].some(({ task, relevant }) => relevant && (task.decisionDependencies?.includes(record.id) || affectedTasks.includes(task.taskId)));
      if (!relevant) continue;
      const event = envelope(`decision:${key}`, 'decision.changed', revision.at,
        { kind: 'decision', id: record.id, revision: revision.revision },
        { project: record.project, question: summary(record.question), status: revision.status,
          authority: revision.assignedAuthority, reasoning: summary(revision.reasoning), affectedTasks });
      events.set(event.eventId, event); decisionKeys.add(key);
    }
  }
  for (const message of messages.values()) {
    // A decision revision and its durable mailbox notice are the same wakeup.
    // Only collapse them when the authoritative revision was read successfully.
    if (decisionKeys.has(decisionNotices.get(message.id))) continue;
    const event = envelope(`message:${message.id}`, 'message.received', message.createdAt,
      { kind: 'message', id: message.id },
      { from: message.from, to: message.to, messageType: message.type, taskId: message.taskId || null,
        priority: message.priority, summary: summary(message.body) });
    events.set(event.eventId, event);
  }
  for (const record of await records(join(root, 'events'), onDiagnostic)) {
    if (!BOARD_TYPES.has(record.type) || typeof record.id !== 'string') continue;
    const taskEvent = record.type.startsWith('task_');
    const relevant = taskEvent
      ? coordinator || record.agentId === agentId || record.createdBy === agentId || tasks.get(record.taskId)?.relevant
      : coordinator || record.agentId === agentId || record.agentId === agent?.coordinatorId;
    if (!relevant) continue;
    const event = envelope(`board:${record.id}`, taskEvent ? 'task.changed' : 'agent.lifecycle', record.createdAt,
      { kind: 'board', id: record.id },
      { eventType: record.type, agentId: record.agentId || record.createdBy || null, taskId: record.taskId || null,
        state: record.state || null, status: record.status || null });
    events.set(event.eventId, event);
  }
  return [...events.values()].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt))
    || (a.source.kind === 'decision' && b.source.kind === 'decision' && a.source.id === b.source.id ? a.source.revision - b.source.revision : a.eventId.localeCompare(b.eventId)));
}

async function publishOnce(file, value) {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, file); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temp).catch(() => {}); }
}

async function subscription(root, agentId, consumer) {
  agentId = validateAgentId(agentId); consumer = validateAgentId(consumer);
  if (!(await stat(root)).isDirectory()) throw new Error('Coordination root must be an existing directory.');
  const directory = join(root, 'subscriptions', consumer);
  await mkdir(join(directory, 'acks'), { recursive: true });
  const file = join(directory, 'subscription.json');
  let saved;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await publishOnce(file, { schemaVersion: 1, agentId, consumer, createdAt: new Date().toISOString() });
    saved = JSON.parse(await readFile(file, 'utf8'));
  }
  if (saved.schemaVersion !== 1 || saved.agentId !== agentId || saved.consumer !== consumer) throw new Error('Event consumer is already bound to a different agent, or its subscription is invalid.');
  return directory;
}

async function acknowledged(directory, eventId) {
  try {
    const record = JSON.parse(await readFile(join(directory, 'acks', `${eventId}.json`), 'utf8'));
    return record.schemaVersion === 1 && record.eventId === eventId;
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}

export async function pollEvents({ root, agentId, consumer, onDiagnostic, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Event limit must be an integer from 1 to 1000.');
  const directory = await subscription(root, agentId, consumer);
  const result = [];
  for (const event of await collectBoardEvents(root, { agentId, onDiagnostic })) {
    if (!await acknowledged(directory, event.eventId)) result.push(event);
    if (result.length >= limit) break;
  }
  return result;
}

export async function acknowledgeEvents({ root, agentId, consumer, eventIds } = {}) {
  if (!Array.isArray(eventIds) || !eventIds.length || eventIds.some(id => !EVENT_ID.test(id))) throw new Error('Supply valid event IDs to acknowledge.');
  const directory = await subscription(root, agentId, consumer);
  const available = new Set((await collectBoardEvents(root, { agentId })).map(event => event.eventId));
  for (const eventId of new Set(eventIds)) {
    if (!available.has(eventId) && !await acknowledged(directory, eventId)) throw new Error(`Unknown event for this agent: ${eventId}`);
  }
  for (const eventId of new Set(eventIds)) {
    const file = join(directory, 'acks', `${eventId}.json`);
    // An invalid existing receipt is replayed by readers and requires repair;
    // never replace another writer's immutable receipt behind its back.
    await publishOnce(file, { schemaVersion: 1, eventId, acknowledgedAt: new Date().toISOString() });
    if (!await acknowledged(directory, eventId)) throw new Error(`Invalid acknowledgement receipt: ${file}`);
  }
  return { acknowledged: [...new Set(eventIds)] };
}

export async function watchEvents({ onEvent, signal, pollMs = 1000, timeoutMs = 0, once = false, ...options } = {}) {
  if (typeof onEvent !== 'function') throw new Error('An event delivery callback is required.');
  validateAgentId(options.agentId); validateAgentId(options.consumer);
  if (typeof options.root !== 'string' || !options.root) throw new Error('A coordination root is required.');
  if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 30000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid event polling interval or timeout.');
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Event limit must be an integer from 1 to 1000.');
  const emitted = new Set(), diagnostics = new Set();
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
  const diagnostic = value => {
    const key = JSON.stringify(value);
    if (!diagnostics.has(key)) { diagnostics.add(key); options.onDiagnostic?.(value); }
  };
  while (!signal?.aborted && Date.now() <= deadline) {
    try {
      // Poll beyond this process's already emitted prefix so a slow/unacked
      // consumer cannot starve newer events behind the first page.
      const directory = await subscription(options.root, options.agentId, options.consumer);
      let batch = 0;
      for (const event of await collectBoardEvents(options.root, { agentId: options.agentId, onDiagnostic: diagnostic })) {
        if (signal?.aborted) break;
        if (emitted.has(event.eventId) || await acknowledged(directory, event.eventId)) continue;
        await onEvent(event);
        emitted.add(event.eventId); batch++;
        if (batch >= limit) break;
      }
      if ((once && (emitted.size || !timeoutMs)) || Date.now() >= deadline) break;
    } catch (error) {
      if (signal?.aborted) break;
      if (once && !timeoutMs) throw error;
      diagnostic({ error: error.message });
    }
    try { await delay(Math.max(0, Math.min(pollMs, deadline - Date.now())), undefined, { signal }); }
    catch (error) { if (signal?.aborted) break; throw error; }
  }
  return { emitted: emitted.size };
}
