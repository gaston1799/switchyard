// src/tui.js — terminal UI helpers for the dsw harness.
//
// Dependency-free (pure ANSI) rendering: streaming markdown-lite writer,
// spinner status line, tool-call tracker. Everything degrades to plain text
// when colors are disabled or stdout is not a TTY.
import { clearLine, cursorTo } from "node:readline";

function color(opts, code, text) {
  return opts.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function dim(opts, text) { return color(opts, "2", text); }
function bold(opts, text) { return color(opts, "1", text); }
function cyan(opts, text) { return color(opts, "36", text); }
function green(opts, text) { return color(opts, "32", text); }
function red(opts, text) { return color(opts, "31", text); }
function yellow(opts, text) { return color(opts, "33", text); }
function magenta(opts, text) { return color(opts, "35", text); }

export function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}

// A status line is cleared and redrawn in place. Never let it reach the final
// terminal column: terminals can soft-wrap there, while ANSI clearLine() only
// clears the current physical row. Leave a small margin and add an ellipsis.
export function fitTerminalLine(text, columns = process.stdout.columns || 120, margin = 3) {
  const max = Math.max(Number(columns || 120) - Math.max(Number(margin) || 0, 1), 1);
  const chars = [...String(text ?? "")];
  if (chars.length <= max) return chars.join("");
  if (max === 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}

// ── Streaming markdown-lite writer ──────────────────────────────────────────
// Buffers partial lines so only complete lines get styled; fences span writes.
// `linkify` (optional) post-processes a fully styled line (e.g. file links).
export function createMarkdownWriter(opts, linkify = (t) => t, { dimBody = false, status = null } = {}) {
  let pending = "";
  let inFence = false;
  let fenceLang = "";
  // Live mode: show partial lines token-by-token as they stream, restyled and
  // re-wrapped in place. Only when output is a real TTY with colors and not in
  // quiet-copy mode; otherwise buffer whole lines (no control characters).
  const live = Boolean(opts?.color && !opts?.tuiQuiet && process.stdout.isTTY && !opts.noOutput);
  // Claude Code-style padding: content is indented PAD_LEFT columns and keeps
  // a PAD_RIGHT margin, wrapped at WORD boundaries so "several" never renders
  // as "s\neveral".
  const PAD_LEFT = 2;
  const PAD_RIGHT = 2;
  // Rows currently on screen for the live partial line (padded, no trailing \n).
  let shownRows = [];
  const columns = () => Math.max(process.stdout.columns || 120, 40);
  const contentWidth = () => Math.max(columns() - PAD_LEFT - PAD_RIGHT, 20);
  const stripAnsi = (value) => String(value ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const widthOf = (value) => [...stripAnsi(value)].reduce((w, ch) => w + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);

  const clearShown = () => {
    const n = shownRows.length;
    if (!n) return;
    if (n > 1) process.stdout.write(`\x1b[${n - 1}A`);
    for (let i = 0; i < n; i += 1) {
      process.stdout.write("\x1b[2K");
      if (i < n - 1) process.stdout.write("\x1b[1B");
    }
    if (n > 1) process.stdout.write(`\x1b[${n - 1}A`);
    process.stdout.write("\r");
    shownRows = [];
  };

  // Word-wrap styled text to the content width. ANSI codes are preserved in
  // the output but ignored for measurement, so styles survive across rows.
  const wrapStyled = (text) => {
    const max = contentWidth();
    const rows = [];
    let row = "";
    let rowWidth = 0;
    const tokens = String(text).split(/( +)/);
    for (const token of tokens) {
      if (!token) continue;
      const w = widthOf(token);
      if (/^ +$/.test(token)) {
        if (rowWidth > 0 && rowWidth + w <= max) { row += token; rowWidth += w; }
        continue;
      }
      if (w > max && stripAnsi(token) === token) {
        // Unbreakable over-long plain token (URL, code): hard-split by chars.
        if (row) { rows.push(row); row = ""; rowWidth = 0; }
        let rest = token;
        while (widthOf(rest) > max) {
          const visible = [...rest];
          let cut = 1;
          while (cut < visible.length) {
            if (widthOf(visible.slice(0, cut + 1).join("")) > max) break;
            cut += 1;
          }
          rows.push(visible.slice(0, cut).join(""));
          rest = visible.slice(cut).join("");
        }
        row = rest; rowWidth = widthOf(rest);
        continue;
      }
      if (rowWidth > 0 && rowWidth + w > max) { rows.push(row); row = ""; rowWidth = 0; }
      row += token; rowWidth += w;
    }
    if (row !== "" || rows.length === 0) rows.push(row);
    return rows.map((r) => r.replace(/\s+$/, ""));
  };

  const writeLine = (line) => renderMarkdownLine(opts, line, { inFence: () => inFence, setFence: (v, lang) => { inFence = v; fenceLang = lang; } });
  const renderRows = (rows, endWithNewline) => {
    for (let i = 0; i < rows.length; i += 1) {
      process.stdout.write(" ".repeat(PAD_LEFT) + rows[i]);
      if (i < rows.length - 1 || endWithNewline) process.stdout.write("\n");
    }
  };
  // Bottom-region ownership. At any moment the bottom of the screen holds
  // EITHER the live partial line ("partial"), a pinned status line ("status"),
  // or nothing ("none"). Both are tracked in shownRows so clearShown() always
  // erases exactly what is there — the status can no longer be orphaned into
  // the scrollback the way an independently timer-drawn status line was. That
  // orphaning is why stale status lines piled up in every terminal except
  // VS Code's (whose cursor/columns handling happened to mask it).
  let bottomKind = "none";

  // Fit an already-styled status string onto a single physical row so the
  // one-row clearShown() math is always correct (no soft-wrap remainder).
  const fitStatusRow = (styled) => {
    const rows = wrapStyled(styled);
    if (rows.length <= 1) return rows[0] ?? "";
    const first = [...rows[0]];
    return `${first.slice(0, Math.max(first.length - 1, 0)).join("")}…`;
  };

  // Draw (or refresh) the pinned status as the single bottom row. Never covers
  // a live partial line; when the status has nothing to show, the bottom is
  // cleared instead.
  const parkStatus = () => {
    if (!live || !status || typeof status.line !== "function") return;
    if (bottomKind === "partial") return;
    const styled = status.line();
    if (styled == null) {
      if (bottomKind === "status") { clearShown(); shownRows = []; bottomKind = "none"; }
      return;
    }
    const row = fitStatusRow(styled);
    clearShown();
    renderRows([row], false);
    shownRows = [row];
    bottomKind = "status";
  };

  const finalizeLine = (line) => {
    const styled = linkify(writeLine(line));
    const rows = wrapStyled(styled);
    if (rows.join("\u0000") === shownRows.join("\u0000")) {
      // Already on screen exactly as-is (streamed + styled live): just close
      // the line with a newline instead of clearing + rewriting. This avoids
      // duplicate text artifacts when the terminal selection spans the rewrite.
      process.stdout.write("\n");
      shownRows = [];
    } else {
      clearShown();
      renderRows(rows, true);
    }
    shownRows = [];
    bottomKind = "none";
  };
  const renderLive = () => {
    if (pending === "") { parkStatus(); return; }
    const styled = linkify(writeLine(pending));
    const rows = wrapStyled(styled);
    if (rows.join("\u0000") === shownRows.join("\u0000")) return;
    clearShown();
    renderRows(rows, false);
    shownRows = rows;
    bottomKind = "partial";
  };
  // The active writer owns the pinned status: attaching routes the status's
  // animation ticks through parkStatus so there is exactly one writer to stdout.
  const clearRegion = () => { clearShown(); shownRows = []; bottomKind = "none"; };
  const attachStatus = () => { if (live) status?.attach?.({ redraw: parkStatus, clearRegion }); };
  return {
    write(text) {
      if (!opts || opts.noOutput) return;
      pending += String(text ?? "");
      const parts = pending.split("\n");
      pending = parts.pop() || "";
      if (!live) {
        for (const part of parts) {
          process.stdout.write(linkify(writeLine(part)) + "\n");
        }
        return;
      }
      attachStatus();
      for (const part of parts) finalizeLine(part);
      renderLive();
    },
    flush() {
      if (!opts || opts.noOutput) return;
      if (pending) {
        if (live) finalizeLine(pending);
        else process.stdout.write(linkify(writeLine(pending)) + "\n");
        pending = "";
      }
      if (inFence) {
        process.stdout.write(dim(opts, "```") + "\n");
        inFence = false;
      }
      if (live) {
        // Leave the bottom clean so whatever the caller prints next starts on
        // its own line, and release the status back to standalone drawing.
        clearShown();
        shownRows = [];
        bottomKind = "none";
        status?.detach?.();
      }
    }
  };
}

// Style one complete line. Fence state is threaded through the options bag and
// tracked even when colors are disabled (so the writer can close fences).
export function renderMarkdownLine(opts, line, fenceState = {}, { dimBody = false } = {}) {
  const raw = String(line ?? "");
  const { inFence, setFence } = fenceState;

  // Fence handling (state tracked regardless of color mode).
  const fenceOpen = raw.match(/^\s*(```|~~~)\s*([\w-]*)\s*$/);
  if (fenceOpen) {
    if (inFence?.()) setFence?.(false, "");
    else setFence?.(true, fenceOpen[2] || "");
    return opts?.color ? dim(opts, `${fenceOpen[1]}${fenceOpen[2] ? " " + fenceOpen[2] : ""}`) : raw;
  }
  if (inFence?.()) {
    return opts?.color ? dim(opts, `  ${raw}`) : raw;
  }
  if (!opts?.color) return raw;

  // Block elements.
  const heading = raw.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1].length;
    const code = level <= 2 ? "1;36" : "36";
    return color(opts, code, `${"#".repeat(level)} ${styleInline(opts, heading[2])}`);
  }
  if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(raw)) {
    return dim(opts, "─".repeat(Math.min(raw.length, 60)));
  }
  if (/^\s*>\s?/.test(raw)) {
    return `${dim(opts, "│ ")}${styleInline(opts, raw.replace(/^\s*>\s?/, ""))}`;
  }
  const task = raw.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const done = /[xX]/.test(task[1]);
    return `${done ? green(opts, "[✓]") : dim(opts, "[ ]")} ${styleInline(opts, task[2])}`;
  }
  const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
  if (bullet) {
    return `${cyan(opts, "•")} ${styleInline(opts, bullet[1])}`;
  }
  const numbered = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
  if (numbered) {
    return `${dim(opts, `${numbered[1]}.`)} ${styleInline(opts, numbered[2])}`;
  }

  return styleInline(opts, raw, dimBody);
}

function styleInline(opts, text, forceDim = false) {
  let out = "";
  let rest = String(text ?? "");
  const re = /(`[^`]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\))|(\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(rest)) !== null) {
    out += rest.slice(last, m.index);
    const [full, code, boldText, link, italic] = m;
    if (code) out += `${dim(opts, "`")}${cyan(opts, code.slice(1, -1))}${dim(opts, "`")}`;
    else if (boldText) out += bold(opts, styleInline(opts, boldText.slice(2, -2), false));
    else if (link) {
      const label = (link.match(/^\[([^\]]+)\]/) || [])[1] || full;
      const target = (link.match(/\]\(([^)\s]+)/) || [])[1] || "";
      out += terminalLinkSafe(opts, styleInline(opts, label, false), target) || full;
    } else if (italic) out += dim(opts, styleInline(opts, italic.slice(1, -1), false));
    else out += full;
    last = m.index + full.length;
  }
  out += rest.slice(last);
  return forceDim ? dim(opts, out) : out;
}

function terminalLinkSafe(opts, text, target) {
  if (!opts || !opts.color || !process.stdout.isTTY || !target) return text;
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ── Spinner status line ─────────────────────────────────────────────────────
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createStatusLine(opts, phrase = "Working", initialTokens = 0, model = "") {
  if (opts.noOutput || !process.stdout.isTTY) {
    return {
      isActive() { return false; },
      addTokens() {}, setTokens() {}, setPhrase() {}, clear() {}, stop() {}
    };
  }
  let tokens = initialTokens;
  let currentPhrase = phrase;
  let active = true;
  let visible = false;
  let frame = 0;
  const started = Date.now();
  const modelLabel = String(model || opts?.model || "").split("/").pop() || "";

  const render = () => {
    if (!active) return;
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame += 1;
    const elapsed = formatDuration(Date.now() - started);
    const parts = [spinner, currentPhrase, `${tokens} tok`, elapsed];
    if (modelLabel) parts.splice(1, 0, modelLabel);
    const text = fitTerminalLine(`  ${parts.join(" · ")}`);
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(dim(opts, text));
    visible = true;
  };

  const timer = setInterval(render, 80);
  render();

  return {
    isActive() { return active; },
    addTokens(value) { tokens += value; render(); },
    setTokens(value) { tokens = Math.max(0, Math.ceil(Number(value) || 0)); render(); },
    setPhrase(value) { currentPhrase = value || currentPhrase; render(); },
    clear() {
      if (!visible) return;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      visible = false;
    },
    stop() { active = false; clearInterval(timer); this.clear(); }
  };
}

// ── Tool-call tracker ───────────────────────────────────────────────────────
// Prints a compact one-line header per tool call, then a ✓/✗ completion line
// with duration. Results are printed by the caller below the completion line.
export class ToolCallTracker {
  constructor(opts) {
    this.opts = opts;
    this.count = 0;
    this.byId = new Map();
  }

  addCall(call) {
    if (this.opts.ui) return this.opts.ui.addTool(call);
    const name = String(call?.function?.name || "tool");
    let summary = "";
    try {
      summary = JSON.stringify(JSON.parse(String(call?.function?.arguments || "{}")));
    } catch {
      summary = String(call?.function?.arguments || "").slice(0, 200);
    }
    if (summary.length > 140) summary = `${summary.slice(0, 140)}…`;
    const id = (this.count += 1);
    this.byId.set(id, name);
    if (!this.opts.noOutput) {
      process.stdout.write(`  ${cyan(this.opts, "▹")} ${bold(this.opts, name)}${summary ? ` ${dim(this.opts, summary)}` : ""}\n`);
    }
    return id;
  }

  complete(id, durationMs, error) {
    if (this.opts.ui) return;
    if (this.opts.noOutput) return;
    const name = this.byId.get(id) || `tool#${id}`;
    const icon = error ? "✗" : "✓";
    const label = error ? "failed" : "done";
    const styled = error
      ? red(this.opts, `${icon} ${label} ${name}`)
      : green(this.opts, `${icon} ${name}`);
    process.stdout.write(`  ${styled} ${dim(this.opts, `(${formatDuration(durationMs)})`)}` + (error ? ` ${dim(this.opts, "— see result below")}` : "") + "\n");
  }
}
