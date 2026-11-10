// src/computer_tools.js - native Windows Computer Use toolpack.
//
// Backed by src/computer_use_helper/ComputerUseHelper.cs, compiled on demand into
// <switchyard-data>/bin/computer-use-helper-<hash>.exe and kept as a persistent
// JSON-line child process for the session. Persistence is what makes UI Automation
// element indexes valid between an observation and the action that follows it.
//
// Design rules:
//   - read-only tools (windows / ui_tree / observe / doctor) never prompt
//   - mutating tools (click / type / key / scroll / drag / set_value / invoke /
//     focus / launch) prompt unless the session is full/yolo or already auto-running
//   - coordinates are screen-absolute; capture reports origin + scale so image
//     pixels map back with screen = origin + round(image / scale)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { switchyardDataRoot } from "./data-store.js";
import { multimodalResult } from "./multimodal.js";
import { resolveWorkspacePath } from "./workspace-paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(HERE, "computer_use_helper");
const SOURCE = join(SOURCE_DIR, "ComputerUseHelper.cs");
const COMPILER = join(SOURCE_DIR, "compile.ps1");
const IDLE_MS = 10 * 60 * 1000;
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const SHOT_DIR = ".deepseek-watch/computer-use/shots";

let compiled = null;
let active = null;
let idleTimer = null;

// One process-level cleanup hook; per-spawn listeners would accumulate on restarts.
process.once("exit", () => {
  try { active?.child?.kill(); } catch { }
});

function runPowerShellFile(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut: false, stdout, stderr: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
  });
}

async function pruneOldBuilds(binDir, keep) {
  try {
    const entries = await readdir(binDir);
    for (const entry of entries) {
      if (!entry.startsWith("computer-use-helper-") || !entry.endsWith(".exe")) continue;
      const full = join(binDir, entry);
      if (full === keep) continue;
      await rm(full, { force: true }).catch(() => { });
    }
  } catch { }
}

async function ensureHelperBinary() {
  if (compiled) return compiled;
  compiled = (async () => {
    let source;
    try {
      source = await readFile(SOURCE, "utf8");
    } catch {
      throw new Error(`Computer Use helper source is missing: ${SOURCE}`);
    }
    const compiler = await readFile(COMPILER, "utf8").catch(() => "");
    const hash = createHash("sha256").update(source).update(compiler).digest("hex").slice(0, 12);
    const binDir = join(switchyardDataRoot(), "bin");
    const exe = join(binDir, `computer-use-helper-${hash}.exe`);
    if (existsSync(exe)) return exe;

    await mkdir(binDir, { recursive: true });
    const result = await runPowerShellFile(COMPILER, ["-Source", SOURCE, "-Output", exe], 240000);
    if (!existsSync(exe)) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 1200);
      throw new Error(
        `Computer Use helper could not be compiled${result.timedOut ? " (timed out)" : ""}. ` +
        `Needs Windows PowerShell 5.1 with .NET Framework 4.x reference assemblies. ${detail}`
      );
    }
    await pruneOldBuilds(binDir, exe);
    return exe;
  })().catch((error) => {
    compiled = null;
    throw error;
  });
  return compiled;
}

function failPending(helper, error) {
  if (!helper) return;
  for (const [, entry] of helper.pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  helper.pending.clear();
}

function resetHelper(reason) {
  const helper = active;
  active = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!helper) return;
  failPending(helper, new Error(`computer-use helper restarted: ${reason}`));
  try { helper.child.kill(); } catch { }
}

function onLine(helper, line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); }
  catch {
    helper.stderr = `${helper.stderr}\n[invalid helper output] ${text.slice(0, 300)}`;
    return;
  }
  const entry = helper.pending.get(message.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  helper.pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || "computer-use helper request failed"));
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => resetHelper("idle timeout"), IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

async function getHelper() {
  if (active) return active;
  const exe = await ensureHelperBinary();
  const child = spawn(exe, ["--parent-pid", String(process.pid)], {
    // Must stay false: CREATE_NO_WINDOW (windowsHide) leaves the helper unable to
    // route injected input even when its window reports as foreground. The helper is
    // built as a GUI-subsystem exe, so there is no console window to hide.
    windowsHide: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const helper = { child, pending: new Map(), buffer: "", nextId: 0, stderr: "", exe };
  active = helper;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    helper.buffer += chunk;
    for (;;) {
      const index = helper.buffer.indexOf("\n");
      if (index < 0) return;
      const line = helper.buffer.slice(0, index);
      helper.buffer = helper.buffer.slice(index + 1);
      onLine(helper, line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { helper.stderr = `${helper.stderr}${chunk}`.slice(-4000); });
  child.on("exit", () => {
    if (active === helper) active = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const detail = (helper.stderr || "").trim();
    const tail = detail ? `: ${detail.split("\n").slice(-3).join(" ")}` : "";
    failPending(helper, new Error(`computer-use helper exited${tail}`));
  });
  child.on("error", (error) => {
    if (active === helper) active = null;
    failPending(helper, new Error(`computer-use helper failed to start: ${error.message}`));
  });
  touchIdle();
  return helper;
}

async function request(command, params = {}, timeoutMs = 20000) {
  const helper = await getHelper();
  const id = ++helper.nextId;
  touchIdle();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helper.pending.delete(id);
      // A blocked UI Automation call wedges the whole line protocol, so recycle.
      resetHelper(`${command} timed out after ${timeoutMs}ms`);
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s; helper restarted, re-observe before retrying`));
    }, timeoutMs);
    helper.pending.set(id, { resolve, reject, timer });
    helper.child.stdin.write(`${JSON.stringify({ id, cmd: command, params })}\n`, "utf8", (error) => {
      if (!error) return;
      clearTimeout(timer);
      helper.pending.delete(id);
      reject(error);
    });
  });
}

// Internal hooks for scripts/self-test-computer.mjs. Not exposed as model tools.
export async function computerUseRequest(command, params = {}, timeoutMs = 20000) {
  return await request(command, params, timeoutMs);
}

// Steals foreground briefly (it clicks its own window), so it is opt-in only.
export async function runComputerSelfTest() {
  if (process.platform !== "win32") return { skipped: "not-windows" };
  return await request("selftest", {}, 60000);
}

export async function shutdownComputerUse() {
  if (!active) return;
  const helper = active;
  try { await request("exit", {}, 2000); } catch { }
  try { helper.child.kill(); } catch { }
  active = null;
}

function toPosix(value) {
  return String(value).replaceAll("\\", "/");
}

function describeCapture(info, rel) {
  const scale = Number(info.scale) || 1;
  return [
    `Captured ${info.width}x${info.height} png at ${rel}`,
    `origin=(${info.origin_x},${info.origin_y}) scale=${scale}`,
    `image -> screen: screen_x = ${info.origin_x} + round(image_x / ${scale}); screen_y = ${info.origin_y} + round(image_y / ${scale})`
  ].join("\n");
}

async function capture(args, opts, ctx, label) {
  const mode = args.screen === true || args.mode === "screen" ? "screen" : "window";
  const maxDim = Math.min(Math.max(Number(args.max_dim) || 0, 0), 4000);
  const dir = resolveWorkspacePath(ctx.cwd, SHOT_DIR, opts);
  await mkdir(dir, { recursive: true });

  let info = await request("capture", {
    mode,
    window: mode === "screen" ? undefined : args.window,
    max_dim: maxDim,
    out: join(dir, `${label}-${Date.now()}.png`)
  }, 30000);

  let bytes = await readFile(info.path);
  if (bytes.length > MAX_PNG_BYTES) {
    const file = info.path.replace(/\.png$/, "-small.png");
    info = await request("capture", {
      mode,
      window: mode === "screen" ? undefined : args.window,
      max_dim: 1600,
      out: file
    }, 30000);
    bytes = await readFile(info.path);
  }

  const rel = toPosix(relative(ctx.cwd, info.path));
  return { info, bytes, rel, text: describeCapture(info, rel) };
}

function imageResult(captureData, extraText = "") {
  const text = [captureData.text, extraText].filter(Boolean).join("\n\n");
  return multimodalResult({
    text,
    images: [{ data: captureData.bytes.toString("base64"), mimeType: "image/png", path: captureData.rel }],
    files: [captureData.rel]
  });
}

function windowTable(payload) {
  const rows = payload.windows || [];
  const lines = [`${payload.count} window(s). hwnd is the selector for every other computer_* tool.`];
  lines.push("hwnd      pid     minimized fg  process            title");
  for (const w of rows) {
    const proc = String(w.process || "").slice(0, 18).padEnd(18);
    const title = String(w.title || "").replace(/\s+/g, " ").slice(0, 90);
    lines.push(
      `${String(w.hwnd).padEnd(9)} ${String(w.pid).padEnd(7)} ${(w.minimized ? "yes" : "no ").padEnd(9)} ${(w.foreground ? "yes" : "no ")} ${proc} ${title}`
    );
  }
  if (!rows.length) lines.push("(no visible top-level windows)");
  return lines.join("\n");
}

function treeText(payload) {
  const mode = payload.compact ? ` compact (${payload.content_root} root)` : "";
  const lines = [
    `window ${payload.hwnd} "${payload.title}" nodes=${payload.node_count}${payload.truncated ? " (truncated)" : ""}${mode}`,
    payload.compact
      ? "format: @eN ControlType \"name\" value=\"...\" {patterns} (x,y,w,h) - pass N as element_index"
      : "format: [index] ControlType \"name\" value=\"...\" {patterns} (x,y,w,h) flags"
  ];
  if (payload.focused) lines.push(`focused: ${payload.focused}`);
  lines.push(payload.tree || "(empty tree)");
  if (payload.document_text) lines.push("", "document_text:", payload.document_text.slice(0, 6000));
  return lines.join("\n");
}

function actionHint(name, result) {
  return `${name}: ${JSON.stringify(result)}\n` +
    "Re-observe (computer_observe or computer_ui_tree) before the next action - indexes and coordinates are only valid for the observation that produced them.";
}


// ---------------------------------------------------------------- tools
const ACTIONS = {
  computer_doctor: {
    mutating: false,
    run: async () => {
      const exe = await ensureHelperBinary();
      const info = await request("info", {}, 15000);
      const screen = info.virtual_screen || {};
      return [
        "Computer Use runtime is ready.",
        `helper: ${exe}`,
        `uia_available: ${info.uia_available}  elevated: ${info.elevated}  interactive: ${info.interactive}`,
        `session_id: ${info.session_id}  monitors: ${info.monitor_count}`,
        `virtual_screen: ${screen.width}x${screen.height} at (${screen.x},${screen.y})`,
        `screenshots are written to ${SHOT_DIR}/ and attached as native images`
      ].join("\n");
    }
  },

  computer_windows: {
    mutating: false,
    run: async (args) => windowTable(await request("windows", {
      visible_only: args.visible_only !== false,
      include_tool_windows: args.include_tool_windows === true,
      include_cloaked: args.include_cloaked === true
    }, 20000))
  },

  computer_ui_tree: {
    mutating: false,
    run: async (args) => treeText(await request("tree", {
      window: args.window,
      max_nodes: args.max_nodes,
      max_depth: args.max_depth,
      include_offscreen: args.include_offscreen === true,
      compact: args.compact !== false
    }, 30000))
  },

  computer_observe: {
    mutating: false,
    run: async (args, opts, ctx) => {
      const shot = await capture(args, opts, ctx, "observe");
      let extra = "";
      if (args.include_ui_tree === true) {
        const tree = await request("tree", {
          window: args.window,
          max_nodes: args.max_nodes ?? 200,
          max_depth: args.max_depth ?? 8,
          compact: args.compact !== false
        }, 30000);
        extra = treeText(tree);
      }
      return imageResult(shot, extra);
    }
  },

  computer_focus: {
    mutating: true,
    summary: (args) => `bring window ${args.window} to the foreground`,
    run: async (args) => actionHint("focus", await request("focus", { window: args.window }, 15000))
  },

  computer_click: {
    mutating: true,
    summary: (args) => args.element_index !== undefined && args.element_index !== null
      ? `click element ${args.element_index} in window ${args.window ?? "(foreground)"}`
      : `click at screen (${args.x},${args.y})`,
    run: async (args) => actionHint("click", await request("click", {
      window: args.window,
      element_index: args.element_index,
      x: args.x,
      y: args.y,
      button: args.button,
      count: args.count
    }, 20000))
  },

  computer_type: {
    mutating: true,
    summary: (args) => `type ${String(args.text || "").length} character(s) into ${args.window ?? "the focused window"}`,
    run: async (args) => actionHint("type", await request("type", {
      window: args.window,
      element_index: args.element_index,
      text: args.text,
      replace: args.replace === true
    }, 30000))
  },

  computer_key: {
    mutating: true,
    summary: (args) => `press ${args.keys}`,
    run: async (args) => actionHint("key", await request("key", {
      window: args.window,
      keys: args.keys
    }, 15000))
  },

  computer_scroll: {
    mutating: true,
    summary: (args) => `scroll ${args.direction || "down"} in ${args.window ?? "the focused window"}`,
    run: async (args) => actionHint("scroll", await request("scroll", {
      window: args.window,
      x: args.x,
      y: args.y,
      direction: args.direction,
      pages: args.pages,
      amount: args.amount
    }, 20000))
  },

  computer_drag: {
    mutating: true,
    summary: (args) => `drag from (${args.from_x},${args.from_y}) to (${args.to_x},${args.to_y})`,
    run: async (args) => actionHint("drag", await request("drag", {
      window: args.window,
      from_x: args.from_x,
      from_y: args.from_y,
      to_x: args.to_x,
      to_y: args.to_y
    }, 25000))
  },

  computer_set_value: {
    mutating: true,
    summary: (args) => `set element ${args.element_index} to a new value`,
    run: async (args) => actionHint("set_value", await request("set_value", {
      window: args.window,
      element_index: args.element_index,
      value: args.value
    }, 15000))
  },

  computer_invoke: {
    mutating: true,
    summary: (args) => `invoke element ${args.element_index}`,
    run: async (args) => actionHint("invoke", await request("invoke", {
      window: args.window,
      element_index: args.element_index
    }, 15000))
  },

  computer_launch: {
    mutating: true,
    summary: (args) => `launch ${args.path}`,
    run: async (args) => actionHint("launch", await request("launch", {
      path: args.path,
      args: args.args,
      workdir: args.workdir,
      wait_ms: args.wait_ms
    }, 20000))
  }
};

export const COMPUTER_TOOL_NAMES = Object.keys(ACTIONS);

export function isComputerTool(name) {
  return Object.hasOwn(ACTIONS, name);
}

export async function runComputerTool(name, args = {}, opts = {}, ctx = {}) {
  if (process.platform !== "win32") {
    return "Computer Use is Windows-only in Switchyard (this host is " + process.platform + ").";
  }
  const action = ACTIONS[name];
  if (!action) throw new Error(`Unknown Computer Use tool: ${name}`);
  if (args.window === undefined && args.window_title !== undefined) {
    args = { ...args, window: args.window_title };
  }

  // Desktop control can send keystrokes to anything on screen, so review sessions
  // never get it and normal sessions confirm each mutating call unless the caller
  // already opted into unattended execution.
  if (opts.permission === "review") {
    return "blocked by session permission: review only (Computer Use can drive the desktop).";
  }
  if (action.mutating) {
    const preApproved = ["full", "yolo"].includes(opts.permission) || opts.dangerouslyAutoRunCommands === true;
    if (!preApproved) {
      if (opts.noOutput) return "blocked by no-output mode";
      const approved = await opts.askYesNo?.(`Allow Computer Use to ${action.summary(args)}?`);
      if (approved === false) return "blocked by user";
    }
  }

  try {
    return await action.run(args, opts, ctx);
  } catch (error) {
    throw new Error(`${name} failed: ${error.message}`);
  }
}
