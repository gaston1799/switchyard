import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: [fileURLToPath(new URL("../src/ui/markdown-entry.js", import.meta.url))],
  outfile: fileURLToPath(new URL("../src/ui/vendor/markdown.js", import.meta.url)),
  bundle: true,
  format: "iife",
  globalName: "SwitchyardMarkdown",
  platform: "browser",
  minify: true,
  legalComments: "eof",
});

const icons = {};
for (const name of ["tool", "terminal", "read", "edit", "search", "browser", "agent", "image", "plan", "mcp", "files"]) {
  icons[name] = await readFile(new URL(`../src/ui/icons/${name}.svg`, import.meta.url), "utf8");
}
await writeFile(new URL("../src/ui/icons.js", import.meta.url), `// Generated from icons/*.svg by npm run build:ui.\nwindow.SwitchyardToolIcons = ${JSON.stringify(icons)};\n`);
