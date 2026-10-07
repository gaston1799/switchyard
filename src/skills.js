// DeepSeek skills system — Codex-style skills for dsw.
//
// Storage: ~/.deepseek/skills/<name>/SKILL.md with `name` + `description`
// frontmatter, mirroring ~/.codex/skills. Discovery precedence (first match
// wins per skill name):
//   --skill-root flag(s) > DEEPSEEK_SKILLS_DIR env > ~/.deepseek/skills
//   > ~/.codex/skills (fallback, read-only) > workspace .deepseek-watch/skills
//
// The skills index injected into the system prompt carries
// { title, description, path, source, enabled } per skill; `dsw skill doctor`
// reports malformed frontmatter and shadowed duplicates.
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STANDALONE = typeof __SWITCHYARD_STANDALONE__ !== "undefined" && __SWITCHYARD_STANDALONE__;

// Skills ship beside SEA executables, and beside the source package in dev/npm installs.
export function bundledSkillsRoot() {
  return STANDALONE
    ? join(dirname(process.execPath), "skills")
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export function deepseekSkillsRoot() {
  return join(homedir(), ".deepseek", "skills");
}

export function codexSkillsRoot() {
  return join(homedir(), ".codex", "skills");
}

export function workspaceSkillsRoot(cwd = process.cwd()) {
  return resolve(cwd, ".deepseek-watch", "skills");
}

// Ordered (highest precedence first) skill roots with their source labels.
export function skillRootsWithSources(opts = {}) {
  const pairs = [
    ...(opts.skillRoots || []).map((root) => ({ root, source: "flag" })),
    ...(process.env.DEEPSEEK_SKILLS_DIR
      ? process.env.DEEPSEEK_SKILLS_DIR.split(delimiter).map((root) => ({ root, source: "env" }))
      : []),
    { root: deepseekSkillsRoot(), source: "deepseek" },
    { root: codexSkillsRoot(), source: "codex" },
    { root: workspaceSkillsRoot(), source: "workspace" },
    { root: bundledSkillsRoot(), source: "bundled" }
  ];
  const seen = new Set();
  const result = [];
  for (const { root, source } of pairs) {
    if (!root) continue;
    const resolved = resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push({ root: resolved, source });
  }
  return result;
}

export function defaultSkillRoots(opts = {}) {
  return skillRootsWithSources(opts).map(({ root }) => root);
}

// The canonical writable DeepSeek skills root for install/create/remove/sync:
// --skill-root flag wins, then DEEPSEEK_SKILLS_DIR, then ~/.deepseek/skills.
export function canonicalSkillRoot(opts = {}) {
  if (opts.skillRoots && opts.skillRoots.length) return resolve(opts.skillRoots[0]);
  const envRoot = (process.env.DEEPSEEK_SKILLS_DIR || "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean)[0];
  if (envRoot) return resolve(envRoot);
  return deepseekSkillsRoot();
}

// Parse `name` + `description` from a SKILL.md frontmatter block. `valid` is
// false when the document has no well-formed leading frontmatter (the folder
// name is used as a fallback so discovery never crashes on odd files).
export function parseSkillFrontmatter(markdown, fallbackName) {
  const text = String(markdown || "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = { name: fallbackName, description: "", valid: Boolean(match) };
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) meta.name = value;
    if (key === "description" && value) meta.description = value;
  }
  return meta;
}

const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidSkillName(name) {
  return SKILL_NAME_RE.test(String(name || ""));
}

// Discover skills across all roots. The first root in precedence order that
// provides a given skill name wins; later duplicates are shadowed.
export async function discoverSkills(opts = {}) {
  const roots = skillRootsWithSources(opts);
  const skills = [];
  const seenPaths = new Set();
  const byName = new Map();

  async function addSkill({ root, source, folder, skillFile }) {
    const pathKey = `${folder}\0${skillFile}`;
    if (seenPaths.has(pathKey)) return;
    seenPaths.add(pathKey);

    let text;
    try {
      text = await readFile(skillFile, "utf8");
    } catch {
      return;
    }
    const meta = parseSkillFrontmatter(text, folder);
    if (byName.has(meta.name)) return; // shadowed by a higher-precedence root
    byName.set(meta.name, true);
    skills.push({
      name: meta.name,
      title: meta.name,
      folder,
      description: meta.description,
      root,
      source,
      path: skillFile,
      enabled: meta.valid
    });
  }

  async function scanRoot(root, source, includeHiddenGroups = true) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) {
        if (includeHiddenGroups) await scanRoot(join(root, entry.name), source, false);
        continue;
      }
      await addSkill({
        root,
        source,
        folder: entry.name,
        skillFile: join(root, entry.name, "SKILL.md")
      });
    }
  }

  for (const { root, source } of roots) {
    await scanRoot(root, source);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export async function resolveSkill(opts, spec) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("skill name or path must be non-empty.");

  const direct = resolve(raw);
  const candidates = [direct, join(direct, "SKILL.md")];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        const text = await readFile(candidate, "utf8");
        const meta = parseSkillFrontmatter(text, raw);
        return { ...meta, path: candidate, content: text };
      }
    } catch {
      // keep probing
    }
  }

  const skills = await discoverSkills(opts);
  const found = skills.find((skill) => skill.name === raw || skill.folder === raw);
  if (!found) throw new Error(`Skill not found: ${raw}. Use --list-skills or list_skills.`);
  const content = await readFile(found.path, "utf8");
  return { name: found.name, description: found.description, path: found.path, content };
}

// The skills index injected into the system prompt. With explicit --skill
// flags the full content is embedded; otherwise a lightweight index carrying
// { title, description, path, source, enabled } is injected.
export async function renderLoadedSkills(opts) {
  if (opts.skills?.length) {
    const loaded = [];
    for (const spec of opts.skills) {
      const skill = await resolveSkill(opts, spec);
      loaded.push(
        [
          `## Skill: ${skill.name}`,
          `Path: ${skill.path}`,
          "",
          skill.content.trim()
        ].join("\n")
      );
    }
    return ["", "---", "", "Loaded local skills:", "", ...loaded].join("\n");
  }

  const skills = await discoverSkills(opts);
  if (!skills.length) return "";
  const index = skills.map((skill) => {
    const desc = skill.description ? ` — ${skill.description}` : "";
    const flags = `[source: ${skill.source}, enabled: ${skill.enabled ? "true" : "false"}]`;
    return `- ${skill.name}${desc} ${flags}\n  ${skill.path}`;
  });
  return [
    "",
    "---",
    "",
    "Available local skills (call the read_skill tool with the name to load one now, or start a session with --skill <name> to inject it):",
    "",
    ...index
  ].join("\n");
}

export function formatSkillList(skills) {
  if (!skills.length) return "No skills found.";
  return skills
    .map((skill) => {
      const desc = skill.description ? ` - ${skill.description}` : "";
      const flags = `[${skill.source}${skill.enabled ? "" : ", disabled"}]`;
      return `${skill.name}${desc} ${flags}\n  ${skill.path}`;
    })
    .join("\n");
}

// ---------- install / create / remove / sync ----------

// Read the skill folders directly under a root (each folder must contain a
// SKILL.md). Hidden groups (e.g. .system) are scanned too, matching discovery.
async function readSkillDirs(root, includeHiddenGroups = true) {
  const out = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) {
      if (includeHiddenGroups) out.push(...(await readSkillDirs(join(root, entry.name), false)));
      continue;
    }
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(text, entry.name);
    out.push({ name: meta.name || entry.name, dir, file });
  }
  return out;
}

// Collect installable skills from a directory: a dir with its own SKILL.md is
// one skill; otherwise any direct subfolder holding a SKILL.md is a skill.
// A conventional nested `skills/` folder is scanned too (GitHub repo layout).
async function collectSkillsFromDir(dir) {
  const out = [];
  const seen = new Set();

  async function scan(current) {
    if (seen.has(current)) return;
    seen.add(current);
    const file = join(current, "SKILL.md");
    if (existsSync(file)) {
      const text = await readFile(file, "utf8");
      const meta = parseSkillFrontmatter(text, basename(current));
      const name = meta.name || basename(current);
      if (isValidSkillName(name)) out.push({ name, dir: current, file });
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await scan(join(current, entry.name));
    }
  }

  await scan(dir);
  const nested = join(dir, "skills");
  if (existsSync(nested)) await scan(nested);
  return out;
}

function isRepoSpec(spec) {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) ||
    /^https?:\/\/(www\.)?github\.com\//.test(spec)
  );
}

async function installSourcesFromRepo(raw) {
  const cloneDir = join(tmpdir(), `dsw-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const url = /^https?:\/\//.test(raw) ? raw : `https://github.com/${raw}.git`;
  const result = spawnSync("git", ["clone", "--depth", "1", url, cloneDir], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed for ${raw}: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  try {
    const skills = await collectSkillsFromDir(cloneDir);
    if (!skills.length) {
      throw new Error(`No skills found in repo ${raw} (looked for <root>/SKILL.md and <root>/*/SKILL.md).`);
    }
    return skills;
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}

export async function skillCreate(opts, name) {
  const skillName = String(name || "").trim();
  if (!isValidSkillName(skillName)) {
    throw new Error("Skill name must start with a letter or digit and contain only letters, digits, . _ -");
  }
  const root = canonicalSkillRoot(opts);
  const dir = join(root, skillName);
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) throw new Error(`Skill already exists: ${file}`);
  const description = String(opts.description || "").trim();
  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    `---\nname: ${skillName}\ndescription: ${description || "Describe what this skill does."}\n---\n\n# ${skillName}\n\n`,
    "utf8"
  );
  try {
    await chmod(file, 0o644);
  } catch {
    // Windows may ignore POSIX modes.
  }
  return `Created skill: ${file}`;
}

export async function skillInstall(opts, spec) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("skill name, path, or repo is required.");

  let sources;
  const direct = resolve(raw);
  try {
    const info = await stat(direct);
    if (info.isDirectory()) {
      sources = await collectSkillsFromDir(direct);
      if (!sources.length) throw new Error(`No SKILL.md found in ${direct}`);
    } else if (info.isFile()) {
      const text = await readFile(direct, "utf8");
      const meta = parseSkillFrontmatter(text, basename(direct, ".md"));
      const name = meta.name || basename(dirname(direct)) || "skill";
      if (!isValidSkillName(name)) throw new Error(`Invalid skill name from path: ${name}`);
      sources = [{ name, dir: dirname(direct), file: direct }];
    } else {
      throw new Error(`Not a directory or file: ${direct}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("No SKILL.md")) throw error;
    if (isRepoSpec(raw)) {
      sources = await installSourcesFromRepo(raw);
    } else {
      const skill = await resolveSkill(opts, raw);
      sources = [{ name: skill.name, dir: dirname(skill.path), file: skill.path }];
    }
  }

  const target = canonicalSkillRoot(opts);
  await mkdir(target, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const source of sources) {
    if (!isValidSkillName(source.name)) {
      skipped.push(`${source.name} (invalid name)`);
      continue;
    }
    const targetDir = join(target, source.name);
    if (resolve(source.dir) === resolve(targetDir)) {
      // Already lives in the canonical root — nothing to copy.
      installed.push(targetDir);
      continue;
    }
    if (existsSync(targetDir) && !opts.force) {
      skipped.push(`${source.name} (exists)`);
      continue;
    }
    await cp(source.dir, targetDir, { recursive: true, force: true });
    installed.push(targetDir);
  }
  if (!installed.length) {
    throw new Error(`Nothing installed to ${target}: ${skipped.join(", ") || "no skills found"}`);
  }
  return [
    `Installed ${installed.length} skill(s) to ${target}:`,
    ...installed.map((dir) => `  - ${dir}`),
    skipped.length ? `Skipped: ${skipped.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

// Model-facing installation is intentionally limited to Switchyard's shipped
// catalog. Arbitrary paths and GitHub repositories remain explicit CLI actions.
export async function installBundledSkill(opts, name) {
  const requested = String(name || "").trim();
  if (!isValidSkillName(requested)) throw new Error(`Invalid skill name: ${requested}`);
  const root = bundledSkillsRoot();
  const entries = await readSkillDirs(root);
  const skill = entries.find((entry) => entry.name === requested || basename(entry.dir) === requested);
  if (!skill) {
    const choices = entries.map((entry) => entry.name).sort().join(", ") || "(none bundled)";
    throw new Error(`No bundled skill named ${requested}. Available bundled skills: ${choices}`);
  }
  return skillInstall(opts, skill.dir);
}

export async function skillRemove(opts, name) {
  const skillName = String(name || "").trim();
  if (!isValidSkillName(skillName)) throw new Error(`Invalid skill name: ${skillName}`);
  const root = canonicalSkillRoot(opts);
  const dir = join(root, skillName);
  if (!existsSync(dir)) throw new Error(`Skill not found in ${root}: ${skillName}`);
  await rm(dir, { recursive: true, force: true });
  return `Removed ${skillName} from ${root}`;
}

async function syncCopy(fromRoot, toRoot, opts, fromLabel, toLabel) {
  await mkdir(toRoot, { recursive: true });
  const skills = await readSkillDirs(fromRoot);
  if (!skills.length) return `No skills found in ${fromLabel} (${fromRoot}).`;
  const copied = [];
  const skipped = [];
  for (const skill of skills) {
    if (!isValidSkillName(skill.name)) {
      skipped.push(`${skill.name} (invalid name)`);
      continue;
    }
    const targetDir = join(toRoot, skill.name);
    if (existsSync(targetDir) && !opts.force) {
      skipped.push(skill.name);
      continue;
    }
    await cp(skill.dir, targetDir, { recursive: true, force: true });
    copied.push(skill.name);
  }
  return `${fromLabel} → ${toLabel}: copied ${copied.length}${copied.length ? ` (${copied.join(", ")})` : ""}${
    skipped.length ? `, skipped ${skipped.length} (${skipped.join(", ")})` : ""
  }`;
}

export async function skillSync(opts) {
  const target = canonicalSkillRoot(opts);
  const workspace = workspaceSkillsRoot();
  if (opts.migrateFromCodex) {
    const migrated = await syncCopy(codexSkillsRoot(), target, opts, "~/.codex/skills", "DeepSeek root");
    return `${migrated}\n~/.codex/skills was not modified (read-only migration).`;
  }
  if (opts.fromWorkspace && opts.toWorkspace) {
    throw new Error("Use --from-workspace or --to-workspace, not both (default syncs both ways).");
  }
  const messages = [];
  if (!opts.fromWorkspace && !opts.toWorkspace) {
    messages.push(await syncCopy(workspace, target, opts, "workspace", "DeepSeek root"));
    messages.push(await syncCopy(target, workspace, opts, "DeepSeek root", "workspace"));
  } else if (opts.fromWorkspace) {
    messages.push(await syncCopy(workspace, target, opts, "workspace", "DeepSeek root"));
  } else {
    messages.push(await syncCopy(target, workspace, opts, "DeepSeek root", "workspace"));
  }
  return messages.join("\n");
}

// Broken/duplicate detection: malformed frontmatter and skills shadowed by a
// higher-precedence root. Returns { report, issues }.
export async function skillDoctorReport(opts) {
  const roots = skillRootsWithSources(opts);
  const lines = ["DeepSeek skills doctor", ""];
  const all = [];
  for (const { root, source } of roots) {
    const dirs = await readSkillDirs(root);
    lines.push(`${source.padEnd(9)} ${root} (${dirs.length} skill(s))`);
    for (const skill of dirs) {
      const file = join(skill.dir, "SKILL.md");
      let valid = false;
      let description = "";
      try {
        const meta = parseSkillFrontmatter(await readFile(file, "utf8"), skill.name);
        valid = meta.valid;
        description = meta.description;
      } catch {
        valid = false;
      }
      all.push({ name: skill.name, source, root, dir: skill.dir, valid, description });
    }
  }
  lines.push("");
  lines.push(`${all.length} skill(s) discovered across ${roots.length} root(s).`);

  const issues = [];
  const byName = new Map();
  for (const skill of all) {
    if (!byName.has(skill.name)) byName.set(skill.name, []);
    byName.get(skill.name).push(skill);
  }
  for (const [name, entries] of byName) {
    if (entries.length > 1) {
      const active = entries[0];
      const shadowed = entries.slice(1);
      issues.push(
        `duplicate "${name}" in ${entries.length} roots — using ${active.source} (${active.dir}); shadowed: ${shadowed
          .map((entry) => `${entry.source} (${entry.dir})`)
          .join(", ")}`
      );
    }
  }
  for (const skill of all) {
    if (!skill.valid) {
      issues.push(`broken "${skill.name}" (${skill.source}): malformed/missing frontmatter in ${join(skill.dir, "SKILL.md")}`);
    } else if (!skill.description) {
      issues.push(`warning "${skill.name}" (${skill.source}): no description in frontmatter`);
    }
  }

  if (!issues.length) {
    lines.push("No issues found — all skills have valid frontmatter and no duplicates.");
  } else {
    lines.push(`${issues.length} issue(s) found:`);
    for (const issue of issues) lines.push(`  - ${issue}`);
  }
  return { report: lines.join("\n"), issues };
}

export function skillUsage() {
  return `dsw skill — manage DeepSeek skills (Codex-style)

Storage:
  ~/.deepseek/skills/<name>/SKILL.md        canonical DeepSeek root
  Discovery precedence (first match wins):
    --skill-root flag > DEEPSEEK_SKILLS_DIR > ~/.deepseek/skills
    > ~/.codex/skills (fallback, read-only) > workspace .deepseek-watch/skills

Commands:
  dsw skill list [--json]                  List discovered skills
  dsw skill read <name>                    Print a skill's SKILL.md
  dsw skill install <name|repo|path>       Install a skill into the DeepSeek root
  dsw skill create <name> [--description <text>]
                                           Create a new skill
  dsw skill remove <name>                  Remove a skill from the DeepSeek root
  dsw skill sync [--from-workspace|--to-workspace] [--force]
                                           Sync workspace <-> global skills
  dsw skill sync --migrate-from-codex      Copy ~/.codex/skills/* into the DeepSeek
                                           root (never mutates ~/.codex/skills)
  dsw skill doctor                         Check for broken/duplicate skills

Options:
  --skill-root <dir>       Override the canonical DeepSeek skills root.
  --force                  Overwrite existing skills during install/sync.
  --json                   Machine-readable output for list.
`;
}

function skillCliOpts(args) {
  const opts = {
    skillRoots: [],
    force: false,
    json: false,
    description: "",
    migrateFromCodex: false,
    fromWorkspace: false,
    toWorkspace: false,
    positional: []
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (i >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[i];
    };
    if (arg === "--skill-root") opts.skillRoots.push(next());
    else if (arg === "--force") opts.force = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--description") opts.description = next();
    else if (arg === "--migrate-from-codex") opts.migrateFromCodex = true;
    else if (arg === "--from-workspace") opts.fromWorkspace = true;
    else if (arg === "--to-workspace") opts.toWorkspace = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown skill option: ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

export async function runSkillCommand(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(skillUsage());
    return;
  }
  const opts = skillCliOpts(rest);

  if (command === "list") {
    const skills = await discoverSkills(opts);
    process.stdout.write(`${opts.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`);
    return;
  }
  if (command === "read") {
    const name = opts.positional[0];
    if (!name) throw new Error("Usage: dsw skill read <name>");
    const skill = await resolveSkill(opts, name);
    process.stdout.write(`# ${skill.name}${skill.description ? ` — ${skill.description}` : ""}\n\n${skill.content.trim()}\n`);
    return;
  }
  if (command === "create") {
    const name = opts.positional[0];
    if (!name) throw new Error("Usage: dsw skill create <name> [--description <text>]");
    process.stdout.write(`${await skillCreate(opts, name)}\n`);
    return;
  }
  if (command === "install") {
    const spec = opts.positional[0];
    if (!spec) throw new Error("Usage: dsw skill install <name|repo|path> [--force]");
    process.stdout.write(`${await skillInstall(opts, spec)}\n`);
    return;
  }
  if (command === "remove") {
    const name = opts.positional[0];
    if (!name) throw new Error("Usage: dsw skill remove <name>");
    process.stdout.write(`${await skillRemove(opts, name)}\n`);
    return;
  }
  if (command === "sync") {
    process.stdout.write(`${await skillSync(opts)}\n`);
    return;
  }
  if (command === "doctor") {
    const { report, issues } = await skillDoctorReport(opts);
    process.stdout.write(`${report}\n`);
    if (issues.length) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown skill command: ${command}. Use "dsw skill help".`);
}
