#!/usr/bin/env node
// Self-test for the DeepSeek skills system (src/skills.js):
//   - frontmatter parsing + malformed SKILL.md handling
//   - discovery precedence (flag > env > user roots > workspace > bundled)
//   - install / create / remove / sync round-trip
//   - migrate-from-codex (never mutates ~/.codex/skills)
//   - a skill added mid-session is picked up on the next discovery (no cache)
//   - `dsw skill doctor` broken/duplicate detection + CLI smoke tests
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as skills from "../src/skills.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI = join(REPO, "src", "deepseek-watch.js");

// Isolate home + workspace BEFORE calling any skills function: os.homedir()
// reads USERPROFILE/HOME at call time, and the workspace-relative root resolves
// against process.cwd().
const tmpBase = await mkdtemp(join(tmpdir(), "dsw-skills-test-"));
const fakeHome = join(tmpBase, "home");
const workspace = join(tmpBase, "workspace");
const flagRoot = join(tmpBase, "flag-root");
const envRoot = join(tmpBase, "env-root");
const targetRoot = join(tmpBase, "target-root");
await mkdir(fakeHome, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(flagRoot, { recursive: true });
await mkdir(envRoot, { recursive: true });
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
delete process.env.DEEPSEEK_SKILLS_DIR;
process.chdir(workspace);

const deepseekRoot = () => join(fakeHome, ".deepseek", "skills");
const codexRoot = () => join(fakeHome, ".codex", "skills");
const wsRoot = () => join(workspace, ".deepseek-watch", "skills");

const writeSkill = async (root, name, frontmatter, body = "# body\n") => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `${frontmatter}\n${body}`, "utf8");
  return join(dir, "SKILL.md");
};

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
};

// ---------- 1. frontmatter parsing ----------
check("frontmatter: valid name+description", () => {
  const meta = skills.parseSkillFrontmatter('---\nname: demo\ndescription: Does things\n---\n# demo\n', "folder");
  assert.equal(meta.name, "demo");
  assert.equal(meta.description, "Does things");
  assert.equal(meta.valid, true);
});
check("frontmatter: quoted values", () => {
  const meta = skills.parseSkillFrontmatter('---\nname: "quoted-skill"\ndescription: \'Has quotes\'\n---\n', "folder");
  assert.equal(meta.name, "quoted-skill");
  assert.equal(meta.description, "Has quotes");
  assert.equal(meta.valid, true);
});
check("frontmatter: missing block falls back to folder name, valid=false", () => {
  const meta = skills.parseSkillFrontmatter("# no frontmatter here\n", "folder-fallback");
  assert.equal(meta.name, "folder-fallback");
  assert.equal(meta.valid, false);
});
check("frontmatter: unterminated block handled (valid=false)", () => {
  const meta = skills.parseSkillFrontmatter("---\nname: broken\nno closing marker", "folder-broken");
  assert.equal(meta.name, "folder-broken");
  assert.equal(meta.valid, false);
});

// ---------- 2. precedence ----------
await writeSkill(deepseekRoot(), "alpha", "---\nname: alpha\ndescription: deepseek-root\n---");
await writeSkill(codexRoot(), "alpha", "---\nname: alpha\ndescription: codex-root\n---");
await writeSkill(codexRoot(), "beta", "---\nname: beta\ndescription: codex-only\n---");
await writeSkill(wsRoot(), "gamma", "---\nname: gamma\ndescription: workspace-only\n---");
await writeSkill(wsRoot(), "alpha", "---\nname: alpha\ndescription: workspace-shadow\n---");

await checkAsync("precedence: deepseek root beats codex and workspace for same name", async () => {
  const list = await skills.discoverSkills({});
  const alpha = list.filter((skill) => skill.name === "alpha");
  assert.equal(alpha.length, 1, `expected 1 alpha, got ${alpha.length}`);
  assert.equal(alpha[0].source, "deepseek");
  assert.equal(alpha[0].description, "deepseek-root");
  assert.ok(list.some((skill) => skill.name === "beta" && skill.source === "codex"), "codex fallback works");
  assert.ok(list.some((skill) => skill.name === "gamma" && skill.source === "workspace"), "workspace fallback works");
});
await checkAsync("precedence: --skill-root flag beats deepseek root", async () => {
  await writeSkill(flagRoot, "alpha", "---\nname: alpha\ndescription: flag-root\n---");
  const list = await skills.discoverSkills({ skillRoots: [flagRoot] });
  const alpha = list.find((skill) => skill.name === "alpha");
  assert.equal(alpha.source, "flag");
  assert.equal(alpha.description, "flag-root");
});
await checkAsync("precedence: DEEPSEEK_SKILLS_DIR beats deepseek root", async () => {
  await writeSkill(envRoot, "alpha", "---\nname: alpha\ndescription: env-root\n---");
  process.env.DEEPSEEK_SKILLS_DIR = envRoot;
  const list = await skills.discoverSkills({});
  const alpha = list.find((skill) => skill.name === "alpha");
  assert.equal(alpha.source, "env");
  delete process.env.DEEPSEEK_SKILLS_DIR;
});
await checkAsync("bundled catalog: repo skills are discoverable even when not installed globally", async () => {
  const list = await skills.discoverSkills({});
  const found = list.find((skill) => skill.name === "dsw-bounded-analysis");
  assert.ok(found, "expected dsw-bounded-analysis in bundled skills catalog");
  assert.equal(found.source, "bundled");
  assert.match((await skills.resolveSkill({}, found.name)).content, /bounded/i);
});

// ---------- 3. malformed handling ----------
await writeSkill(deepseekRoot(), "bad", "---\nname: bad\n(unterminated");
await checkAsync("malformed SKILL.md is discovered but marked disabled", async () => {
  const list = await skills.discoverSkills({});
  const bad = list.find((skill) => skill.name === "bad");
  assert.ok(bad, "bad skill should still be listed");
  assert.equal(bad.enabled, false);
});

// ---------- 4. install / create / remove round-trip ----------
await checkAsync("create: writes ~/.deepseek/skills/<name>/SKILL.md with frontmatter", async () => {
  await skills.skillCreate({ skillRoots: [targetRoot] }, "hello");
  const file = join(targetRoot, "hello", "SKILL.md");
  assert.ok(existsSync(file));
  const text = await readFile(file, "utf8");
  assert.match(text, /^---\nname: hello\ndescription:/);
});
await checkAsync("create: rejects invalid names", async () => {
  await assert.rejects(() => skills.skillCreate({ skillRoots: [targetRoot] }, "../evil"), /Skill name/);
});
await checkAsync("install: resolves a workspace skill by name into the target root", async () => {
  const result = await skills.skillInstall({ skillRoots: [targetRoot] }, "gamma");
  const targetFile = join(targetRoot, "gamma", "SKILL.md");
  assert.ok(existsSync(targetFile), result);
  const text = await readFile(targetFile, "utf8");
  assert.match(text, /workspace-only/);
});
await checkAsync("install: model-facing bundled installer persists a catalog skill", async () => {
  const result = await skills.installBundledSkill({ skillRoots: [targetRoot] }, "dsw-bounded-analysis");
  assert.match(result, /Installed 1 skill/);
  assert.ok(existsSync(join(targetRoot, "dsw-bounded-analysis", "SKILL.md")));
});
await checkAsync("install: bundled installer rejects names outside the shipped catalog", async () => {
  await assert.rejects(() => skills.installBundledSkill({ skillRoots: [targetRoot] }, "not-a-bundled-skill"), /No bundled skill named/);
});
await checkAsync("install: re-installing an existing skill is idempotent", async () => {
  const result = await skills.skillInstall({ skillRoots: [targetRoot] }, "gamma");
  assert.match(result, /Installed/);
  assert.ok(existsSync(join(targetRoot, "gamma", "SKILL.md")));
});
await checkAsync("install: --force overwrites an existing skill", async () => {
  await skills.skillInstall({ skillRoots: [targetRoot], force: true }, "gamma");
  assert.ok(existsSync(join(targetRoot, "gamma", "SKILL.md")));
});
await checkAsync("install: copies a skill from a local path", async () => {
  const src = join(tmpBase, "path-src");
  const file = await writeSkill(src, "from-path", "---\nname: from-path\ndescription: path source\n---");
  const result = await skills.skillInstall({ skillRoots: [targetRoot] }, file);
  assert.ok(existsSync(join(targetRoot, "from-path", "SKILL.md")), result);
});
await checkAsync("remove: deletes from the canonical root only", async () => {
  await skills.skillRemove({ skillRoots: [targetRoot] }, "hello");
  assert.ok(!existsSync(join(targetRoot, "hello")), "hello should be removed");
  await assert.rejects(() => skills.skillRemove({ skillRoots: [targetRoot] }, "hello"), /not found/);
});

// ---------- 5. sync round-trip ----------
await writeSkill(wsRoot(), "delta", "---\nname: delta\ndescription: sync me\n---");
await checkAsync("sync --from-workspace copies workspace -> global root", async () => {
  await skills.skillSync({ skillRoots: [targetRoot], fromWorkspace: true });
  assert.ok(existsSync(join(targetRoot, "delta", "SKILL.md")));
});
await checkAsync("sync --to-workspace copies global root -> workspace", async () => {
  await skills.skillCreate({ skillRoots: [targetRoot] }, "backwards");
  await skills.skillSync({ skillRoots: [targetRoot], toWorkspace: true });
  assert.ok(existsSync(join(wsRoot(), "backwards", "SKILL.md")));
});
await checkAsync("sync default syncs both ways without overwriting", async () => {
  await writeSkill(wsRoot(), "delta", "---\nname: delta\ndescription: changed in workspace\n---");
  const result = await skills.skillSync({ skillRoots: [targetRoot] });
  assert.match(result, /skipped/); // existing delta not overwritten without --force
});
await checkAsync("sync --force overwrites", async () => {
  const result = await skills.skillSync({ skillRoots: [targetRoot], fromWorkspace: true, force: true });
  const text = await readFile(join(targetRoot, "delta", "SKILL.md"), "utf8");
  assert.match(text, /changed in workspace/);
  assert.match(result, /copied/);
});

// ---------- 6. migrate-from-codex ----------
await writeSkill(codexRoot(), "legacy", "---\nname: legacy\ndescription: legacy codex skill\n---", "# legacy body\n");
await checkAsync("migrate-from-codex copies codex skills without mutating the source", async () => {
  const before = await readFile(join(codexRoot(), "legacy", "SKILL.md"), "utf8");
  await skills.skillSync({ skillRoots: [targetRoot], migrateFromCodex: true });
  assert.ok(existsSync(join(targetRoot, "legacy", "SKILL.md")));
  const migrated = await readFile(join(targetRoot, "legacy", "SKILL.md"), "utf8");
  assert.equal(migrated, before);
  const after = await readFile(join(codexRoot(), "legacy", "SKILL.md"), "utf8");
  assert.equal(after, before, "codex source must be untouched");
});

// ---------- 7. mid-session pickup (no cache) ----------
await checkAsync("mid-session pickup: a skill added after discovery appears on the next run", async () => {
  const before = await skills.discoverSkills({});
  assert.ok(!before.some((skill) => skill.name === "fresh"), "fresh must not exist yet");
  await writeSkill(deepseekRoot(), "fresh", "---\nname: fresh\ndescription: added mid-session\n---");
  const after = await skills.discoverSkills({});
  assert.ok(after.some((skill) => skill.name === "fresh" && skill.source === "deepseek"), "fresh must appear on next discovery");
});

// ---------- 8. doctor ----------
await checkAsync("skill doctor: flags broken frontmatter and shadowed duplicates", async () => {
  const { report, issues } = await skills.skillDoctorReport({});
  assert.ok(issues.some((issue) => /broken/.test(issue) && /bad/.test(issue)), `broken not flagged: ${issues.join(" | ")}`);
  assert.ok(issues.some((issue) => /duplicate/.test(issue) && /alpha/.test(issue)), `duplicate not flagged: ${issues.join(" | ")}`);
  assert.match(report, /DeepSeek skills doctor/);
});
await checkAsync("skill doctor: a clean root contributes no issues", async () => {
  const clean = join(tmpBase, "clean-root");
  await skills.skillCreate({ skillRoots: [clean] }, "tidy");
  const { issues } = await skills.skillDoctorReport({ skillRoots: [clean] });
  assert.ok(!issues.some((issue) => /tidy/.test(issue)), issues.join(" | "));
});

// ---------- 9. CLI smoke ----------
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: process.env, windowsHide: true });

check("CLI: dsw skill list --skill-root shows installed skill", () => {
  const result = cli(["skill", "list", "--skill-root", targetRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /from-path/);
  assert.match(result.stdout, /\[flag/); // source label present
});
check("CLI: dsw skill create writes a skill", () => {
  const result = cli(["skill", "create", "--skill-root", join(tmpBase, "cli-root"), "cli-skill", "--description", "from cli"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(tmpBase, "cli-root", "cli-skill", "SKILL.md")));
});
check("CLI: dsw skill doctor exits 1 when issues exist", () => {
  const result = cli(["skill", "doctor", "--skill-root", targetRoot]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
  assert.match(result.stdout, /issue\(s\) found/);
});
check("CLI: dsw skill help prints usage", () => {
  const result = cli(["skill", "help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dsw skill install/);
});

// ---------- cleanup ----------
process.chdir(tmpdir());
await rm(tmpBase, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL SKILLS TESTS PASSED");
process.exit(failures ? 1 : 0);
