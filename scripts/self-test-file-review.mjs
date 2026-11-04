import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, unlink, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import review from "../src/ui/file-review.cjs";

const scratch = await mkdtemp(join(tmpdir(), "switchyard-review-test-"));
const root = join(scratch, "repo");
await mkdir(root);
const git = args => execFileSync("git", ["-C", root, ...args], { windowsHide: true, stdio: "pipe" });
try {
  git(["init"]);
  await writeFile(join(root, "changed.txt"), "before\n");
  await writeFile(join(root, "deleted.txt"), "gone\n");
  git(["add", "."]);
  git(["-c", "user.name=UI Test", "-c", "user.email=ui-test@example.invalid", "commit", "-m", "fixture"]);
  await writeFile(join(root, "changed.txt"), "after\nextra\n");
  await unlink(join(root, "deleted.txt"));
  await writeFile(join(root, "new[1].txt"), "new file\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  const result = await review.reviewSessionFiles({ workspace: root, touchedFiles: ["changed.txt", "deleted.txt", "new[1].txt", "changed.txt", "binary.bin", "../outside.txt"] });
  assert.equal(result.files.length, 5);
  assert.equal(result.files[0].added, 2);
  assert.equal(result.files[0].deleted, 1);
  assert.match(result.files[0].diff, /\+after/);
  assert.equal(result.files[1].deleted, 1);
  assert.equal(result.files[2].added, 1);
  assert.equal(result.files[3].added, null);
  assert.match(result.files[4].error, /outside/);
  const outside = join(scratch, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "must not be read");
  await symlink(outside, join(root, "link"), "junction");
  assert.match((await review.reviewFile(root, "link/private.txt")).error, /outside/);
  console.log("File review self-test passed: tracked, deleted, new, binary, literal paths, traversal and symlink boundaries.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
