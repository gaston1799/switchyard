import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { switchyardDataRoot } from "./data-store.js";

const COORDINATION_MARKERS = ["agents", "inbox", "processed", "tasks", "claims", "events"];
const LIVE_STATES = new Set(["starting", "working", "waiting", "parked"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPath(value) {
  let path = String(value || "").trim();
  if (process.platform === "win32") {
    const wsl = path.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (wsl) path = `${wsl[1].toUpperCase()}:\\${wsl[2].replaceAll("/", "\\")}`;
  }
  return resolve(path);
}

function pathKey(path) {
  const canonical = canonicalPath(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function mountedDriveRoots() {
  if (platform() !== "win32") return [resolve(homedir(), "..")];
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { await readdir(root); roots.push(root); } catch { /* no accessible mounted drive */ }
  }
  return roots;
}

export async function discoverWatchRoots(driveRoots = null, { onProgress } = {}) {
  const found = new Set();
  const inaccessible = [];
  let visited = 0;
  const stack = [...(driveRoots || await mountedDriveRoots())].map((path) => resolve(path));
  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited % 50_000 === 0) onProgress?.({ visited, rootsFound: found.size });
    let entries;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) continue;
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      inaccessible.push({ path: current, code: error?.code || "ERR" });
      continue;
    }
    if (/^\.deepseek-watch(?:-agent)?$/i.test(basename(current))) found.add(current);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      stack.push(join(current, entry.name));
    }
  }
  return { roots: [...found].sort((a, b) => a.localeCompare(b)), inaccessible, visited };
}

async function isCoordinationRoot(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && COORDINATION_MARKERS.includes(entry.name));
  } catch { return false; }
}

function resolveSessionCoordDir(session, sourceRoot) {
  const value = session?.config?.coordDir;
  if (!value || typeof value !== "string") return null;
  const base = session?.workspace || dirname(sourceRoot);
  return canonicalPath(isAbsolute(value) || /^\/mnt\/[a-z]\//i.test(value) ? value : join(base, value));
}

async function listSessionSources(watchRoots) {
  const sources = [];
  const errors = [];
  for (const watchRoot of watchRoots) {
    const directory = join(watchRoot, "sessions");
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code !== "ENOENT") errors.push({ path: directory, code: error?.code || "ERR" }); continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const source = join(directory, entry.name);
      try {
        const [before, text] = await Promise.all([stat(source), readFile(source, "utf8")]);
        let session = null;
        let invalidJson = false;
        try { session = JSON.parse(text); }
        catch { invalidJson = true; errors.push({ path: source, code: "INVALID_JSON" }); }
        const after = await stat(source);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          errors.push({ path: source, code: "CHANGED_DURING_SCAN" });
          continue;
        }
        sources.push({
          path: source,
          root: watchRoot,
          fileName: entry.name,
          text,
          hash: sha256(text),
          session,
          invalidJson,
          coordDir: resolveSessionCoordDir(session, watchRoot)
        });
      } catch (error) { errors.push({ path: source, code: error?.code || "ERR" }); }
    }
  }
  return { sources, errors };
}

async function discoverCoordinationRoots(watchRoots, sessionSources, dataRoot) {
  const roots = new Map();
  for (const watchRoot of watchRoots) {
    const candidate = join(watchRoot, "coordination");
    if (await isCoordinationRoot(candidate) && !isWithin(dataRoot, resolve(candidate))) roots.set(pathKey(candidate), resolve(candidate));
  }
  for (const source of sessionSources) {
    if (!source.coordDir || isWithin(dataRoot, source.coordDir)) continue;
    if (await isCoordinationRoot(source.coordDir)) roots.set(pathKey(source.coordDir), source.coordDir);
  }
  return [...roots.values()].sort((a, b) => a.localeCompare(b));
}

function centralCoordinationPath(sourcePath, dataRoot) {
  const id = sha256(pathKey(sourcePath)).slice(0, 20);
  return join(dataRoot, "coordination", "migrated", id);
}

async function coordinationActivity(root, isProcessAlive) {
  const agentsDir = join(root, "agents");
  let files;
  try { files = await readdir(agentsDir, { withFileTypes: true }); }
  catch { return []; }
  const active = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(agentsDir, entry.name), "utf8"));
      const heartbeat = Date.parse(record.heartbeatAt || "");
      const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= 30_000;
      if (LIVE_STATES.has(String(record.state || "").toLowerCase()) && fresh && isProcessAlive(Number(record.pid))) {
        active.push({ agentId: record.agentId || entry.name, session: record.session || "" });
      }
    } catch { /* malformed agent records are preserved but do not block */ }
  }
  return active;
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { throw new Error(`Cannot read coordination directory ${current}: ${error?.message || error}`); }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

async function writeVerified(destination, buffer, expectedHash, conflicts) {
  try {
    const current = await readFile(destination);
    if (sha256(current) === expectedHash) return "unchanged";
    conflicts.push(destination);
    return "conflict";
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.migration.tmp`;
  await writeFile(temporary, buffer, { flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    await writeFile(temporary, buffer);
  });
  try { await rename(temporary, destination); }
  catch (error) {
    if (error?.code === "EEXIST" || error?.code === "EPERM") {
      const current = await readFile(destination).catch(() => null);
      if (current && sha256(current) === expectedHash) return "unchanged";
    }
    throw error;
  }
  const written = await readFile(destination);
  if (sha256(written) !== expectedHash) throw new Error(`Verification failed after writing ${destination}`);
  return "copied";
}

async function updateMigrationManifest(destination, buffer, expectedHash, destinationRoot, conflicts) {
  try {
    const existing = JSON.parse(await readFile(destination, "utf8"));
    if (existing.schemaVersion !== 1 || resolve(existing.destination || "") !== destinationRoot) {
      conflicts.push(destination);
      return "conflict";
    }
    if (sha256(await readFile(destination)) === expectedHash) return "unchanged";
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.migration.tmp`;
    await writeFile(temporary, buffer);
    try { await rename(temporary, destination); }
    catch (error) {
      if (!(["EEXIST", "EPERM", "EACCES"].includes(error?.code))) throw error;
      await writeFile(destination, buffer);
    }
    if (sha256(await readFile(destination)) !== expectedHash) throw new Error(`Manifest verification failed after writing ${destination}`);
    return "updated";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return writeVerified(destination, buffer, expectedHash, conflicts);
}

function migratedSessionBuffer(source, coordMap, activeGroups) {
  if (!source.session) return Buffer.from(source.text, "utf8");
  const copy = structuredClone(source.session);
  const groupKey = source.coordDir && pathKey(source.coordDir);
  const destination = groupKey && !activeGroups.has(groupKey) ? coordMap.get(groupKey) : null;
  if (destination) {
    copy.config = { ...(copy.config || {}), coordDir: destination };
  }
  return Buffer.from(`${JSON.stringify(copy, null, 2)}\n`, "utf8");
}

export async function migrateLegacyData({
  driveRoots,
  watchRoots: suppliedWatchRoots,
  dataRoot = switchyardDataRoot(),
  copy = false,
  onProgress,
  isProcessAlive = defaultProcessAlive
} = {}) {
  const destinationRoot = resolve(dataRoot);
  let previousScan = null;
  if (suppliedWatchRoots) {
    try {
      const previous = JSON.parse(await readFile(join(destinationRoot, "migration-manifest.json"), "utf8"));
      const previousRoots = (previous.watchRoots || []).map(pathKey).sort();
      const requestedRoots = [...new Set(suppliedWatchRoots.map((path) => resolve(path)))].map(pathKey).sort();
      if (previous.schemaVersion === 1 && resolve(previous.destination || "") === destinationRoot
        && previousRoots.length === requestedRoots.length && previousRoots.every((root, index) => root === requestedRoots[index])) {
        previousScan = {
          drives: previous.drives || [],
          directoriesVisited: previous.directoriesVisited || 0,
          inaccessible: previous.inaccessible || [],
          inaccessibleCount: previous.inaccessibleCount || 0
        };
      }
    } catch { /* no prior full-drive inventory to carry forward */ }
  }
  const discovery = suppliedWatchRoots
    ? {
      roots: [...new Set(suppliedWatchRoots.map((path) => resolve(path)))].sort(),
      inaccessible: previousScan?.inaccessible || [],
      inaccessibleCount: previousScan?.inaccessibleCount || 0,
      visited: previousScan?.directoriesVisited || 0
    }
    : await discoverWatchRoots(driveRoots, { onProgress });
  const { sources, errors: sessionErrors } = await listSessionSources(discovery.roots);
  const coordinationRoots = await discoverCoordinationRoots(discovery.roots, sources, destinationRoot);
  const coordMap = new Map(coordinationRoots.map((source) => [pathKey(source), centralCoordinationPath(source, destinationRoot)]));
  const sessionMap = new Map(sources.map((source) => [pathKey(source.path), join(destinationRoot, "sessions", `${sha256(pathKey(source.root)).slice(0, 10)}--${source.fileName}`)]));
  const activeGroups = new Map();
  for (const root of coordinationRoots) {
    const active = await coordinationActivity(root, isProcessAlive);
    if (active.length) activeGroups.set(pathKey(root), active);
  }

  const report = {
    destination: destinationRoot,
    drives: previousScan?.drives?.length ? previousScan.drives : driveRoots || await mountedDriveRoots(),
    directoriesVisited: discovery.visited,
    watchRoots: discovery.roots,
    sessionCount: sources.length,
    coordinationRoots: coordinationRoots.map((source) => ({ source, destination: coordMap.get(pathKey(source)), activeAgents: activeGroups.get(pathKey(source)) || [] })),
    inaccessible: discovery.inaccessible.slice(0, 50),
    inaccessibleCount: discovery.inaccessibleCount ?? discovery.inaccessible.length,
    errors: sessionErrors,
    copiedSessions: 0,
    skippedActiveSessions: [],
    unchangedSessions: 0,
    copiedCoordinationFiles: 0,
    unchangedCoordinationFiles: 0,
    conflicts: [],
    copyErrors: [],
    sessionMappings: []
  };
  const migratedSessionKeys = new Set();

  if (!copy) return report;

  for (const source of sources) {
    const activeSession = report.coordinationRoots
      .flatMap((entry) => entry.activeAgents)
      .find((agent) => agent.session && pathKey(agent.session) === pathKey(source.path));
    if (activeSession) {
      report.skippedActiveSessions.push({ source: source.path, agentId: activeSession.agentId });
      continue;
    }
    const destination = sessionMap.get(pathKey(source.path));
    const buffer = migratedSessionBuffer(source, coordMap, activeGroups);
    const result = await writeVerified(destination, buffer, sha256(buffer), report.conflicts).catch((error) => {
      report.copyErrors.push({ source: source.path, destination, message: error?.message || String(error) });
      return "error";
    });
    if (result === "copied") report.copiedSessions += 1;
    else if (result === "unchanged") report.unchangedSessions += 1;
    if (result === "copied" || result === "unchanged") migratedSessionKeys.add(pathKey(source.path));
    if (result !== "conflict" && result !== "error") report.sessionMappings.push({
      source: source.path,
      destination,
      sourceHash: source.hash,
      destinationHash: sha256(buffer),
      invalidJson: source.invalidJson,
      workspace: source.session?.workspace || "",
      agentId: source.session?.config?.agentId || "",
      sourceCoordDir: source.coordDir || "",
      coordinationDirectory: source.coordDir ? (activeGroups.has(pathKey(source.coordDir)) ? source.coordDir : coordMap.get(pathKey(source.coordDir)) || source.coordDir) : "",
      coordinationPending: Boolean(source.coordDir && activeGroups.has(pathKey(source.coordDir)))
    });
  }

  for (const sourceRoot of coordinationRoots) {
    if (activeGroups.has(pathKey(sourceRoot))) continue;
    const destinationRootForGroup = coordMap.get(pathKey(sourceRoot));
    let files;
    try { files = await walkFiles(sourceRoot); }
    catch (error) { report.copyErrors.push({ source: sourceRoot, message: error.message }); continue; }
    for (const sourceFile of files) {
      const rel = relative(sourceRoot, sourceFile);
      const destination = join(destinationRootForGroup, rel);
      try {
        const [before, raw] = await Promise.all([stat(sourceFile), readFile(sourceFile)]);
        let buffer = raw;
        if (rel.startsWith(`agents${sep}`) && rel.toLowerCase().endsWith(".json")) {
          try {
            const record = JSON.parse(raw.toString("utf8"));
            record.coordinationRoot = destinationRootForGroup;
            if (record.session && migratedSessionKeys.has(pathKey(record.session))) record.session = sessionMap.get(pathKey(record.session));
            buffer = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
          } catch { /* preserve malformed agent data for manual recovery */ }
        }
        const after = await stat(sourceFile);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          report.copyErrors.push({ source: sourceFile, message: "Changed during copy; skipped." });
          continue;
        }
        const result = await writeVerified(destination, buffer, sha256(buffer), report.conflicts);
        if (result === "copied") report.copiedCoordinationFiles += 1;
        else if (result === "unchanged") report.unchangedCoordinationFiles += 1;
      } catch (error) {
        report.copyErrors.push({ source: sourceFile, destination, message: error?.message || String(error) });
      }
    }
  }

  const manifestPath = join(destinationRoot, "migration-manifest.json");
  let migratedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (previous.schemaVersion === 1 && previous.destination === destinationRoot && previous.migratedAt) migratedAt = previous.migratedAt;
  } catch { /* first migration or an unreadable old manifest */ }
  report.sessionMappings.sort((a, b) => a.source.localeCompare(b.source));
  const manifest = {
    schemaVersion: 1,
    migratedAt,
    destination: destinationRoot,
    drives: report.drives,
    directoriesVisited: report.directoriesVisited,
    watchRoots: report.watchRoots,
    sessionMappings: report.sessionMappings,
    coordinationRoots: report.coordinationRoots,
    skippedActiveSessions: report.skippedActiveSessions,
    inaccessibleCount: report.inaccessibleCount,
    inaccessible: report.inaccessible,
    errors: report.errors,
    conflicts: report.conflicts,
    copyErrors: report.copyErrors
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestResult = await updateMigrationManifest(manifestPath, manifestBuffer, sha256(manifestBuffer), destinationRoot, report.conflicts);
  report.manifest = manifestPath;
  report.manifestStatus = manifestResult;
  return report;
}

export function formatMigrationReport(report, { copied = false } = {}) {
  const active = report.coordinationRoots.filter((entry) => entry.activeAgents.length);
  const lines = [
    `${copied ? "Migration copy" : "Migration dry run"} · ${report.destination}`,
    `Found ${report.watchRoots.length} legacy roots, ${report.sessionCount} session files, and ${report.coordinationRoots.length} coordination directories.`,
    `Scanned ${report.directoriesVisited} directories; ${report.inaccessibleCount} inaccessible.`
  ];
  if (copied) lines.push(`Copied ${report.copiedSessions} sessions and ${report.copiedCoordinationFiles} coordination files; already present ${report.unchangedSessions} sessions and ${report.unchangedCoordinationFiles} coordination files.`);
  if (active.length) lines.push(`Skipped ${active.length} active coordination directories: ${active.map((entry) => `${entry.source} (${entry.activeAgents.map((agent) => agent.agentId).join(", ")})`).join("; ")}`);
  if (report.skippedActiveSessions.length) lines.push(`Skipped ${report.skippedActiveSessions.length} active session files: ${report.skippedActiveSessions.map((entry) => `${entry.agentId} at ${entry.source}`).join("; ")}`);
  if (report.conflicts.length) lines.push(`Conflicts: ${report.conflicts.length}; existing central files were left untouched.`);
  if (report.copyErrors.length) lines.push(`Copy errors: ${report.copyErrors.length}; see migration manifest/report.`);
  if (report.errors.length) lines.push(`Session files needing review (invalid, unreadable, or changing): ${report.errors.length}.`);
  if (report.manifest) lines.push(`Manifest: ${report.manifest}`);
  return lines.join("\n");
}
