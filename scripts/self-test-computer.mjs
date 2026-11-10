// scripts/self-test-computer.mjs
// Verifies the native Computer Use toolpack without needing a model turn.
//
//   node scripts/self-test-computer.mjs
//       read-only checks: compile, doctor, windows, capture, accessibility tree
//
//   COMPUTER_USE_INPUT_TEST=1 node scripts/self-test-computer.mjs
//       also runs the helper's own input self-test. That opens a small window,
//       focuses it, clicks a button and types into it - it WILL steal foreground
//       for a couple of seconds, so it is opt-in.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computerUseRequest,
  runComputerSelfTest,
  runComputerTool,
  shutdownComputerUse
} from "../src/computer_tools.js";

const cwd = process.cwd();
const full = { permission: "full", askYesNo: async () => true };

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error) => {
      failures += 1;
      console.log(`FAIL ${name}: ${error.message}`);
    });
}

await check("harness wiring is present", async () => {
  const source = await readFile(new URL("../src/deepseek-watch.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/computer_tools\.js"/, "deepseek-watch.js must import computer_tools.js");
  assert.match(source, /name\.startsWith\("computer_"\)/, "deepseek-watch.js must dispatch computer_* tools");
  assert.match(source, /shutdownComputerUse/, "deepseek-watch.js must stop the helper on exit");

  const packs = await import("../src/toolpacks.js");
  assert.equal(packs.toolpackForTool("computer_click"), "computer");
  assert.equal(packs.toolpackForTool("computer_observe"), "computer");
  assert.equal(packs.toolpackSchemas(["computer"]).length, 13);
});

await check("review permission is blocked", async () => {
  const blocked = await runComputerTool("computer_windows", {}, { permission: "review" }, { cwd });
  assert.match(String(blocked), /blocked by session permission/);
});

await check("helper compiles and reports readiness", async () => {
  const text = await runComputerTool("computer_doctor", {}, full, { cwd });
  assert.match(text, /Computer Use runtime is ready/);
  assert.match(text, /uia_available: true/);
  const exe = text.match(/helper: (.+\.exe)/);
  assert.ok(exe, "doctor output should include the helper path");
  assert.ok(existsSync(exe[1]), `helper binary missing: ${exe[1]}`);
});

await check("window enumeration returns structured records", async () => {
  const payload = await computerUseRequest("windows", { visible_only: true });
  assert.equal(typeof payload.count, "number");
  assert.ok(Array.isArray(payload.windows));
  for (const window of payload.windows) {
    assert.equal(typeof window.hwnd, "number");
    assert.equal(typeof window.process, "string");
    assert.ok(window.width > 0 && window.height > 0, "window rect should be positive");
  }
  const text = await runComputerTool("computer_windows", {}, full, { cwd });
  assert.match(text, /window\(s\)/);
});

await check("screen capture produces a native image result", async () => {
  const result = await runComputerTool("computer_observe", { screen: true, max_dim: 900 }, full, { cwd });
  assert.equal(result?.type, "switchyard.multimodal.v1");
  assert.equal(result.images.length, 1);
  assert.ok(result.images[0].data.length > 1000, "image payload should not be empty");
  assert.match(result.images[0].mimeType, /image\/png/);
  const file = resolve(cwd, result.images[0].path);
  assert.ok(existsSync(file), `screenshot missing on disk: ${file}`);
  assert.match(result.text, /origin=\(\d+,\d+\) scale=/);
});

await check("accessibility tree exposes indexes and patterns", async () => {
  const payload = await computerUseRequest("windows", { visible_only: true });
  const candidate = payload.windows.find((window) => !window.minimized);
  if (!candidate) {
    console.log("     (skipped - no unminimized window to inspect)");
    return;
  }
  const tree = await computerUseRequest("tree", { window: candidate.hwnd, max_nodes: 60, max_depth: 6 }, 30000);
  assert.equal(typeof tree.node_count, "number");
  assert.ok(tree.node_count > 0, "expected at least one accessibility node");
  if (tree.node_count > 0) assert.match(tree.tree, /\[\d+\]|@e\d+/);
});

await check("compact mode emits @e refs from the content root", async () => {
  const payload = await computerUseRequest("windows", { visible_only: true });
  const candidate = payload.windows.find((window) => !window.minimized);
  if (!candidate) {
    console.log("     (skipped - no unminimized window to inspect)");
    return;
  }
  const tree = await computerUseRequest("tree", { window: candidate.hwnd, max_nodes: 40, max_depth: 6, compact: true }, 30000);
  assert.equal(tree.compact, true);
  assert.ok(["document", "window"].includes(tree.content_root), `unexpected content_root: ${tree.content_root}`);
  assert.match(tree.tree, /@e\d+/, "compact output should use @eN refs");

  // The tool default is compact too, so the model gets refs without asking.
  const viaTool = await runComputerTool("computer_ui_tree", { window: candidate.hwnd, max_nodes: 20, max_depth: 5 }, full, { cwd });
  assert.match(viaTool, /compact \((document|window) root\)/);
});

await check("stale element index is rejected", async () => {
  await assert.rejects(
    () => computerUseRequest("click", { window: 1, element_index: 9999 }, 5000),
    /no such window handle|no accessibility observation|not in the latest observation/
  );
});

await check("unknown window selector is rejected", async () => {
  await assert.rejects(
    () => computerUseRequest("tree", { window_title: "switchyard-no-such-window-xyz" }, 10000),
    /no visible window matched/
  );
});

if (process.env.COMPUTER_USE_INPUT_TEST === "1") {
  await check("input self-test (focus, click, type)", async () => {
    const report = await runComputerSelfTest();
    assert.equal(report.capture_blank, false, "self-test window capture was blank");
    assert.ok(report.uia_nodes > 0, "self-test window had no accessibility nodes");
    assert.equal(report.typed_value, "cu-selftest", "typed text did not reach the textbox");
    assert.equal(report.click_ok, true, "synthetic click did not fire the button");
    assert.equal(report.passed, true);
  });
} else {
  console.log("skip input self-test (set COMPUTER_USE_INPUT_TEST=1 to include it)");
}

await shutdownComputerUse();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall computer-use checks passed");
}
