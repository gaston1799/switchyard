#!/usr/bin/env node
// scripts/compact-session.mjs — detached context compactor CLI.
//
// Reads a dsw session file, folds the old transcript prefix into a summary,
// and writes the compacted session state to an output JSON file. This is the
// out-of-process engine behind `--compact-method detached` and can also be
// run manually / by another agent to free context in a busy session:
//
//   node scripts/compact-session.mjs path/to/session.json \
//     --out path/to/result.json --method llm
//
// Result file shape:
//   { compacted: bool, meta?: {...}, messages: [...], compactions: [...] }

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contextLimitFor, normalizeProvider, providerConfig } from "../src/providers.js";
import { compactSession } from "../src/context-compactor.js";

function usage() {
  return `compact-session

Usage:
  node scripts/compact-session.mjs <session.json> [options]

Options:
  --out <file>            Output JSON file (default: <session>.compacted.json).
  --at <pct>              Compact threshold fraction (default: 0.9).
  --limit <tokens>        Total context window (default: session provider/model).
  --completion <tokens>   Completion budget to reserve (default: 16384).
  --keep-recent <n>       Complete turns kept verbatim (default: 15).
  --method <auto|llm|truncate> Provider summary with deterministic fallback (default: auto).
  --provider <name>       Provider (default: saved session provider).
  --compact-provider <name> Summary provider override.
  --compact-model <name>  Summary model override.
  --compact-base-url <url> Summary endpoint override.
  --model <name>          Model (default: saved session model).
  --base-url <url>        Endpoint (default: saved session endpoint).
  -h, --help              Show help.
`;
}

function parseArgs(argv) {
  const opts = {
    method: "auto",
    at: 0.9,
    limit: null,
    completion: 16_384,
    keepRecent: 15,
    model: null,
    baseUrl: null,
    provider: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--out") opts.out = next();
    else if (arg === "--at") opts.at = Number.parseFloat(next());
    else if (arg === "--limit") opts.limit = Number.parseInt(next(), 10);
    else if (arg === "--completion") opts.completion = Number.parseInt(next(), 10);
    else if (arg === "--keep-recent") opts.keepRecent = Number.parseInt(next(), 10);
    else if (arg === "--method") opts.method = next();
    else if (arg === "--provider") opts.provider = normalizeProvider(next());
    else if (arg === "--compact-provider") opts.compactProvider = normalizeProvider(next());
    else if (arg === "--compact-model") opts.compactModel = next();
    else if (arg === "--compact-base-url") opts.compactBaseUrl = next();
    else if (arg === "--tool-tokens") opts.toolTokens = Number(next());
    else if (arg === "--model") opts.model = next();
    else if (arg === "--base-url") opts.baseUrl = next();
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
    else opts.sessionFile = arg;
  }
  return opts;
}

function validate(opts) {
  if (opts.help) return;
  if (!opts.sessionFile) throw new Error("Provide a session JSON file as the first argument.");
  if (!["auto", "llm", "truncate"].includes(opts.method)) throw new Error("--method must be auto, llm or truncate.");
  if (!Number.isFinite(opts.at) || opts.at <= 0 || opts.at > 1) throw new Error("--at must be a fraction in (0, 1].");
  if (opts.limit !== null && (!Number.isFinite(opts.limit) || opts.limit < 2000)) throw new Error("--limit must be at least 2000 tokens.");
  if (!Number.isInteger(opts.keepRecent) || opts.keepRecent < 1) throw new Error("--keep-recent must be an integer >= 1.");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  validate(opts);

  const sessionFile = resolve(opts.sessionFile);
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  opts.provider ||= session.config?.provider || session.provider || "deepseek";
  opts.model ||= session.model || providerConfig(opts.provider).model;
  opts.baseUrl ||= session.baseUrl || providerConfig(opts.provider).baseUrl;
  opts.limit ||= contextLimitFor(opts.provider, opts.model);
  opts.toolTokens ??= session.config?.compactToolTokens || 0;
  for (const key of ["compactProvider", "compactModel", "compactBaseUrl"]) opts[key] ||= session.config?.[key];
  const outFile = resolve(opts.out || `${sessionFile}.compacted.json`);

  const meta = await compactSession(
    {
      ...opts,
      compactToolTokens: opts.toolTokens,
      model: opts.model,
      baseUrl: opts.baseUrl,
      compactMethod: opts.method,
      compactAt: opts.at,
      contextLimit: opts.limit,
      compactKeepRecent: opts.keepRecent,
      maxTokens: opts.completion
    },
    session
  );

  await writeFile(
    outFile,
    `${JSON.stringify(
      {
        compacted: Boolean(meta),
        ...(meta ? { meta } : {}),
        messages: session.messages || [],
        compactions: session.compactions || []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  process.stdout.write(`${JSON.stringify(meta || { compacted: false })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
