import assert from "node:assert/strict";
import { resolveWorkspacePath } from "../src/workspace-paths.js";

const root = process.platform === "win32" ? "C:\\workspace\\project" : "/workspace/project";
const parent = process.platform === "win32" ? "C:\\workspace\\shared.txt" : "/workspace/shared.txt";
assert.equal(resolveWorkspacePath(root, "src/index.js", { permission: "yolo", agentRole: "worker" }), process.platform === "win32" ? "C:\\workspace\\project\\src\\index.js" : "/workspace/project/src/index.js");
assert.throws(() => resolveWorkspacePath(root, "../shared.txt", { permission: "yolo", agentRole: "worker" }), /Path escapes workspace/);
assert.equal(resolveWorkspacePath(root, "../shared.txt", { permission: "yolo", agentRole: "coordinator" }), parent);
assert.throws(() => resolveWorkspacePath(root, "../shared.txt", { permission: "full", agentRole: "coordinator" }), /Path escapes workspace/);
console.log("Workspace path permission checks passed.");
