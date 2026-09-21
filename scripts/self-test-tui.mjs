// Self-test for src/tui.js rendering logic (markdown writer, status line
// helpers, tool tracker). Pure-logic checks; no real TTY required.
import assert from "node:assert";
import { createMarkdownWriter, fitTerminalLine, formatDuration, renderMarkdownLine, ToolCallTracker } from "../src/tui.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

const colorOn = { color: true, model: "test-model" };
const colorOff = { color: false };

// formatDuration
check("formatDuration", () => {
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(90000), "1m 30s");
  assert.equal(formatDuration(0), "0ms");
});

check("status line leaves a soft-wrap safety margin", () => {
  const line = fitTerminalLine("x".repeat(80), 40);
  assert.equal([...line].length, 37);
  assert.ok(line.endsWith("…"));
});

// renderMarkdownLine: color-off is a plain passthrough.
check("color-off passthrough", () => {
  const line = "# Hello **world** `code`";
  assert.equal(renderMarkdownLine(colorOff, line), line);
});

// renderMarkdownLine: block + inline styles produce ANSI codes.
check("heading + inline styling", () => {
  const out = renderMarkdownLine(colorOn, "## Hello **world** `code`");
  assert.ok(out.includes("\x1b[1;36m"), "heading color");
  assert.ok(out.includes("\x1b[1m"), "bold");
  assert.ok(out.includes("\x1b[36m"), "inline code color");
});

check("bullet / task / numbered / quote", () => {
  assert.ok(renderMarkdownLine(colorOn, "- item").includes("•"));
  assert.ok(renderMarkdownLine(colorOn, "- [x] done").includes("[✓]"));
  assert.ok(renderMarkdownLine(colorOn, "- [ ] todo").includes("[ ]"));
  assert.ok(renderMarkdownLine(colorOn, "1. first").includes("1."));
  assert.ok(renderMarkdownLine(colorOn, "> quoted").includes("│"));
});

check("fence state threading", () => {
  let inFence = false;
  let lang = "";
  const state = { inFence: () => inFence, setFence: (v, l) => { inFence = v; lang = l; } };
  const open = renderMarkdownLine(colorOn, "```js", state);
  assert.equal(inFence, true);
  assert.equal(lang, "js");
  assert.ok(open.includes("js"));
  const body = renderMarkdownLine(colorOn, "const x = 1;", state);
  assert.ok(body.includes("\x1b[2m"), "fence body dimmed");
  const close = renderMarkdownLine(colorOn, "```", state);
  assert.equal(inFence, false);
  assert.ok(close);
});

// Streaming writer: partial lines buffered until newline.
check("writer buffers partial lines", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    const w = createMarkdownWriter(colorOff);
    w.write("line1");
    assert.equal(chunks.length, 0, "nothing flushed before newline");
    w.write("\nline2\n");
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], "line1\n");
    assert.equal(chunks[1], "line2\n");
    w.flush();
    assert.equal(chunks.length, 2, "flush with empty pending does nothing");
  } finally {
    process.stdout.write = orig;
  }
});

check("writer flush emits trailing partial line", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    const w = createMarkdownWriter(colorOff);
    w.write("tail");
    w.flush();
    assert.deepEqual(chunks, ["tail\n"]);
  } finally {
    process.stdout.write = orig;
  }
});

check("writer can dim streamed reasoning body", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    // Reasoning is dimmed by wrapping each styled line in a linkify transform.
    const w = createMarkdownWriter(colorOn, (text) => `\x1b[2m${text}\x1b[0m`);
    w.write("reasoning line\n");
    assert.ok(chunks.join("").includes("\x1b[2mreasoning line\x1b[0m"), "reasoning body is dimmed");
  } finally {
    process.stdout.write = orig;
  }
});

check("writer closes unclosed fence on flush", () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    const w = createMarkdownWriter(colorOff);
    w.write("```\ncode");
    w.flush();
    const joined = chunks.join("");
    assert.ok(joined.includes("```\ncode\n"), "fence body flushed");
    assert.ok(joined.endsWith("```\n"), "closing fence emitted");
  } finally {
    process.stdout.write = orig;
  }
});

// Live mode (fake TTY): partial lines stream token-by-token with padding, then
// the complete line is restyled in place via a clear sequence.
check("writer live mode streams partial lines with padding", () => {
  const chunks = [];
  const orig = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  process.stdout.write = (s) => { chunks.push(s); return true; };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
  try {
    const w = createMarkdownWriter(colorOn);
    w.write("several");
    // First partial: padded text, no newline, no clear (nothing shown).
    assert.deepEqual(chunks, ["  several"]);
    w.write(" words");
    // Clear the 1-row partial, then rewrite padded.
    assert.deepEqual(chunks, ["  several", "\x1b[2K", "\r", "  several words"]);
    w.write("\n");
    // Line completes: already shown identically, so just close with a newline
    // (no clear+rewrite → no duplicate-text artifacts in selections).
    assert.deepEqual(chunks.slice(4), ["\n"]);
    w.flush();
    assert.deepEqual(chunks.slice(-2), ["  several words", "\n"]);
  } finally {
    process.stdout.write = orig;
    if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    else delete process.stdout.isTTY;
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    else delete process.stdout.columns;
  }
});

// Word wrap: content wraps at word boundaries inside the padded area — a word
// like "several" must never be split across rows.
check("writer wraps at word boundaries (no mid-word split)", () => {
  const chunks = [];
  const orig = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  process.stdout.write = (s) => { chunks.push(s); return true; };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 50, configurable: true }); // width 46
  try {
    const w = createMarkdownWriter(colorOn);
    w.write("several words here testing word wrap boundaries");
    assert.deepEqual(chunks, ["  several words here testing word wrap", "\n", "  boundaries"]);
  } finally {
    process.stdout.write = orig;
    if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    else delete process.stdout.isTTY;
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    else delete process.stdout.columns;
  }
});

// Unbreakable over-long tokens (URLs, code) are hard-split, but words aren't.
check("writer hard-splits only over-long tokens", () => {
  const chunks = [];
  const orig = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  process.stdout.write = (s) => { chunks.push(s); return true; };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true }); // width 36
  try {
    const w = createMarkdownWriter(colorOn);
    w.write("a".repeat(48)); // 48 chars > 36 → hard-split
    assert.deepEqual(chunks, [`  ${"a".repeat(36)}`, "\n", `  ${"a".repeat(12)}`]);
  } finally {
    process.stdout.write = orig;
    if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    else delete process.stdout.isTTY;
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    else delete process.stdout.columns;
  }
});

// Tool tracker: noOutput mode is silent but still assigns ids.
check("tool tracker noOutput silent", () => {
  const tracker = new ToolCallTracker({ noOutput: true });
  const id = tracker.addCall({ function: { name: "read_text_file", arguments: "{}" } });
  assert.equal(typeof id, "number");
  tracker.complete(id, 120, false);
  tracker.complete(id + 1, 120, true); // unknown id — no crash
});

// ── Regression: pinned status must never leak into the scrollback ────────────
// The reported bug: while a reply streamed, the "· model · Drafting · N tokens"
// status line was reprinted between content lines and left behind on every
// terminal except VS Code's. This replays the writer's REAL byte output through
// a tiny terminal emulator (handling \n, \r and the CSI cursor/erase codes the
// writer emits) and asserts the status only ever occupies the transient bottom
// row — never a committed scrollback row above real content.
function renderVT(data) {
  const rows = [""];
  let cy = 0;
  let cx = 0;
  const ensure = () => { while (rows.length <= cy) rows.push(""); };
  const put = (text) => {
    ensure();
    let line = rows[cy];
    if (cx > line.length) line = line.padEnd(cx, " ");
    rows[cy] = line.slice(0, cx) + text + line.slice(cx + text.length);
    cx += text.length;
  };
  for (let i = 0; i < data.length;) {
    const ch = data[i];
    if (ch === "\x1b" && data[i + 1] === "[") {
      let j = i + 2;
      let params = "";
      while (j < data.length && /[0-9;]/.test(data[j])) { params += data[j]; j += 1; }
      const final = data[j];
      const n = parseInt(params, 10) || 0;
      if (final === "A") cy = Math.max(0, cy - (n || 1));
      else if (final === "B") { cy += (n || 1); ensure(); }
      else if (final === "K") { ensure(); rows[cy] = ""; }
      else if (final === "G") cx = Math.max(0, (n || 1) - 1);
      i = j + 1;
      continue;
    }
    if (ch === "\x1b" && data[i + 1] === "]") { // OSC hyperlink — skip to ST/BEL
      let j = i + 2;
      while (j < data.length && !(data[j] === "\x07" || (data[j] === "\x1b" && data[j + 1] === "\\"))) j += 1;
      i = data[j] === "\x07" ? j + 1 : j + 2;
      continue;
    }
    if (ch === "\x1b") { i += 1; continue; }
    if (ch === "\n") { cy += 1; cx = 0; ensure(); i += 1; continue; }
    if (ch === "\r") { cx = 0; i += 1; continue; }
    put(ch);
    i += 1;
  }
  return rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

// A minimal status implementing the contract the writer depends on: line() /
// attach() / detach(). tick() simulates the animation timer firing between
// stream chunks (which is exactly when the old code leaked a status line).
function mockStatus() {
  let attached = null;
  let tokens = 0;
  let active = true;
  return {
    line() { return active ? `<STATUS ${tokens}tok>` : null; },
    attach(hooks) { attached = hooks || null; },
    detach() { attached = null; },
    tick() { tokens += 7; attached?.redraw?.(); },
    stop() { active = false; },
    isActive() { return active; },
    refresh() { attached?.redraw?.(); },
    setBlocked() {}, setPhrase() {}, setTokens() {}, addTokens() {}, clear() {}
  };
}

function withLiveTty(cols, fn) {
  const chunks = [];
  const orig = process.stdout.write;
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  process.stdout.write = (s) => { chunks.push(s); return true; };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  try { fn(chunks); } finally {
    process.stdout.write = orig;
    if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY); else delete process.stdout.isTTY;
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols); else delete process.stdout.columns;
  }
  return chunks;
}

const STREAM_LINES = ["Thinking about the plan.", "Second line here.", "Third and final line."];

check("status line never leaks into scrollback while streaming", () => {
  const status = mockStatus();
  const chunks = withLiveTty(60, () => {
    const w = createMarkdownWriter(colorOn, (t) => t, { status });
    // Stream in fragments with the status animating between every fragment —
    // the exact interleaving that used to strand a status line per paragraph.
    const deltas = ["Think", "ing about ", "the plan.\n", "Second ", "line here.\n", "Third ", "and final line."];
    for (const d of deltas) { w.write(d); status.tick(); }
    w.flush();
  });
  const screen = renderVT(chunks.join(""));
  const statusRows = screen.filter((r) => r.includes("<STATUS"));
  assert.equal(statusRows.length, 0, `status leaked ${statusRows.length} line(s) into scrollback: ${JSON.stringify(statusRows)}`);
  for (const line of STREAM_LINES) {
    const hits = screen.filter((r) => r.trim() === line).length;
    assert.equal(hits, 1, `expected "${line}" exactly once, saw ${hits}`);
  }
});

check("status stays a single transient bottom row mid-stream", () => {
  const status = mockStatus();
  const chunks = withLiveTty(60, () => {
    const w = createMarkdownWriter(colorOn, (t) => t, { status });
    // Stop BEFORE flush: mid-stream the bottom may show the status, but it must
    // be the only status row and must sit below all committed content.
    const deltas = ["Thinking about the plan.\n", "Second line here.\n", "Third "];
    for (const d of deltas) { w.write(d); status.tick(); }
  });
  const screen = renderVT(chunks.join(""));
  const statusIdx = screen.map((r, i) => (r.includes("<STATUS") ? i : -1)).filter((i) => i >= 0);
  assert.ok(statusIdx.length <= 1, `more than one status row on screen: ${statusIdx.length}`);
  if (statusIdx.length === 1) {
    const below = screen.slice(statusIdx[0] + 1).filter((r) => r.trim().length && !r.includes("<STATUS"));
    assert.equal(below.length, 0, `content committed below the status row: ${JSON.stringify(below)}`);
  }
  // The two completed lines are committed exactly once regardless of the status.
  for (const line of STREAM_LINES.slice(0, 2)) {
    assert.equal(screen.filter((r) => r.trim() === line).length, 1, `"${line}" not committed once`);
  }
});

console.log(`\nAll ${passed} TUI checks passed.`);
