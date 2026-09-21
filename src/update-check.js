// src/update-check.js — Codex-style "update available" check for the dsw CLI.
//
// Before an interactive session starts, dsw compares the local git checkout
// against origin and, if it is behind, offers to update now or skip until the
// next release. The network probe uses `git ls-remote` (one round trip, no
// object download) so startup stays snappy; the actual fetch + fast-forward
// only runs when the user chooses to update.
//
// "Skip until next update" is remembered per remote commit in the dsw config,
// so the prompt does not nag on every launch but returns the moment origin
// advances again.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig } from "./config.js";

function git(args, cwd, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ ok: false, code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    let out = ""; let err = ""; let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ ok: false, code: -1, stdout: out.trim(), stderr: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0 && !killed, code, timed_out: killed, stdout: out.trim(), stderr: err.trim() }); });
  });
}

// First field of the first `git ls-remote` line is the remote commit sha.
export function parseLsRemote(stdout) {
  const first = String(stdout || "").split(/\r?\n/).find((l) => l.trim());
  if (!first) return null;
  const sha = first.split(/\s+/)[0];
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

// Locate the git checkout backing this binary. In dev mode the module lives at
// <repo>/src/update-check.js; from a compiled exe it falls back to the standard
// install location under %LOCALAPPDATA%.
export function resolveRepoDir() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const repo = dirname(here);
    if (existsSync(join(repo, ".git"))) return repo;
  } catch { /* import.meta.url unavailable (bundled) → fall through */ }
  const fallback = join(process.env.LOCALAPPDATA || "", "deepseek-detached-agent");
  if (process.env.LOCALAPPDATA && existsSync(join(fallback, ".git"))) return fallback;
  return null;
}

// Whether the running binary is source (a .js entry) rather than a compiled
// SEA exe. Only source picks up an update by re-exec without a rebuild.
export function isSourceRun() {
  const entry = process.argv[1];
  return typeof entry === "string" && /\.[cm]?js$/i.test(entry);
}

export async function checkForUpdates({ timeoutMs = 6000 } = {}) {
  const repoDir = resolveRepoDir();
  if (!repoDir) return { status: "unknown" };
  const head = await git(["rev-parse", "HEAD"], repoDir, 4000);
  if (!head.ok) return { status: "unknown", repoDir };
  const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir, 4000);
  const branch = branchRes.ok && branchRes.stdout && branchRes.stdout !== "HEAD" ? branchRes.stdout : "master";
  const ls = await git(["ls-remote", "origin", branch], repoDir, timeoutMs);
  const remoteSha = ls.ok ? parseLsRemote(ls.stdout) : null;
  if (!remoteSha) return { status: "offline", repoDir, branch, currentSha: head.stdout };
  const dirtyRes = await git(["status", "--porcelain"], repoDir, 4000);
  const dirty = dirtyRes.ok && dirtyRes.stdout.length > 0;
  const upToDate = remoteSha === head.stdout;
  return {
    status: upToDate ? "up-to-date" : "update-available",
    repoDir,
    branch,
    dirty,
    currentSha: head.stdout,
    remoteSha,
    shortCurrent: head.stdout.slice(0, 9),
    shortRemote: remoteSha.slice(0, 9),
    isSource: isSourceRun(),
  };
}

// ── "skip until next update" persistence ─────────────────────────────────────
export async function isSkipped(remoteSha) {
  try {
    const cfg = await readConfig();
    return Boolean(remoteSha) && cfg.updateSkip?.sha === remoteSha;
  } catch { return false; }
}
export async function setSkipped(remoteSha) {
  const cfg = await readConfig();
  cfg.updateSkip = { sha: remoteSha, at: new Date().toISOString() };
  await writeConfig(cfg);
}
export async function clearSkipped() {
  try {
    const cfg = await readConfig();
    if (cfg.updateSkip) { delete cfg.updateSkip; await writeConfig(cfg); }
  } catch { /* config not writable — nothing to clear */ }
}

// Fetch origin and fast-forward the local branch. Refuses to merge when the
// branch has diverged (local commits origin doesn't have) so no work is lost.
export async function performUpdate(repoDir, branch) {
  const fetch = await git(["fetch", "origin", branch], repoDir, 120000);
  if (!fetch.ok) return { ok: false, phase: "fetch", message: fetch.stderr || "git fetch failed" };
  const ff = await git(["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`], repoDir, 8000);
  if (!ff.ok) return { ok: false, phase: "diverged", message: "Local branch has diverged from origin. Reconcile it manually (e.g. git pull --rebase)." };
  const merge = await git(["merge", "--ff-only", `origin/${branch}`], repoDir, 30000);
  if (!merge.ok) return { ok: false, phase: "merge", message: merge.stderr || "fast-forward merge failed" };
  const newHead = await git(["rev-parse", "HEAD"], repoDir, 4000);
  return { ok: true, newSha: newHead.ok ? newHead.stdout : "", message: merge.stdout };
}
