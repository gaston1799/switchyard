#!/usr/bin/env node
/**
 * build-exe.js
 *
 * Produces standalone Windows executables using Node.js SEA
 * (Single Executable Applications, built into Node >=20).
 *
 * Steps for each binary:
 *   1. esbuild: bundle ESM → CJS (all local imports inlined, node: builtins kept external)
 *   2. node --experimental-sea-config: compile bundle into a .blob
 *   3. Copy node.exe → <name>.exe
 *   4. postject: inject the blob into the exe
 *
 * Output: dist/exe/  switchyard.exe  dsw.exe  d.exe  dsd.exe  dswait.exe
 */

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(ROOT, "dist", "exe");
mkdirSync(DIST, { recursive: true });

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const NODE_EXE = process.execPath;

// Embed the default system prompt so the exe doesn't need the prompts/ dir at runtime.
const systemPrompt = readFileSync(resolve(ROOT, "prompts", "default-system.md"), "utf8");

const ENTRIES = [
  { name: "switchyard",    src: "src/deepseek-watch.js" },
  { name: "dsd",    src: "src/deepseek-detached.js" },
  { name: "dswait", src: "src/wait-for-file.js" },
];

function run(cmd, label) {
  process.stdout.write(`  ▸ ${label}\n`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

for (const { name, src } of ENTRIES) {
  process.stdout.write(`\n◆ ${name}\n`);

  const cjs    = resolve(DIST, `${name}.cjs`);
  const blob   = resolve(DIST, `${name}.blob`);
  const config = resolve(DIST, `${name}-sea.json`);
  const exe    = resolve(DIST, `${name}.exe`);

  // 1. Bundle
  process.stdout.write("  ▸ bundle\n");
  await build({
    entryPoints: [resolve(ROOT, src)],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["node:*"],
    define: {
      __SYSTEM_PROMPT__: JSON.stringify(systemPrompt),
      __UI_APP_DIR__: JSON.stringify(resolve(ROOT, "src", "ui"))
    },
    outfile: cjs
  });

  // 2. SEA config + blob
  writeFileSync(config, JSON.stringify({
    main: cjs,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true
  }));
  run(`node --experimental-sea-config "${config}"`, "sea-config");

  // 3. Copy node.exe as the base
  copyFileSync(NODE_EXE, exe);

  // 4. Inject blob
  run(
    `npx postject "${exe}" NODE_SEA_BLOB "${blob}"` +
    ` --sentinel-fuse ${FUSE} --overwrite`,
    "postject"
  );

  process.stdout.write(`  ✓ ${name}.exe\n`);
}

// Preserve existing standalone command aliases.
for (const alias of ["dsw", "d"]) {
  copyFileSync(resolve(DIST, "switchyard.exe"), resolve(DIST, `${alias}.exe`));
  process.stdout.write(`\n  ✓ ${alias}.exe (alias for switchyard)\n`);
}

process.stdout.write(`\nOutput: ${DIST}\n`);
