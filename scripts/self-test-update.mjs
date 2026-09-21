// Self-test for src/update-check.js — pure-logic checks (parseLsRemote,
// resolveRepoDir, isSourceRun) plus a live checkForUpdates() against the real
// checkout. Network is best-effort: an offline result is accepted, never fatal.
import assert from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkForUpdates, isSourceRun, parseLsRemote, resolveRepoDir } from "../src/update-check.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  PASS ${name}`); }
async function checkAsync(name, fn) { await fn(); passed += 1; console.log(`  PASS ${name}`); }

check("parseLsRemote extracts the leading sha", () => {
  assert.equal(parseLsRemote("962eca5c1e2ddddeb830f9401738775c4898d7c3\trefs/heads/master"), "962eca5c1e2ddddeb830f9401738775c4898d7c3");
  assert.equal(parseLsRemote("abc1234\trefs/heads/x\nzzz\trefs/tags/y"), "abc1234");
});

check("parseLsRemote rejects junk / empty", () => {
  assert.equal(parseLsRemote(""), null);
  assert.equal(parseLsRemote("not-a-sha\trefs/heads/master"), null);
  assert.equal(parseLsRemote("   "), null);
});

check("resolveRepoDir finds this checkout's .git", () => {
  const repo = resolveRepoDir();
  assert.ok(repo, "expected a repo dir");
  assert.ok(existsSync(join(repo, ".git")), ".git should exist under the resolved repo");
});

check("isSourceRun is true when launched from a .js entry", () => {
  // This test is itself a .js/.mjs run, so the running entry is source.
  assert.equal(isSourceRun(), true);
});

await checkAsync("checkForUpdates returns a coherent shape", async () => {
  const info = await checkForUpdates({ timeoutMs: 8000 });
  assert.ok(info && typeof info.status === "string", "status string present");
  assert.ok(["up-to-date", "update-available", "offline", "unknown"].includes(info.status), `unexpected status: ${info.status}`);
  if (info.status === "update-available" || info.status === "up-to-date") {
    assert.match(info.currentSha, /^[0-9a-f]{40}$/, "currentSha is a full sha");
    assert.equal(typeof info.dirty, "boolean");
    assert.equal(typeof info.branch, "string");
  }
  console.log(`     (live status: ${info.status}${info.shortCurrent ? ` @ ${info.shortCurrent}` : ""}${info.dirty ? ", dirty" : ""})`);
});

console.log(`\nAll ${passed} update-check checks passed.`);
