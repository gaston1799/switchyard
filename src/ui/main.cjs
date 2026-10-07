const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { createServer } = require("node:http");
const { mkdir, readdir, readFile, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const workspace = process.env.DEEPSEEK_UI_WORKSPACE || process.cwd();
const cliExe = process.env.DEEPSEEK_UI_CLI_EXE || "d";
const cliScript = process.env.DEEPSEEK_UI_CLI_SCRIPT || "";
const controlPort = Number.parseInt(process.env.DEEPSEEK_UI_PORT || "17891", 10);
const cdpPort = Number.parseInt(process.env.DEEPSEEK_UI_CDP_PORT || "9223", 10);
const runs = new Map();
const sessionDir = resolve(workspace, ".deepseek-watch", "sessions");
const coordRoot = resolve(process.env.DEEPSEEK_UI_COORD_DIR || join(workspace, ".deepseek-watch", "coordination"));

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

async function registerUiAgent() {
  try {
    const api = await coordinationApi();
    uiRuntime = await api.createAgentRuntime(coordRoot, {
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
  const prompt = firstUserPrompt(session).replace(/\s+/g, " ").trim();
  return prompt ? compactText(prompt, 80) : file.split(/[\\/]/).pop();
}

async function readSessionFile(file) {
  return JSON.parse(await readFile(resolve(file), "utf8"));
}

async function listSessionSummaries() {
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
      sessions.push({
        path: file,
        title: sessionTitle(session, file),
        createdAt: session.createdAt || "",
        updatedAt: session.updatedAt || session.createdAt || "",
        permission: session.config?.permission || "ask",
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
        touchedFiles: session.touchedFiles || []
      });
    } catch {
      // Ignore malformed sessions in the UI picker.
    }
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
      content: compactText(message.content || "", message.role === "tool" ? 2200 : 4000),
      reasoning: compactText(message.reasoning_content || "", 1800),
      toolCallId: message.tool_call_id || "",
      toolCalls: formatToolCalls(message.tool_calls)
    }));
}

async function safeSession(path) {
  const session = await readSessionFile(path);
  return {
    path,
    title: sessionTitle(session, path),
    createdAt: session.createdAt || "",
    updatedAt: session.updatedAt || session.createdAt || "",
    permission: session.config?.permission || "ask",
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    touchedFiles: session.touchedFiles || [],
    messages: formatSessionMessages(session)
  };
}

function newUiSessionPath(id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(sessionDir, `${stamp}-${process.pid}-${id.slice(0, 8)}.json`);
}

function cliCommandArgs(promptFile, outputFile, permission, sessionPath, resume) {
  const args = [];
  if (cliScript) args.push(cliScript);
  if (sessionPath) args.push("--session", sessionPath);
  if (resume) args.push("--resume");
  args.push(
    "--prompt-file", promptFile,
    "--outfile", outputFile,
    "--no-output",
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

async function startRun({ prompt, permission = "review", sessionPath = "" }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required.");
  if (!["review", "full", "yolo"].includes(permission)) throw new Error("permission must be review, full, or yolo.");

  const id = randomUUID();
  const targetSession = sessionPath || newUiSessionPath(id);
  const resume = Boolean(sessionPath);
  const dir = resolve(workspace, ".deepseek-watch", "ui", id);
  await mkdir(dir, { recursive: true });
  const promptFile = join(dir, "prompt.md");
  const outputFile = join(dir, "result.md");
  await writeFile(promptFile, prompt, "utf8");

  const run = {
    id,
    prompt,
    permission,
    sessionPath: targetSession,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputFile,
    promptFile,
    stdout: "",
    stderr: "",
    exitCode: null,
    finalResponse: "",
    touchedFiles: [],
    session: null
  };
  runs.set(id, run);
  emitRuns();

  const args = cliCommandArgs(promptFile, outputFile, permission, targetSession, resume);
  const child = spawn(cliExe, args, {
    cwd: workspace,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    run.stdout += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.stderr.on("data", (chunk) => {
    run.stderr += chunk;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.on("error", (error) => {
    run.status = "error";
    run.stderr += `\n${error.message}`;
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });
  child.on("close", async (code) => {
    run.exitCode = code;
    run.status = code === 0 ? "complete" : "error";
    try {
      Object.assign(run, parseOutput(await readFile(outputFile, "utf8")));
      run.session = await safeSession(targetSession);
      run.touchedFiles = run.session.touchedFiles || run.touchedFiles;
    } catch (error) {
      if (code === 0) run.status = "error";
      run.stderr += `\nCould not read output file: ${error.message}`;
    }
    run.updatedAt = new Date().toISOString();
    emitRun(run);
  });

  return run;
}

function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    permission: run.permission,
    status: run.status,
    sessionPath: run.sessionPath,
    session: run.session,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outputFile: run.outputFile,
    exitCode: run.exitCode,
    finalResponse: run.finalResponse,
    touchedFiles: run.touchedFiles,
    stdoutTail: run.stdout.slice(-4000),
    stderrTail: run.stderr.slice(-4000)
  };
}

function emitRuns() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runs:update", Array.from(runs.values()).map(safeRun));
  }
}

function emitRun(run) {
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
      if (req.method === "GET" && url.pathname === "/sessions") {
        return json(res, 200, await listSessionSummaries());
      }
      const sessionMatch = url.pathname.match(/^\/sessions\/(.+)$/);
      if (req.method === "GET" && sessionMatch) {
        const file = decodeURIComponent(sessionMatch[1]);
        return json(res, 200, await safeSession(file));
      }
      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readRequestJson(req);
        const run = await startRun({ prompt: body.prompt, permission: body.permission || "review", sessionPath: body.sessionPath || "" });
        return json(res, 202, safeRun(run));
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
        return json(res, 200, await api.listAgents(coordRoot, { includeStopped: true }));
      }
      if (req.method === "GET" && url.pathname === "/agents/live") {
        const api = await coordinationApi();
        return json(res, 200, await api.listAgents(coordRoot, { includeStopped: false }));
      }
      const inboxMatch = url.pathname.match(/^\/agents\/([^/]+)\/inbox$/);
      if (req.method === "GET" && inboxMatch) {
        const api = await coordinationApi();
        return json(res, 200, await api.readAgentInbox(coordRoot, decodeURIComponent(inboxMatch[1])));
      }
      if (req.method === "POST" && url.pathname === "/agents/send") {
        const api = await coordinationApi();
        const body = await readRequestJson(req);
        const message = await api.sendAgentMessage(coordRoot, {
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
    backgroundColor: "#0f1115",
    ...(existsSync(resolve(__dirname, "..", "..", "icon.png")) ? { icon: resolve(__dirname, "..", "..", "icon.png") } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(join(__dirname, "index.html"));
}

ipcMain.handle("app:info", () => ({ workspace, controlPort, cdpPort, coordRoot }));
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
ipcMain.handle("runs:list", () => Array.from(runs.values()).map(safeRun));
ipcMain.handle("chat:start", async (_event, input) => safeRun(await startRun(input || {})));
ipcMain.handle("sessions:list", () => listSessionSummaries());
ipcMain.handle("sessions:read", (_event, path) => safeSession(path));
ipcMain.handle("agents:list", async (_event, options) => {
  try {
    const api = await coordinationApi();
    return { ok: true, agents: await api.listAgents(coordRoot, { includeStopped: Boolean(options?.includeStopped) }) };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});
ipcMain.handle("agents:send", async (_event, input) => {
  try {
    const api = await coordinationApi();
    const message = await api.sendAgentMessage(coordRoot, {
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
    return { ok: true, messages: await api.readAgentInbox(coordRoot, String(agentId || "ui"), { max: 50 }) };
  } catch (error) {
    return { ok: false, ...coordinationError(error) };
  }
});

app.whenReady().then(() => {
  startControlServer();
  registerUiAgent();
  createWindow();
});

app.on("window-all-closed", () => {
  if (server) server.close();
  unregisterUiAgent();
  if (process.platform !== "darwin") app.quit();
});
