import { isAbsolute, relative, resolve } from "node:path";

export function resolveWorkspacePath(rootPath, inputPath, { permission, agentRole } = {}) {
  const root = resolve(rootPath);
  const localPath = inputPath === "/" || inputPath === "\\" ? "." : inputPath;
  const target = resolve(root, localPath || ".");
  const rel = relative(root, target);
  const outside = rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel);
  const coordinatorYolo = permission === "yolo" && agentRole === "coordinator";
  if (outside && !coordinatorYolo) throw new Error("Path escapes workspace.");
  return target;
}
