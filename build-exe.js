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
import { cpSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import rcedit from "rcedit";
import "./scripts/build-ui.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(ROOT, "dist", "exe");
const VERSION = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
mkdirSync(DIST, { recursive: true });
cpSync(resolve(ROOT, "skills"), resolve(DIST, "skills"), { recursive: true, force: true });
for (const asset of ["icon.ico", "icon.png", "icon.svg"]) copyFileSync(resolve(ROOT, asset), resolve(DIST, asset));

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
      __UI_APP_DIR__: JSON.stringify(resolve(ROOT, "src", "ui")),
      __SWITCHYARD_STANDALONE__: "true"
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

  if (name === "switchyard") {
    await rcedit(exe, {
      icon: resolve(ROOT, "icon.ico"),
      "version-string": {
        ProductName: "Switchyard",
        FileDescription: "Switchyard AI harness"
      },
      "file-version": VERSION,
      "product-version": VERSION
    });
  }

  // 4. Inject blob
  run(
    `npx postject "${exe}" NODE_SEA_BLOB "${blob}"` +
    ` --sentinel-fuse ${FUSE} --overwrite`,
    "postject"
  );

  process.stdout.write(`  ✓ ${name}.exe\n`);
}

// Preserve existing standalone command aliases.
for (const alias of ["switchyard-cli", "dsw", "d"]) {
  copyFileSync(resolve(DIST, "switchyard.exe"), resolve(DIST, `${alias}.exe`));
  process.stdout.write(`\n  ✓ ${alias}.exe (alias for switchyard)\n`);
}

// Build a real Electron application beside the standalone CLI executables.
// The installer places this directory in Programs and creates the Start Menu
// shortcut against Switchyard.exe, rather than the console-oriented SEA CLI.
const DESKTOP = resolve(ROOT, "dist", "desktop");
const ELECTRON_DIST = resolve(ROOT, "node_modules", "electron", "dist");
const APP_ROOT = resolve(DESKTOP, "resources", "app");
mkdirSync(DESKTOP, { recursive: true });
if (!readFileSync(resolve(ELECTRON_DIST, "version"), "utf8").trim()) {
  throw new Error("Electron runtime is missing. Run npm install before building the desktop app.");
}
for (const entry of readdirSync(ELECTRON_DIST, { withFileTypes: true })) {
  const source = resolve(ELECTRON_DIST, entry.name);
  if (entry.name.toLowerCase() === "electron.exe") {
    copyFileSync(source, resolve(DESKTOP, "Switchyard.exe"));
  } else if (entry.isDirectory()) {
    cpSync(source, resolve(DESKTOP, entry.name), { recursive: true, force: true });
  } else {
    copyFileSync(source, resolve(DESKTOP, entry.name));
  }
}
mkdirSync(APP_ROOT, { recursive: true });
cpSync(resolve(ROOT, "src"), resolve(APP_ROOT, "src"), { recursive: true, force: true });
for (const asset of ["icon.ico", "icon.png", "icon.svg"]) {
  copyFileSync(resolve(ROOT, asset), resolve(APP_ROOT, asset));
  copyFileSync(resolve(ROOT, asset), resolve(DESKTOP, asset));
}
copyFileSync(resolve(DIST, "d.exe"), resolve(DESKTOP, "d.exe"));
writeFileSync(resolve(APP_ROOT, "package.json"), `${JSON.stringify({
  name: "switchyard-desktop",
  version: VERSION,
  private: true,
  type: "module",
  main: "src/ui/main.cjs"
}, null, 2)}\n`);
await rcedit(resolve(DESKTOP, "Switchyard.exe"), {
  icon: resolve(ROOT, "icon.ico"),
  "version-string": {
    ProductName: "Switchyard",
    FileDescription: "Switchyard Desktop",
    CompanyName: "Switchyard"
  },
  "file-version": VERSION,
  "product-version": VERSION
});
process.stdout.write(`\n  ✓ Electron desktop app: ${DESKTOP}\n`);

process.stdout.write(`\nOutput: ${DIST}\n`);
