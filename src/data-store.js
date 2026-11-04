import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function switchyardDataRoot() {
  return resolve(process.env.SWITCHYARD_DATA_DIR || join(homedir(), ".switchyard"));
}

export function sessionDirectory() {
  return join(switchyardDataRoot(), "sessions");
}

export function workspaceCoordinationDirectory(workspace = process.cwd()) {
  const canonicalWorkspace = resolve(workspace);
  const key = createHash("sha256").update(canonicalWorkspace.toLowerCase()).digest("hex").slice(0, 16);
  return join(switchyardDataRoot(), "coordination", "workspaces", key);
}
