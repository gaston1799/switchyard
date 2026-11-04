import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { workspaceCoordinationDirectory } from "./data-store.js";

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_STALE_MS = 30000;

function nowIso() {
  return new Date().toISOString();
}

function requireId(value, label, pattern) {
  const id = String(value || "").trim();
  if (!pattern.test(id)) {
    throw new Error(`${label} must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or dash.`);
  }
  return id;
}

export function validateAgentId(value) {
  return requireId(value, "agent id", AGENT_ID_RE);
}

export function validateTaskId(value) {
  return requireId(value, "task id", TASK_ID_RE);
}

export function generateAgentId(role = "agent") {
  const prefix = String(role || "agent").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function coordinationRoot(value, cwd = process.cwd()) {
  return value ? resolve(cwd, value) : workspaceCoordinationDirectory(cwd);
}

function paths(root) {
  return {
    agents: join(root, "agents"),
    inbox: join(root, "inbox"),
    processed: join(root, "processed"),
    tasks: join(root, "tasks"),
    claims: join(root, "claims"),
    events: join(root, "events")
  };
}

export async function initializeCoordination(root) {
  const p = paths(root);
  await Promise.all(Object.values(p).map((folder) => mkdir(folder, { recursive: true })));
  return p;
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, content, "utf8");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const transientWindowsReplace = process.platform === "win32" && ["EACCES", "EEXIST", "EPERM"].includes(error?.code);
      if (!transientWindowsReplace) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10 * (attempt + 1)));
    }
  }
  // Windows virus scanners can hold the destination between retries. Runtime
  // records are serialized per owner, so a direct overwrite is a safe final
  // fallback; readers already ignore a transient parse failure and retry.
  await writeFile(file, content, "utf8");
  try { await unlink(temp); } catch (error) { if (!isMissing(error)) throw error; }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

export function isProcessAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function heartbeatFresh(record, staleMs = DEFAULT_STALE_MS) {
  const timestamp = Date.parse(record?.heartbeatAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp <= staleMs;
}

function publicAgentRecord(record, staleMs = DEFAULT_STALE_MS) {
  const processAlive = isProcessAlive(record.pid);
  const heartbeatCurrent = heartbeatFresh(record, staleMs);
  return {
    ...record,
    live: processAlive && heartbeatCurrent && !["completed", "failed", "stopped"].includes(record.state),
    processAlive,
    heartbeatCurrent
  };
}

export async function listAgents(root, { includeStopped = false, staleMs = DEFAULT_STALE_MS } = {}) {
  const p = await initializeCoordination(root);
  const entries = await readdir(p.agents, { withFileTypes: true });
  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = publicAgentRecord(await readJson(join(p.agents, entry.name)), staleMs);
      if (includeStopped || record.live) agents.push(record);
    } catch {}
  }
  return agents.sort((a, b) => String(a.agentId).localeCompare(String(b.agentId)));
}

async function appendEvent(root, type, data) {
  const p = await initializeCoordination(root);
  const event = { id: randomUUID(), type, createdAt: nowIso(), ...data };
  await writeJsonAtomic(join(p.events, `${Date.now()}-${event.id}.json`), event);
  return event;
}

export async function createAgentRuntime(root, options = {}) {
  const p = await initializeCoordination(root);
  const agentId = validateAgentId(options.agentId);
  const instanceId = options.instanceId || randomUUID();
  const file = join(p.agents, `${agentId}.json`);
  try {
    const existing = publicAgentRecord(await readJson(file));
    if (existing.live && existing.instanceId !== instanceId) {
      throw new Error(`agent id '${agentId}' is already active with PID ${existing.pid}.`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const ownerFiles = [file + '.owner', ...(options.session ? [resolve(options.session) + '.owner'] : [])];
  const acquired = [];
  const releaseOwnership = async () => {
    for (const path of acquired.splice(0)) {
      try { const owner = await readJson(path); if (owner.instanceId === instanceId) await unlink(path); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  };
  try {
    for (const path of ownerFiles) {
      await mkdir(dirname(path), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try {
          const handle = await open(path, 'wx');
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId })); } finally { await handle.close(); }
          acquired.push(path); break;
        } catch (error) {
          if (error.code !== 'EEXIST' || attempt > 0) throw error;
          let owner;
          try { owner = await readJson(path); }
          catch { throw new Error(`Agent/session ownership is being acquired: ${path}`); }
          if (isProcessAlive(owner.pid)) throw new Error(`Agent/session already active with PID ${owner.pid}.`);
          try { await unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
        }
      }
    }
  } catch (error) { await releaseOwnership(); throw error; }

  let record = {
    schemaVersion: 1,
    agentId,
    instanceId,
    pid: process.pid,
    workspace: resolve(options.workspace || process.cwd()),
    coordinationRoot: root,
    session: options.session ? resolve(options.session) : null,
    role: String(options.role || "worker"),
    displayName: String(options.displayName || options.display_name || agentId).trim().slice(0, 80) || agentId,
    coordinatorId: options.coordinatorId ? validateAgentId(options.coordinatorId) : null,
    state: String(options.state || "starting"),
    mission: String(options.mission || ""),
    claimedTasks: [],
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    updatedAt: nowIso()
  };
  let stopped = false;
  let writeChain = Promise.resolve();

  const writeRecord = (patch = {}) => {
    writeChain = writeChain.then(async () => {
      if (stopped && patch.state == null) return record;
      record = { ...record, ...patch, heartbeatAt: nowIso(), updatedAt: nowIso() };
      await writeJsonAtomic(file, record);
      return record;
    });
    return writeChain;
  };

  try {
    await writeRecord();
    await appendEvent(root, "agent_registered", { agentId, instanceId, pid: process.pid, workspace: record.workspace, role: record.role });
  } catch (error) { await releaseOwnership(); throw error; }
  const heartbeatMs = Math.max(Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS, 250);
  const heartbeat = setInterval(() => { void writeRecord(); }, heartbeatMs);
  heartbeat.unref?.();

  return {
    agentId,
    instanceId,
    root,
    get record() { return { ...record }; },
    async update(patch) { return writeRecord(patch); },
    async setState(state, patch = {}) { return writeRecord({ ...patch, state }); },
    async addClaim(taskId) {
      const claims = [...new Set([...(record.claimedTasks || []), validateTaskId(taskId)])];
      return writeRecord({ claimedTasks: claims });
    },
    async removeClaim(taskId) {
      const id = validateTaskId(taskId);
      return writeRecord({ claimedTasks: (record.claimedTasks || []).filter((item) => item !== id) });
    },
    async stop(state = "completed", patch = {}) {
      clearInterval(heartbeat);
      await writeRecord({ ...patch, state });
      stopped = true;
      await appendEvent(root, "agent_stopped", { agentId, instanceId, state });
      await releaseOwnership();
      return { ...record };
    }
  };
}

const messageWrites = new Map();
export async function sendAgentMessage(root, input = {}) {
  const key = `${resolve(root)}:${input.to}:${input.id || randomUUID()}`;
  const next = (messageWrites.get(key) || Promise.resolve()).catch(() => {}).then(() => sendAgentMessageOnce(root, input));
  messageWrites.set(key, next);
  try { return await next; } finally { if (messageWrites.get(key) === next) messageWrites.delete(key); }
}

async function sendAgentMessageOnce(root, input = {}) {
  const p = await initializeCoordination(root);
  const from = validateAgentId(input.from);
  const to = validateAgentId(input.to);
  const body = String(input.body || "").trim();
  if (!body) throw new Error("message body must be non-empty.");
  try {
    await stat(join(p.agents, `${to}.json`));
  } catch (error) {
    if (isMissing(error)) throw new Error(`unknown agent '${to}'. Use 'd agents --all' to inspect registered agents.`);
    throw error;
  }
  const id = input.id || randomUUID();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error('Invalid message ID.');
  const stamp = input.id ? Number(id.match(/^\d{13}/)?.[0]) : Date.now();
  if (!Number.isFinite(stamp)) throw new Error('A supplied message ID must start with its timestamp.');
  const filename = `${stamp}-${id}.json`;
  if (input.id) {
    for (const folder of [p.processed, p.inbox]) {
      try {
        const existing = await readJson(join(folder, to, filename));
        if (existing.body !== body || existing.from !== from) throw new Error('Message ID already used for different content.');
        return existing;
      } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  const message = {
    schemaVersion: 1,
    id,
    from,
    to,
    type: String(input.type || "message"),
    priority: String(input.priority || "normal"),
    taskId: input.taskId ? validateTaskId(input.taskId) : null,
    replyTo: input.replyTo ? String(input.replyTo) : null,
    body,
    createdAt: nowIso()
  };
  const inbox = join(p.inbox, to);
  await mkdir(inbox, { recursive: true });
  await writeJsonAtomic(join(inbox, filename), message);
  await appendEvent(root, "message_sent", { messageId: id, from, to, messageType: message.type, taskId: message.taskId });
  return message;
}

export async function readAgentInbox(root, agentId, { max = 100 } = {}) {
  const id = validateAgentId(agentId);
  const p = await initializeCoordination(root);
  const inbox = join(p.inbox, id);
  await mkdir(inbox, { recursive: true });
  const entries = (await readdir(inbox, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, Math.min(Math.max(Number(max) || 100, 1), 1000));
  const messages = [];
  for (const entry of entries) {
    try {
      messages.push({ ...(await readJson(join(inbox, entry.name))), _file: entry.name });
    } catch {}
  }
  return messages;
}

export async function listAgentMessages(root, agentId, { max = 200 } = {}) {
  const id = validateAgentId(agentId);
  const p = await initializeCoordination(root);
  const messages = [];
  for (const [folder, deliveryState] of [[p.inbox, "pending"], [p.processed, "processed"]]) {
    const directory = join(folder, id);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        messages.push({
          ...(await readJson(join(directory, entry.name))),
          _file: entry.name,
          deliveryState
        });
      } catch { /* ignore partial or malformed coordination records */ }
    }
  }
  const limit = Math.min(Math.max(Number(max) || 200, 1), 1000);
  return messages
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.id).localeCompare(String(b.id)))
    .slice(-limit);
}

export async function listCoordinationEvents(root, { max = 300 } = {}) {
  const p = await initializeCoordination(root);
  const entries = (await readdir(p.events, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayTotal = entries.reduce((count, entry) => {
    const timestamp = Number(entry.name.split("-", 1)[0]);
    return count + (Number.isFinite(timestamp) && timestamp >= midnight.getTime() ? 1 : 0);
  }, 0);
  const limit = Math.min(Math.max(Number(max) || 300, 1), 2000);
  const events = [];
  for (const entry of entries.slice(-limit)) {
    try { events.push(await readJson(join(p.events, entry.name))); }
    catch { /* Ignore malformed event records. */ }
  }
  return { total: entries.length, todayTotal, events };
}

export async function acknowledgeAgentMessages(root, agentId, messages) {
  const id = validateAgentId(agentId);
  const p = await initializeCoordination(root);
  const destination = join(p.processed, id);
  await mkdir(destination, { recursive: true });
  let acknowledged = 0;
  for (const message of messages || []) {
    const file = String(message?._file || "");
    if (!/^\d+-[A-Za-z0-9-]+\.json$/.test(file)) continue;
    try {
      await rename(join(p.inbox, id, file), join(destination, file));
      acknowledged += 1;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return acknowledged;
}

export function formatAgentMessages(messages) {
  return (messages || []).map((message) => {
    const attributes = [
      `from=${JSON.stringify(message.from)}`,
      `type=${JSON.stringify(message.type || "message")}`,
      message.taskId ? `task=${JSON.stringify(message.taskId)}` : "",
      message.priority ? `priority=${JSON.stringify(message.priority)}` : ""
    ].filter(Boolean).join(" ");
    return `<agent_message ${attributes}>\n${message.body}\n</agent_message>`;
  }).join("\n\n");
}

export async function waitForAgentMessages(root, agentId, options = {}) {
  const timeoutMs = Math.max(Number(options.timeoutMs) || 0, 0);
  const pollMs = Math.min(Math.max(Number(options.pollMs) || 500, 50), 30000);
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() <= deadline) {
    const messages = await readAgentInbox(root, agentId, { max: options.max || 100 });
    if (messages.length) return { timedOut: false, messages };
    if (options.signal?.aborted) throw options.signal.reason || new Error("agent wait aborted");
    if (Date.now() + pollMs > deadline) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  return { timedOut: true, messages: [] };
}

export async function createTask(root, input = {}) {
  const p = await initializeCoordination(root);
  const taskId = validateTaskId(input.taskId);
  const title = String(input.title || input.description || taskId).trim();
  if (!title) throw new Error("task title must be non-empty.");
  const file = join(p.tasks, `${taskId}.json`);
  try {
    await stat(file);
    throw new Error(`task '${taskId}' already exists.`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const task = {
    schemaVersion: 1,
    taskId,
    title,
    description: String(input.description || ""),
    scope: Array.isArray(input.scope) ? input.scope.map(String) : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map(String) : [],
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map(validateTaskId) : [],
    createdBy: validateAgentId(input.createdBy),
    status: "open",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await appendEvent(root, "task_created", { taskId, createdBy: task.createdBy });
  return task;
}

export async function listTasks(root) {
  const p = await initializeCoordination(root);
  const entries = await readdir(p.tasks, { withFileTypes: true });
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const task = await readJson(join(p.tasks, entry.name));
      let claim = null;
      try { claim = await readJson(join(p.claims, `${task.taskId}.json`)); } catch {}
      tasks.push({ ...task, claim });
    } catch {}
  }
  return tasks.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
}

export async function claimTask(root, input = {}) {
  const p = await initializeCoordination(root);
  const taskId = validateTaskId(input.taskId);
  const agentId = validateAgentId(input.agentId);
  await stat(join(p.tasks, `${taskId}.json`));
  const leaseSeconds = Math.min(Math.max(Number(input.leaseSeconds) || 1800, 30), 86400);
  const claim = {
    schemaVersion: 1,
    taskId,
    agentId,
    claimedAt: nowIso(),
    leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString()
  };
  const file = join(p.claims, `${taskId}.json`);
  try {
    const handle = await open(file, "wx");
    try { await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(file);
    if (existing.agentId === agentId) return existing;
    const expiresAt = Date.parse(existing.leaseExpiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      const expiredFile = join(p.claims, `${taskId}.expired-${Date.now()}-${randomUUID()}.json`);
      try {
        await rename(file, expiredFile);
        await appendEvent(root, "task_claim_expired", { taskId, previousAgentId: existing.agentId, leaseExpiresAt: existing.leaseExpiresAt });
      } catch (renameError) {
        if (!isMissing(renameError)) throw renameError;
      }
      return claimTask(root, input);
    }
    throw new Error(`task '${taskId}' is already claimed by '${existing.agentId}' until ${existing.leaseExpiresAt}.`);
  }
  await appendEvent(root, "task_claimed", { taskId, agentId, leaseExpiresAt: claim.leaseExpiresAt });
  return claim;
}

export async function completeTask(root, input = {}) {
  const p = await initializeCoordination(root);
  const taskId = validateTaskId(input.taskId);
  const agentId = validateAgentId(input.agentId);
  const taskFile = join(p.tasks, `${taskId}.json`);
  const task = await readJson(taskFile);
  let claim;
  try { claim = await readJson(join(p.claims, `${taskId}.json`)); }
  catch (error) { if (isMissing(error)) throw new Error(`task '${taskId}' is not claimed.`); throw error; }
  if (claim.agentId !== agentId) throw new Error(`task '${taskId}' is claimed by '${claim.agentId}', not '${agentId}'.`);
  const completed = {
    ...task,
    status: String(input.status || "ready_for_review"),
    result: String(input.summary || ""),
    completedBy: agentId,
    updatedAt: nowIso()
  };
  await writeJsonAtomic(taskFile, completed);
  await appendEvent(root, "task_handoff", { taskId, agentId, status: completed.status });
  return completed;
}
