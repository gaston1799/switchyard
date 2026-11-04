const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolve, relative, isAbsolute, dirname } = require("node:path");
const { readFile, realpath, stat } = require("node:fs/promises");
const execute = promisify(execFile);

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
}

async function reviewFile(workspace, file) {
  const root = resolve(workspace);
  const target = resolve(root, file);
  if (!contained(root, target)) return { path: file, error: "File is outside this workspace." };
  const path = relative(root, target).replaceAll("\\", "/");
  const git = async args => (await execute("git", ["--literal-pathspecs", "-C", root, ...args], {
    encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 5000, windowsHide: true,
  })).stdout;
  try {
    const canonicalRoot = await realpath(root);
    let ancestor = target;
    while (true) {
      try {
        if (!contained(canonicalRoot, await realpath(ancestor))) throw new Error("File points outside this workspace.");
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || ancestor === root) throw error;
        ancestor = dirname(ancestor);
      }
    }
    const numstat = await git(["diff", "--no-ext-diff", "--no-textconv", "--relative", "--numstat", "HEAD", "--", path]);
    const match = numstat.match(/^(\d+|-)\t(\d+|-)\t/);
    if (match) {
      const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--relative", "--no-color", "HEAD", "--", path]);
      return { path: file, added: match[1] === "-" ? null : Number(match[1]), deleted: match[2] === "-" ? null : Number(match[2]), diff };
    }
    const tracked = await git(["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false);
    if (tracked) return { path: file, added: 0, deleted: 0, diff: "No current changes compared with HEAD." };
    // Never follow an untracked symlink outside the workspace while previewing it.
    if (!contained(await realpath(root), await realpath(target))) throw new Error("File points outside this workspace.");
    const info = await stat(target);
    if (!info.isFile() || info.size > 512 * 1024) throw new Error("Preview unavailable for directories or files larger than 512 KB.");
    const bytes = await readFile(target);
    if (bytes.includes(0)) return { path: file, added: null, deleted: null, diff: "New binary file." };
    const text = bytes.toString("utf8");
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    return { path: file, added: lines.length, deleted: 0, diff: "New untracked file\n" + lines.map(line => "+" + line).join("\n") };
  } catch (error) {
    return { path: file, error: error.message.startsWith("Command failed") ? "Git diff unavailable for this file." : error.message };
  }
}

async function reviewSessionFiles(session) {
  const files = [...new Set((session.touchedFiles || []).filter(file => typeof file === "string"))].slice(0, 100);
  const reviews = [];
  // Bound process creation even for sessions with many files.
  for (let i = 0; i < files.length; i += 4) {
    reviews.push(...await Promise.all(files.slice(i, i + 4).map(file => reviewFile(session.workspace, file))));
  }
  return { baseline: "Current working tree compared with HEAD; may include earlier edits.", files: reviews };
}

module.exports = { reviewFile, reviewSessionFiles };
