import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DECISION_STATUSES = ['proposed', 'classified', 'pending', 'approved', 'rejected', 'blocked', 'implemented', 'verified', 'superseded', 'cancelled'];
export const DECISION_CATEGORIES = ['routine', 'technical', 'architecture', 'library', 'algorithm', 'implementation', 'product', 'ux', 'business', 'pricing', 'legal', 'security', 'financial'];
const HUMAN = new Set(['product', 'ux', 'business', 'pricing', 'legal', 'security', 'financial']);
const ranks = { worker: 0, coordinator: 1, human: 2 };
const usable = new Set(['approved', 'implemented', 'verified']);
const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const requiredText = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`); return value.trim(); };
export function validateDecisionId(id) {
  if (!/^decision-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid decision ID.');
  return id;
}
function categories(value) {
  const result = [...new Set(Array.isArray(value) ? value : [value])];
  if (!result.length || result.some(item => !DECISION_CATEGORIES.includes(item))) throw new Error('Unknown decision category.');
  return result;
}
function authority(category) {
  return category.some(item => HUMAN.has(item)) ? 'human' : category.every(item => item === 'routine') ? 'worker' : 'coordinator';
}
function requireActor(actor) {
  if (!actor?.id || !Object.hasOwn(ranks, actor.role)) throw new Error('A trusted decision actor is required.');
}
function authorize(record, actor) {
  requireActor(actor);
  if (ranks[actor.role] < ranks[record.assignedAuthority] || (actor.role === 'worker' && record.proposer !== actor.id)) {
    throw new Error(`Decision requires ${record.assignedAuthority} authority.`);
  }
}
function folder(root, id) { return join(root, 'decisions', validateDecisionId(id)); }

// Publish a fully written, fsynced file with an exclusive hard link. No lock can
// be stranded by a crash, and an existing revision can never be overwritten.
async function publish(root, record) {
  const dir = folder(root, record.id);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(temp, join(dir, `${record.revision}.json`)); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Decision revision conflict; reload and retry with the current expected_revision.');
      throw error;
    }
    // Directory fsync is supported on POSIX; Windows does not expose it here.
    if (process.platform !== 'win32') {
      const directory = await open(dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
  return record;
}

export async function getDecision(root, id) {
  const dir = folder(root, id);
  const names = await readdir(dir);
  const revisions = names.filter(name => /^[1-9]\d*\.json$/.test(name)).map(name => Number(name.slice(0, -5))).sort((a, b) => a - b);
  if (!revisions.length) throw new Error(`Decision '${id}' has no committed revision.`);
  if (revisions.some((revision, index) => revision !== index + 1)) throw new Error(`Decision '${id}' has a revision gap; recovery required.`);
  const record = JSON.parse(await readFile(join(dir, `${revisions.at(-1)}.json`), 'utf8'));
  if (record.schemaVersion !== 1 || record.id !== id || record.revision !== revisions.at(-1) || !DECISION_STATUSES.includes(record.status)
    || !Object.hasOwn(ranks, record.assignedAuthority) || !Array.isArray(record.category) || !record.category.length
    || record.category.some(item => !DECISION_CATEGORIES.includes(item)) || ranks[record.assignedAuthority] < ranks[authority(record.category)]
    || typeof record.proposer !== 'string' || !record.proposer || typeof record.project !== 'string' || typeof record.question !== 'string'
    || !Array.isArray(record.options) || !Array.isArray(record.affectedTasks) || !Array.isArray(record.history)
    || record.history.length !== record.revision || record.history.some((entry, index) => entry.revision !== index + 1 || !entry.actor || !Object.hasOwn(ranks, entry.role))
    || record.history.at(-1).status !== record.status || !Number.isFinite(Date.parse(record.updatedAt))
    || (usable.has(record.status) && (!record.approval || !Object.hasOwn(ranks, record.approval.role)
      || ranks[record.approval.role] < ranks[record.assignedAuthority] || (record.approval.role === 'worker' && record.approval.actor !== record.proposer)))) {
    throw new Error(`Invalid decision record '${id}'; recovery required.`);
  }
  return record;
}

export async function listDecisions(root, filter = {}) {
  let entries;
  try { entries = await readdir(join(root, 'decisions'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^decision-[a-f0-9]{32}$/.test(entry.name)) continue;
    // An interrupted first publication leaves only temp files, not a decision.
    const names = await readdir(join(root, 'decisions', entry.name));
    if (!names.some(name => /^[1-9]\d*\.json$/.test(name))) continue;
    const record = await getDecision(root, entry.name);
    if ((!filter.project || record.project === filter.project) && (!filter.status || record.status === filter.status) && (!filter.authority || record.assignedAuthority === filter.authority)) result.push(record);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function event(record, actor, action, reasoning) {
  return { revision: record.revision, actor: actor.id, role: actor.role, action, status: record.status, reasoning: reasoning || '', at: record.updatedAt,
    category: [...record.category], assignedAuthority: record.assignedAuthority, options: [...record.options], recommendation: record.recommendation,
    resolution: record.resolution, affectedTasks: [...record.affectedTasks], ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}) };
}
function stringList(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of non-empty strings.`);
  return [...new Set(value.map(item => item.trim()))];
}
export async function createDecision(root, input, actor) {
  requireActor(actor);
  const project = requiredText(input.project, 'project');
  const question = requiredText(input.question, 'question');
  const category = categories(input.category);
  const id = `decision-${createHash('sha256').update(JSON.stringify([normalize(project), normalize(question)])).digest('hex').slice(0, 32)}`;
  // Exact normalized questions share an ID, including across concurrent creates.
  // Reuse never mutates an existing approval or lowers its authority.
  try {
    const existing = await getDecision(root, id);
    if (ranks[authority(category)] > ranks[existing.assignedAuthority]) throw new Error('Duplicate decision has lower authority; escalate the existing decision before reuse.');
    return { ...existing, duplicate: true };
  } catch (error) { if (error.code !== 'ENOENT' && !error.message.includes('has no committed revision')) throw error; }
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 1, id, project, question, category, proposer: actor.id,
    coordinatorId: actor.coordinatorId || (actor.role === 'coordinator' ? actor.id : null),
    assignedAuthority: authority(category), status: 'proposed',
    options: input.options === undefined ? [] : stringList(input.options, 'options'),
    recommendation: String(input.recommendation || ''), resolution: null,
    reasoning: String(input.reasoning || ''), affectedTasks: input.affected_tasks === undefined ? [] : stringList(input.affected_tasks, 'affected_tasks'),
    createdAt: now, updatedAt: now, revision: 1, history: []
  };
  record.history = [event(record, actor, 'created', record.reasoning)];
  try { return await publish(root, record); }
  catch (error) {
    if (!error.message.startsWith('Decision revision conflict')) throw error;
    const existing = await getDecision(root, id);
    if (ranks[authority(category)] > ranks[existing.assignedAuthority]) throw new Error('Duplicate decision has lower authority; escalate the existing decision before reuse.');
    return { ...existing, duplicate: true };
  }
}

export async function changeDecision(root, id, input, actor, action) {
  requireActor(actor);
  const previous = await getDecision(root, id);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision !== previous.revision) throw new Error('Decision revision conflict; supply the current expected_revision.');
  const record = structuredClone(previous);
  if (action === 'propose') {
    if (actor.id !== previous.proposer && actor.role === 'worker') throw new Error('Only the proposer or a higher authority may revise a proposal.');
    if (['superseded', 'cancelled'].includes(previous.status)) throw new Error('Terminal decisions cannot be revised; create a new question.');
    if (input.category !== undefined) record.category = categories(input.category);
    const minimum = authority(record.category);
    record.assignedAuthority = ranks[minimum] > ranks[previous.assignedAuthority] ? minimum : previous.assignedAuthority;
    for (const key of ['options', 'affected_tasks']) if (input[key] !== undefined) record[key === 'affected_tasks' ? 'affectedTasks' : key] = stringList(input[key], key);
    if (input.recommendation !== undefined) record.recommendation = String(input.recommendation);
    record.status = input.status || 'pending';
    if (!['classified', 'pending', 'blocked'].includes(record.status)) throw new Error('Proposal status must be classified, pending, or blocked.');
    record.resolution = null;
    delete record.approval;
  } else if (action === 'escalate') {
    if (actor.role === 'worker' && actor.id !== previous.proposer && actor.id !== previous.coordinatorId) throw new Error('Only the proposer or a higher authority may escalate.');
    if (['superseded', 'cancelled'].includes(previous.status)) throw new Error('Terminal decisions cannot be escalated.');
    const target = input.authority || (actor.role === 'worker' ? 'coordinator' : 'human');
    if (!['coordinator', 'human'].includes(target) || ranks[target] < ranks[previous.assignedAuthority]) throw new Error('Escalation cannot lower authority.');
    record.assignedAuthority = target;
    record.status = 'pending'; record.resolution = null; delete record.approval;
  } else if (action === 'resolve') {
    authorize(previous, actor);
    const status = input.status || 'approved';
    const transitions = {
      proposed: ['approved', 'rejected', 'blocked', 'cancelled', 'superseded'],
      classified: ['approved', 'rejected', 'blocked', 'cancelled', 'superseded'],
      pending: ['approved', 'rejected', 'blocked', 'cancelled', 'superseded'],
      blocked: ['approved', 'rejected', 'cancelled', 'superseded'],
      approved: ['implemented', 'superseded', 'cancelled'],
      implemented: ['verified', 'superseded', 'cancelled'],
      verified: ['superseded', 'cancelled'], rejected: ['superseded', 'cancelled'], superseded: [], cancelled: []
    };
    if (!transitions[previous.status].includes(status)) throw new Error(`Invalid decision transition: ${previous.status} -> ${status}.`);
    record.status = status;
    record.resolution = requiredText(input.resolution, 'resolution');
    if (status === 'approved') record.approval = { actor: actor.id, role: actor.role, at: new Date().toISOString() };
    if (status === 'superseded') {
      if (!input.superseded_by || input.superseded_by === id) throw new Error('superseded_by must reference another existing decision.');
      const successor = await getDecision(root, input.superseded_by);
      if (successor.project !== previous.project) throw new Error('Successor must belong to the same project.');
      record.supersededBy = successor.id;
    }
  } else throw new Error('Unknown decision operation.');
  record.reasoning = requiredText(input.reasoning, 'reasoning');
  record.updatedAt = new Date().toISOString(); record.revision++;
  record.history.push(event(record, actor, action, record.reasoning));
  return publish(root, record);
}

export function decisionUsable(record) { return usable.has(record.status) && Boolean(record.approval); }

// Derived rather than cached: old tasks without decision dependencies need no
// migration, and a crash cannot strand an out-of-date task status on disk.
export async function taskDecisionState(root, task, observedRevisions = task.decisionRevisions) {
  const revisions = {}, blockers = [], changed = [];
  for (const id of task.decisionDependencies || []) {
    let record;
    try { record = await getDecision(root, id); }
    catch (error) { blockers.push({ id, reason: error.code === 'ENOENT' ? 'missing' : error.message }); continue; }
    revisions[id] = record.revision;
    if (!decisionUsable(record)) blockers.push({ id, status: record.status });
    if (observedRevisions && observedRevisions[id] !== record.revision) changed.push(id);
  }
  return { decisionRevisions: revisions, observedDecisionRevisions: observedRevisions || null, decisionBlockers: blockers, needsRevalidation: changed.length > 0, changedDecisions: changed };
}
