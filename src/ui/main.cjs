const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require("electron");
const { createServer } = require("node:http");
const { mkdir, readdir, readFile, rename, unlink, writeFile } = require("node:fs/promises");
const { dirname, join, relative, resolve, sep, isAbsolute } = require("node:path");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { homedir } = require("node:os");
const { usageTotals, buildDashboardModel } = require("./dashboard-model.cjs");

const { reviewSessionFiles } = require("./file-review.cjs");
const { createProjectStore, pathKey } = require("./projects.cjs");
const { createMessageRouter } = require("./message-router.cjs");

const workspace = process.env.DEEPSEEK_UI_WORKSPACE || process.cwd();
const bundledCli = resolve(dirname(process.execPath), "d.exe");
const cliExe = process.env.DEEPSEEK_UI_CLI_EXE || (existsSync(bundledCli) ? bundledCli : "d");
const cliScript = process.env.DEEPSEEK_UI_CLI_SCRIPT || "";
const controlPort = Number.parseInt(process.env.DEEPSEEK_UI_PORT || "17891", 10);
const cdpPort = Number.parseInt(process.env.DEEPSEEK_UI_CDP_PORT || "9223", 10);
if (process.env.SWITCHYARD_UI_DEBUG === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
const runs = new Map();
const dataRoot = resolve(process.env.SWITCHYARD_DATA_DIR || join(homedir(), ".switchyard"));
const sessionDir = resolve(dataRoot, "sessions");
const projectStore = createProjectStore(dataRoot);
const dispatchChat = createMessageRouter(dataRoot, async input => safeRun(await startRun(input)));
const workspaceKey = createHash("sha256").update(resolve(workspace).toLowerCase()).digest("hex").slice(0, 16);
const coordRoot = resolve(process.env.DEEPSEEK_UI_COORD_DIR || join(dataRoot, "coordination", "workspaces", workspaceKey));
let activeCoordRoot = coordRoot;

// agent-coordination.js is ESM; load it lazily from CJS via dynamic import.
function coordinationApi() {
  return import("../agent-coordination.js");
}

function supportPromptApi() {
  return Promise.all([import("../support-prompt.js"), import("../config.js")]);
}

function coordinationError(error) {
  return { error: error && error.message ? error.message : String(error) };
}

let mainWindow = null;
let server = null;
let uiRuntime = null;
let dashboardCache = null;
let dashboardCacheAt = 0;
let pricingApiPromise = null;
let focusOnReady = false;

async function registerUiAgent() {
  try {
    const api = await coordinationApi();
    uiRuntime = await api.createAgentRuntime(activeCoordRoot, {
      agentId: "ui",
      role: "operator",
      state: "working",
      mission: "Operator desktop UI - send messages here to wake agents; replies land in this inbox.",
      workspace,
      heartbeatMs: 30000
    });
    return true;
  } catch (error) {
    if (String(error && error.message).includes("already active")) return true; // another TUI instance is attached
    console.error("[ui] could not register agent 'ui':", error && error.message ? error.message : error);
    return false;
  }
}

async function unregisterUiAgent() {
  try {
    if (uiRuntime) await uiRuntime.stop("stopped");
  } catch { /* best effort */ }
}

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readRequestJson(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("error", reject);
    req.on("end", () => {
      if (!body.trim()) return resolvePromise({});
      try { resolvePromise(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
  });
}

function compactText(value, max = 1200) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n...`;
}

function firstUserPrompt(session) {
  return session.messages?.find((message) => message.role === "user")?.content || "";
}

function sessionTitle(session, file) {
  if (String(session.title || "").trim()) return compactText(session.title, 80);
  const content = firstUserPrompt(session);
  const prompt = (Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text || "").join(" ") : String(content || "")).replace(/\s+/g, " ").trim();
  return prompt ? compactText(prompt, 80) : file.split(/[\\/]/).pop();
}

async function readSessionFile(file) {
  return JSON.parse(await readFile(resolve(file), "utf8"));
}

async function listSessionSummaries() {
  const pricingApi = await (pricingApiPromise ||= Promise.all([import("../model-pricing.js"), import("../providers.js")]));
  const [pricing, providers] = pricingApi;
  let names = [];
  try {
    names = await readdir(sessionDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const sessions = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = join(sessionDir, name);
    try {
      const session = await readSessionFile(file);
      const provider = session.provider || session.config?.provider || "";
      const priceLookup = (name, model, usage) => {
        const config = providers.providerConfig(name);
        const base = String(config.baseUrl || "").replace(/\/+$/, "").toLowerCase();
        const configured = String(session.baseUrl || "").replace(/\/+$/, "").toLowerCase();
        if (configured && base && configured !== base) return null;
        return pricing.modelPrice(name, model, usage);
      };
      const economics = usageTotals(session, priceLookup);
      sessions.push({
        path: file,
        title: sessionTitle(session, file),
        createdAt: session.createdAt || "",
        updatedAt: session.updatedAt || session.createdAt || "",
        provider,
        model: session.model || "",
        backend: session.config?.backend || "api",
        workspace: session.workspace || "",
        coordDir: session.config?.coordDir || "",
        agentId: session.config?.agentId || "",
        coordinatorId: session.config?.coordinatorId || "",
        agentRole: session.config?.agentRole || "",
        displayName: session.config?.agentName || "",
        permission: session.config?.permission || "ask",
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
        touchedFiles: session.touchedFiles || [],
        ...economics
      });
    } catch {
      // Ignore malformed sessions in the UI picker.
    }
  }
  const api = await coordinationApi();
  const roots = [...new Set(sessions.map(session => session.coordDir).filter(Boolean))];
  const agentGroups = new Map(await Promise.all(roots.map(async root => {
    if (!isAbsolute(root) || !existsSync(root)) return [root, []];
    try { return [root, await api.listAgents(root, { includeStopped: true })]; }
    catch { return [root, []]; }
  })));
  for (const session of sessions) {
    const agent = agentGroups.get(session.coordDir)?.find(agent => agent.agentId === session.agentId);
    session.active = Boolean(agent?.live && (!agent.session || pathKey(agent.session) === pathKey(session.path)));
    session.agentState = agent?.live ? agent.state : "stopped";
  }
  return sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function formatToolCalls(calls) {
  return (calls || []).map((call) => ({
    id: call.id || "",
    name: call.function?.name || "tool",
    arguments: compactText(call.function?.arguments || "{}", 4000)
  }));
}

function formatSessionMessages(session) {
  return (session.messages || [])
    .filter((message) => message.role !== "system")
    .map((message, index) => ({
      index,
      role: message.role || "message",
      content: compactText(message.content || "", message.role === "tool" ? 2200 : 200000),
      reasoning: compactText(message.reasoning_content || "", 1800),
      toolCallId: message.tool_call_id || "",
      toolCalls: formatToolCalls(message.tool_calls)
    }));
}

async function safeSession(path) {
  const session = await readSessionFile(path);
  const api = await coordinationApi();
  const root = session.config?.coordDir;
  const agent = root && existsSync(root) ? (await api.listAgents(root, { includeStopped: true })).find(item => item.agentId === session.config?.agentId && (!item.session || pathKey(item.session) === pathKey(path))) : null;
  return {
    path,
    title: sessionTitle(session, path),
    createdAt: session.createdAt || "",
    updatedAt: session.updatedAt || session.createdAt || "",
    provider: session.provider || session.config?.provider || "",
    model: session.model || "",
    backend: session.config?.backend || "api",
    permission: session.config?.permission || "ask",
    agentRole: session.config?.agentRole || "worker",
    coordinationAgentId: session.config?.agentId || "",
    coordDir: session.config?.coordDir || "",
    workspace: session.workspace || "",
    coordinatorId: session.config?.coordinatorId || "",
    active: Boolean(agent?.live),
    agentState: agent?.live ? agent.state : "stopped",
    coordinationMessages: root && session.config?.agentId && existsSync(root) ? await api.listAgentMessages(root, session.config.agentId) : [],
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    touchedFiles: session.touchedFiles || [],
    messages: formatSessionMessages(session)
  };
}

async function dashboardSnapshot(force = false) {
  if (!force && dashboardCache && Date.now() - dashboardCacheAt < 5000) return dashboardCache;
  const [sessions, agentResult, eventResult] = await Promise.all([
    listSessionSummaries(),
    coordinationApi().then(api => api.listAgents(activeCoordRoot, { includeStopped: true })).then(agents => ({ agents }), error => ({ agents: [], error: error.message })),
    coordinationApi().then(api => api.listCoordinationEvents(activeCoordRoot, { max: 500 })).catch(error => ({ total: 0, events: [], error: error.message }))
  ]);
  const agents = (agentResult.agents || []).map(agent => {
    const session = sessions.find(item => item.agentId === agent.agentId || (agent.session && resolve(agent.session) === item.path));
    return {
      ...agent,
      displayName: agent.displayName || session?.displayName || agent.agentId,
      coordinatorId: agent.coordinatorId || session?.coordinatorId || null,
      provider: session?.provider || (session?.backend === "codex" ? "Codex" : session?.backend === "claude" ? "Claude" : ""),
      model: session?.model || "",
      permission: session?.permission || "",
      sessionTitle: session?.title || "",
      sessionPath: session?.path || agent.session || "",
      tokenCount: session ? session.inputTokens + session.outputTokens : 0
    };
  });
  const result = buildDashboardModel({
    sessions,
    agents,
    events: eventResult.events || [],
    eventTotal: eventResult.total || 0,
    eventsToday: eventResult.todayTotal,
    runs: [...runs.values()].map(safeRun),
    now: new Date()
  });
  result.health = {
    dataRoot,
    sessionRoot: sessionDir,
    coordinationRoot: activeCoordRoot,
    workspace,
    activeRuns: [...runs.values()].filter(run => run.status === "running").length,
    coordinationAvailable: !agentResult.error && !eventResult.error,
    coordinationError: agentResult.error || eventResult.error || ""
  };
  dashboardCache = result;
  dashboardCacheAt = Date.now();
  return result;
}

async function renameSavedSession(path, requestedTitle) {
  const file = resolve(path);
  const rel = relative(sessionDir, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.toLowerCase().endsWith(".json")) {
    throw new Error("Session must be a saved Switchyard session.");
  }
  const title = String(requestedTitle || "").replace(/\s+/g, " ").trim().slice(0, 64).trim();
  if (!title) throw new Error("Chat title must contain at least one non-space character.");
  const session = await readSessionFile(file);
  session.title = title;
  session.titleSource = "user";
  session.titleSetAt = new Date().toISOString();
  session.config ||= {};
  session.config.chatNamingPending = false;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return safeSession(file);
}

async function setActiveCoordinationRoot(path) {
  const next = resolve(path || coordRoot);
  if (next === activeCoordRoot) return;
  await unregisterUiAgent();
  activeCoordRoot = next;
  dashboardCacheAt = 0;
  await registerUiAgent();
}

function newUiSessionPath(id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(sessionDir, `${stamp}-${process.pid}-${id.slice(0, 8)}.json`);
}

function cliCommandArgs(promptFile, outputFile, permission, sessionPath, resume, connection = {}, model = "", effort = "high", agentRole = "worker", project = {}) {
  const args = [];
  if (cliScript) args.push(cliScript);
  if (connection.backend && connection.backend !== "api") args.push("--backend", connection.backend);
  if (connection.backend === "api" && connection.provider) args.push("--provider", connection.provider);
  if (model) args.push("--model", model);
  if (connection.backend === "api" && effort) args.push("--effort", effort);
  args.push("--agent-role", agentRole);
  if (project.coordDir) args.push("--coord-dir", project.coordDir);
  if (project.agentId) args.push("--agent-id", project.agentId);
  if (project.coordinatorId) args.push("--coordinator-id", project.coordinatorId);
  if (sessionPath) args.push("--session", sessionPath);
  if (resume) args.push("--resume");
  args.push(
    "--prompt-file", promptFile,
    "--outfile", outputFile,
    "--ui-stream",
    "--permission", permission || "review"
  );
  return args;
}

function parseOutput(markdown) {
  const finalMatch = markdown.match(/## Final Response\s+([\s\S]*?)(?:\n## Files Touched|\s*$)/);
  const filesMatch = markdown.match(/## Files Touched\s+([\s\S]*?)\s*$/);
  const finalResponse = finalMatch ? finalMatch[1].trim() : markdown.trim();
  const touchedFiles = filesMatch
    ? filesMatch[1].split(/\r?\n/).map((line) => line.replace(/^-\s*/, "").trim()).filter((line) => line && line !== "None")
    : [];
  return { finalResponse, touchedFiles, markdown };
}

const UI_IMAGE_MIME_EXTENSIONS = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"]]);
const UI_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function validateUiImage(image) {
  const match = typeof image?.dataUrl === "string" && image.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match) throw new Error("Pasted image must be PNG, JPEG, WebP, or GIF.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > UI_IMAGE_MAX_BYTES) throw new Error("Each pasted image must be smaller than 8 MB.");
  return { mimeType: match[1], bytes, extension: UI_IMAGE_MIME_EXTENSIONS.get(match[1]) };
}

async function discoverUiModels(connectionId) {
  const { CONNECTIONS, discoverModels } = await import("../connection-picker.js");
  const connection = CONNECTIONS.find(item => item.id === connectionId);
  if (!connection) throw new Error("Choose a valid connection.");
  const backend = ["codex", "claude"].includes(connection.id) ? connection.id : "api";
  const provider = backend === "api" ? connection.id : undefined;
  const models = await discoverModels({ backend, provider, model: "" });
  const pricing = await import("../model-pricing.js");
  const choices = pricing.priceModelChoices(models, { backend, provider });
  return { connection, backend, provider, models: choices };
}

async function startRun({ prompt, permission = "review", effort = "high", agentRole, sessionPath = "", backend = "api", provider = "deepseek", model = "", images = [], projectId, requestId, newSession = false }) {
  images = Array.isArray(images) ? images : [];
  if ((!prompt || typeof prompt !== "string") && !images.length) throw new Error("Enter a message or attach an image.");
  if (!["review", "full", "yolo"].includes(permission)) throw new Error("permission must be review, full, or yolo.");
  if (!["api", "codex", "claude"].includes(backend)) throw new Error("Choose a supported connection.");
  if (images.length > 8) throw new Error("Attach up to 8 images per message.");

  const id = randomUUID();
  const targetSession = sessionPath || newUiSessionPath(id);
  const resume = Boolean(sessionPath && existsSync(sessionPath));
  let initialSession = null;
  if (resume) {
    initialSession = await safeSession(targetSession);
  }
  if (!resume && !newSession) throw new Error('The selected session is unavailable.');
  const project = initialSession?.workspace
    ? { workspace: initialSession.workspace, coordDir: initialSession.coordDir || join(dataRoot, 'coordination', 'workspaces', createHash('sha256').update(resolve(initialSession.workspace).toLowerCase()).digest('hex').slice(0, 16)) }
    : await projectStore.get(projectId);
  if (!existsSync(project.workspace)) throw new Error('The project working directory is unavailable.');
  if (initialSession) {
    backend = initialSession.backend;
    provider = initialSession.provider;
    model = initialSession.model;
    agentRole = initialSession.agentRole;
  }
  agentRole = agentRole || initialSession?.agentRole || "worker";
  if (!["worker", "coordinator"].includes(agentRole)) throw new Error("Agent role must be worker or coordinator.");
  if (agentRole === "coordinator" && backend !== "api") throw new Error("Coordinator role is available only for Switchyard API sessions.");
  const dir = resolve(dataRoot, "ui", requestId || id);
  await mkdir(dir, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  const outputFile = join(dir, "result.md");
  const imagePaths = [];
  for (const [index, image] of images.entries()) {
    const validated = validateUiImage(image);
    const path = join(dir, "attachments", `image-${index + 1}.${validated.extension}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, validated.bytes);
    imagePaths.push(path);
  }
  const imageInstructions = imagePaths.length
    ? `\n\n[The user attached ${imagePaths.length} image${imagePaths.length === 1 ? "" : "s"}. Inspect each with the available image tool before answering (view_image for native vision, or analyze_image_openai when native vision is unavailable). Attached image paths:\n${imagePaths.map(path => `- ${path}`).join("\n")}]`
    : "";
  await writeFile(promptFile, `${String(prompt || "").trim()}${imageInstructions}`, "utf8");

  const api = await coordinationApi();
  const registered = await api.listAgents(project.coordDir, { includeStopped: true });
  const existing = registered.find(agent => pathKey(agent.session) === pathKey(targetSession));
  const ownedRun = [...runs.values()].find(run => pathKey(run.sessionPath) === pathKey(targetSession) && run.status === 'running');
  if (newSession && resume) return { ...(ownedRun || { id, sessionPath: targetSession, status: existing?.live ? 'running' : 'complete', session: initialSession }), delivery: { id: requestId, state: 'received' } };
  // A freshly launched process may not have registered yet. Never launch a
  // second owner during that interval; retry the same message ID after startup.
  if (ownedRun && !existing?.live) throw new Error('The agent is starting. Retry this message in a moment.');
  if (existing?.processAlive && !existing.live && !['completed', 'stopped', 'failed'].includes(existing.state)) throw new Error('The agent heartbeat is stale but its process still exists. Wait for it to recover before retrying.');
  if (existing && backend === 'api') {
    const body = `${String(prompt || '').trim()}${imageInstructions}`;
    const message = await api.sendAgentMessage(project.coordDir, { id: requestId, from: 'ui', to: existing.agentId, body });
    if (existing.coordinatorId && registered.some(agent => agent.agentId === existing.coordinatorId)) {
      await api.sendAgentMessage(project.coordDir, { id: `${requestId}-notice`, from: 'ui', to: existing.coordinatorId, type: 'status', body: `The user sent a direct instruction to worker ${existing.agentId}. This is informational; do not duplicate its task.\n${body}` });
    }
    if (existing.live) {
      return { ...(ownedRun || { id: `agent-${createHash('sha256').update(pathKey(targetSession)).digest('hex').slice(0, 16)}`, sessionPath: targetSession, status: 'running', workspace: project.workspace, coordDir: project.coordDir, backend, provider, model, agentRole, stdout: '', stderr: '', session: initialSession }), delivery: { id: message.id, state: 'queued' } };
    }
    // Resume from the durable inbox instead of appending the user prompt twice.
    await writeFile(promptFile, 'Read the pending user message in your coordination inbox and continue your mission.', 'utf8');
  } else if (ownedRun) {
    throw new Error('This native session is already running. Send your next message when it finishes.');
  }

  const run = {
    id,
    prompt,
    permission,
    agentRole,
    backend,
    coordDir: project.coordDir,
    workspace: project.workspace,
    provider: backend === "api" ? provider : "",
    model,
    sessionPath: targetSession,
    messageCountBefore: initialSession?.messages?.length || 0,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputFile,
    promptFile,
    stdout: "",
    stderr: "",
    exitCode: null,
    finalResponse: "",
    delivery: { id: requestId, state: existing ? 'queued' : 'received' },
    touchedFiles: [],
    session: initialSession,
    liveText: "",
    prompt: existing ? '' : String(prompt || "").trim()
  };
  runs.set(id, run);
  emitRuns();

  const args = cliCommandArgs(promptFile, outputFile, permission, targetSession, resume, { backend, provider }, model, effort, agentRole, { ...project, agentId: existing?.agentId, coordinatorId: existing?.coordinatorId });
  const child = spawn(cliExe, args, {
    cwd: project.workspace,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += chunk;
    run.liveText += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  const launched = new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  let refreshingSession = false;
  const sessionRefresh = setInterval(async () => {
    if (refreshingSession || run.status !== "running") return;
    refreshingSession = true;
    try {
      const session = await safeSession(targetSession);
      run.session = session;
      run.touchedFiles = session.touchedFiles || run.touchedFiles;
      const lastAssistant = [...(session.messages || [])].reverse().find(message => message.role === "assistant");
      if (lastAssistant && run.liveText && String(lastAssistant.content || "") === run.liveText) run.liveText = "";
      run.updatedAt = session.updatedAt || new Date().toISOString();
      emitRun(run);
    } catch { /* the session may not exist yet or be between atomic replacements */ }
    finally { refreshingSession = false; }
  }, 300);
  sessionRefresh.unref?.();
  child.on("error", (error) => {
    clearInterval(sessionRefresh);
    run.status = "error";
    run.stderr += `\n${error.message}`;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.on("close", async (code) => {
    clearInterval(sessionRefresh);
    run.exitCode = code;
    run.status = code === 0 ? "complete" : "error";
    try {
      Object.assign(run, parseOutput(await readFile(outputFile, "utf8")));
      run.session = await safeSession(targetSession);
      run.touchedFiles = run.session.touchedFiles || run.touchedFiles;
      run.liveText = "";
    } catch (error) {
      if (code === 0) run.status = "error";
      run.stderr += `\nCould not read output file: ${error.message}`;
    }
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });

  await launched;
  return run;
}

function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    delivery: run.delivery,
    permission: run.permission,
    agentRole: run.agentRole || "worker",
    coordDir: run.coordDir,
    workspace: run.workspace,
    provider: run.provider,
    model: run.model,
    status: run.status,
    sessionPath: run.sessionPath,
    messageCountBefore: run.messageCountBefore || 0,
    session: run.session,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outputFile: run.outputFile,
    exitCode: run.exitCode,
    finalResponse: run.finalResponse,
    prompt: run.prompt,
    liveText: run.liveText,
    touchedFiles: run.touchedFiles,
    stdoutTail: (run.stdout || '').slice(-4000),
    stderrTail: (run.stderr || '').slice(-4000)
  };
}

function emitRuns() {
  dashboardCacheAt = 0;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runs:update", Array.from(runs.values()).map(safeRun));
  }
}

function emitRun(run) {
  dashboardCacheAt = 0;
  emitRuns();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("run:update", safeRun(run));
}

function startControlServer() {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${controlPort}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          workspace,
          controlPort,
          cdpPort,
          runs: runs.size
        });
      }
      if (req.method === "GET" && url.pathname === "/dashboard") {
        return json(res, 200, await dashboardSnapshot());
      }
      if (req.method === "GET" && url.pathname === "/sessions") {
        return json(res, 200, await listSessionSummaries());
      }
      if (req.method === "GET" && url.pathname === "/connections") {
        const { CONNECTIONS } = await import("../connection-picker.js");
        return json(res, 200, CONNECTIONS);
      }
      if (req.method === "GET" && url.pathname === "/models") {
        const connectionId = url.searchParams.get("connection") || "";
        const result = await discoverUiModels(connectionId);
        return json(res, 200, result);
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (req.method === "GET" && sessionMatch) {
        const file = decodeURIComponent(sessionMatch[1]);
        return json(res, 200, await safeSession(file));
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readRequestJson(req);
        return json(res, 202, await dispatchChat(body));
      }
      const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
      if (req.method === "GET" && runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) return json(res, 404, { error: "run not found" });
        return json(res, 200, safeRun(run));
      }
      if (req.method === "GET" && url.pathname === "/runs") {
        return json(res, 200, Array.from(runs.values()).map(safeRun));
      }
      if (req.method === "GET" && url.pathname === "/agents") {
        const api = await coordinationApi();
        return json(res, 200, await api.listAgents(activeCoordRoot, { includeStopped: true }));
      }
      if (req.method === "GET" && url.pathname === "/agents/live") {
        const api = await coordinationApi();
        return json(res, 200, await api.listAgents(activeCoordRoot, { includeStopped: false }));
      }
      const inboxMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox$/);
      if (req.method === "GET" && inboxMatch) {
        const api = await coordinationApi();
        return json(res, 200, await api.readAgentInbox(activeCoordRoot, decodeURIComponent(inboxMatch[1])));
      }
      if (req.method === "POST" && url.pathname === "/agents/send") {
        const api = await coordinationApi();
        const body = await readRequestJson(req);
        const message = await api.sendAgentMessage(activeCoordRoot, {
          from: String(body.from || "ui"),
          to: body.to,
          body: body.body,
          type: body.type || "message",
          priority: body.priority || "normal",
          taskId: body.taskId,
          replyTo: body.replyTo
        });
        return json(res, 201, message);
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  server.listen(controlPort, "127.0.0.1");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1c1e2b", symbolColor: "#c9cbd4", height: 40 },
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    ...(existsSync(resolve(__dirname, "..", "..", "icon.png")) ? { icon: resolve(__dirname, "..", "..", "icon.png") } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", event => event.preventDefault());
  mainWindow.loadFile(join(__dirname, "index.html"));
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    focusOnReady = true;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

function forwardPackagedCliArguments() {
  const appRoot = resolve(process.resourcesPath || "", "app");
  if (!existsSync(join(appRoot, "package.json"))) return false;
  const args = process.argv.slice(1).filter(value => resolve(value) !== appRoot);
  if (!args.length) return false;
  const cli = resolve(dirname(process.execPath), "d.exe");
  if (!existsSync(cli)) {
    console.error("Switchyard terminal command is missing its bundled d.exe.");
    app.exit(1);
    return true;
  }
  const child = spawn(cli, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: false });
  child.on("error", error => {
    console.error(`Could not start the Switchyard CLI: ${error.message}`);
    app.exit(1);
  });
  child.on("exit", code => app.exit(code ?? 0));
  return true;
}

ipcMain.handle("app:info", () => ({ workspace, controlPort, cdpPort, coordRoot: activeCoordRoot, dataRoot }));
ipcMain.handle("app:menu", (event, input = {}) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (input.menu === 'all') {
    Menu.getApplicationMenu()?.popup({ window: mainWindow, x: 12, y: 40 });
    return;
  }
  const labels = { file: "file", edit: "edit", view: "view", window: "window", help: "help" };
  const label = labels[input.menu];
  if (!label) return;
  const item = Menu.getApplicationMenu()?.items.find(item => item.label.replace(/&/g, "").toLowerCase() === label);
  if (!item?.submenu) return;
  const [width, height] = mainWindow.getContentSize();
  const x = Math.min(width, Math.max(0, Math.round(Number(input.x) || 0)));
  const y = Math.min(height, Math.max(0, Math.round(Number(input.y) || 40)));
  item.submenu.popup({ window: mainWindow, x, y });
});
ipcMain.handle("connections:list", async () => {
  const { CONNECTIONS } = await import("../connection-picker.js");
  return CONNECTIONS;
});
ipcMain.handle("models:list", async (_event, connectionId) => discoverUiModels(String(connectionId || "")));
ipcMain.handle("dashboard:summary", () => dashboardSnapshot());
ipcMain.handle("dashboard:refresh", () => dashboardSnapshot(true));
ipcMain.handle("support:status", async () => {
  const [support, configApi] = await supportPromptApi();
  const config = await configApi.readConfig();
  return { due: support.shouldPromptForPersonalSupport(config.personalSupportPrompt), url: support.PERSONAL_SUPPORT_URL };
});
ipcMain.handle("support:respond", async (_event, choice) => {
  const [support, configApi] = await supportPromptApi();
  const config = await configApi.readConfig();
  config.personalSupportPrompt = support.personalSupportResponse(choice);
  await configApi.writeConfig(config);
  if (choice === "open") await shell.openExternal(support.PERSONAL_SUPPORT_URL);
  return { ok: true };
});
ipcMain.handle("files:review", async (_event, sessionPath) => {
  const session = await readSessionFile(sessionPath);
  return reviewSessionFiles({ ...session, workspace: session.workspace || workspace });
});
ipcMain.handle("app:open-link", async (_event, value) => {
  const url = new URL(String(value));
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only web links can be opened here.");
  await shell.openExternal(url.href);
});
ipcMain.handle("runs:list", () => Array.from(runs.values()).map(safeRun));
ipcMain.handle("chat:start", async (_event, input) => dispatchChat(input || {}));
ipcMain.handle('projects:list', async () => projectStore.importSessions(await listSessionSummaries()));
ipcMain.handle('projects:create', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a project working directory', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : projectStore.add(result.filePaths[0]);
});
ipcMain.handle('projects:select', async (_event, id) => {
  const project = await projectStore.get(id);
  await setActiveCoordinationRoot(project.coordDir);
  return project;
});
ipcMain.handle("sessions:list", () => listSessionSummaries());
ipcMain.handle("sessions:read", (_event, path) => safeSession(path));
ipcMain.handle("sessions:rename", (_event, input) => renameSavedSession(input?.path, input?.title));
ipcMain.handle("agents:list", async (_event, options) => {
  try {
    const api = await coordinationApi();
    return { ok: true, agents: await api.listAgents(activeCoordRoot, { includeStopped: Boolean(options?.includeStopped) }) };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});
ipcMain.handle("agents:send", async (_event, input) => {
  try {
    const api = await coordinationApi();
    const message = await api.sendAgentMessage(activeCoordRoot, {
      from: String(input?.from || "ui"),
      to: input?.to,
      body: input?.body,
      type: input?.type || "message",
      priority: input?.priority || "normal",
      taskId: input?.taskId,
      replyTo: input?.replyTo
    });
    return { ok: true, message };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});
ipcMain.handle("agents:inbox", async (_event, agentId) => {
  try {
    const api = await coordinationApi();
    return { ok: true, messages: await api.readAgentInbox(activeCoordRoot, String(agentId || "ui"), { max: 50 }) };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});
ipcMain.handle("agents:messages", async (_event, agentId) => {
  try {
    const api = await coordinationApi();
    return { ok: true, messages: await api.listAgentMessages(activeCoordRoot, String(agentId || "ui"), { max: 300 }) };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});

if (!forwardPackagedCliArguments()) {
  const hasInstanceLock = app.requestSingleInstanceLock();
  if (!hasInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", focusMainWindow);
    app.whenReady().then(() => {
      app.setAppUserModelId("com.gaston1799.switchyard");
      startControlServer();
      registerUiAgent();
      createWindow();
      if (focusOnReady) focusMainWindow();
    });
  }
}

app.on("window-all-closed", () => {
  if (server) server.close();
  unregisterUiAgent();
  if (process.platform !== "darwin") app.quit();
});
