import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyData } from "../src/migration.js";
import { listSessions } from "../src/session-memory.js";

const root = await mkdtemp(join(tmpdir(), "switchyard-migration-test-"));
const source = join(root, "project", ".deepseek-watch");
const sourceSessions = join(source, "sessions");
const sourceCoord = join(source, "coordination");
const destination = join(root, "central-data");
const sourceSessionFile = join(sourceSessions, "session-one.json");
const session = {
  version: 1,
  workspace: join(root, "project"),
  updatedAt: new Date().toISOString(),
  messages: [{ role: "user", content: "hello" }],
  config: { agentId: "worker-one", coordDir: sourceCoord }
};

try {
  await mkdir(sourceSessions, { recursive: true });
  await mkdir(join(sourceCoord, "agents"), { recursive: true });
  await mkdir(join(sourceCoord, "tasks"), { recursive: true });
  await writeFile(sourceSessionFile, `${JSON.stringify(session, null, 2)}\n`);
  await writeFile(join(sourceCoord, "agents", "worker-one.json"), `${JSON.stringify({
    agentId: "worker-one",
    pid: 99999999,
    state: "completed",
    heartbeatAt: new Date().toISOString(),
    workspace: session.workspace,
    coordinationRoot: sourceCoord,
    session: sourceSessionFile
  }, null, 2)}\n`);
  await writeFile(join(sourceCoord, "tasks", "task-one.json"), "{\"id\":\"task-one\"}\n");

  const dryRun = await migrateLegacyData({ watchRoots: [source], dataRoot: destination });
  assert.equal(dryRun.sessionCount, 1);
  assert.equal(dryRun.coordinationRoots.length, 1);
  await assert.rejects(access(destination));

  const copied = await migrateLegacyData({ watchRoots: [source], dataRoot: destination, copy: true });
  assert.equal(copied.copiedSessions, 1);
  assert.equal(copied.copiedCoordinationFiles, 2);
  assert.equal(copied.copyErrors.length, 0);
  assert.equal(copied.conflicts.length, 0);
  const migrated = JSON.parse(await readFile(copied.sessionMappings[0].destination, "utf8"));
  assert.equal(migrated.workspace, session.workspace, "working directory remains the original project path");
  assert.equal(migrated.config.coordDir, copied.coordinationRoots[0].destination);
  const agent = JSON.parse(await readFile(join(copied.coordinationRoots[0].destination, "agents", "worker-one.json"), "utf8"));
  assert.equal(agent.coordinationRoot, copied.coordinationRoots[0].destination);
  assert.equal(agent.session, copied.sessionMappings[0].destination);
  assert.equal(await readFile(sourceSessionFile, "utf8"), `${JSON.stringify(session, null, 2)}\n`, "source session remains untouched");

  const repeat = await migrateLegacyData({ watchRoots: [source], dataRoot: destination, copy: true });
  assert.equal(repeat.copiedSessions, 0);
  assert.equal(repeat.unchangedSessions, 1);
  assert.equal(repeat.copiedCoordinationFiles, 0);
  assert.equal(repeat.unchangedCoordinationFiles, 2);

  const agentPath = join(sourceCoord, "agents", "worker-one.json");
  const activeRecord = JSON.parse(await readFile(agentPath, "utf8"));
  activeRecord.state = "working";
  activeRecord.heartbeatAt = new Date().toISOString();
  await writeFile(agentPath, `${JSON.stringify(activeRecord, null, 2)}\n`);
  const active = await migrateLegacyData({
    watchRoots: [source],
    dataRoot: join(root, "active-central"),
    copy: true,
    isProcessAlive: () => true
  });
  assert.equal(active.coordinationRoots[0].activeAgents.length, 1);
  assert.equal(active.copiedSessions, 0, "active session files are not copied mid-write");
  assert.equal(active.skippedActiveSessions.length, 1);
  assert.equal(active.copiedCoordinationFiles, 0, "active coordination files are not copied mid-write");

  process.env.SWITCHYARD_DATA_DIR = destination;
  const listed = await listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].workspace, session.workspace);
  console.log("Switchyard migration self-test: dry run, copy, path mapping, idempotence, and active-group safety passed.");
} finally {
  delete process.env.SWITCHYARD_DATA_DIR;
  await rm(root, { recursive: true, force: true });
}
