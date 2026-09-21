// src/docker_tools.js — Docker container lifecycle tooling for the dsw harness.
//
// Gives the agent full, bounded control of the host Docker daemon via the
// `docker` CLI: list/inspect, pull/remove images, run/start/stop/rm
// containers, exec commands, tail logs, and build images. Every call shells
// out to `docker` through spawn with an argv array (no shell), so image names,
// commands, and volumes cannot be shell-injected.
//
// Tools:
//   docker_ps       — list containers (running or all)
//   docker_images   — list local images
//   docker_pull     — pull/install an image                     (active)
//   docker_run      — create + run a container                  (active)
//   docker_start    — start an existing container               (active)
//   docker_stop     — stop a running container                  (active)
//   docker_rm       — remove a container                        (active)
//   docker_rmi      — remove an image                           (active)
//   docker_exec     — run a command inside a running container  (active)
//   docker_logs     — tail a container's logs
//   docker_inspect  — inspect a container or image (JSON)
//   docker_scan     — CVE-scan an image (Trivy/Grype)
//   docker_build    — build an image from a workspace dir       (active)
//   docker_cli      — escape hatch: run an arbitrary `docker` subcommand (active)
//
// "active" tools mutate state and are confirmed via opts.askYesNo unless the
// session permission is "full" (mirrors the other *_tools.js modules).

import { spawn } from "node:child_process";

// ── Shared helpers ───────────────────────────────────────────────────────────
export function truncate(text, max = 8000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

// A docker object name (container/image ref) must look sane. Docker itself is
// permissive; this just blocks obvious argv trickery while allowing the usual
// registry/tag/digest characters.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
function assertName(kind, value) {
  const v = String(value ?? "").trim();
  if (!v) throw new Error(`${kind} is required.`);
  if (v.length > 512) throw new Error(`${kind} is too long.`);
  if (!NAME_RE.test(v)) throw new Error(`${kind} contains unexpected characters: ${v}`);
  return v;
}

function runProc(bin, argv, { timeoutMs = 120000, stdin = null } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(bin, argv, { windowsHide: true, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: -1, timed_out: false, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    let stdout = ""; let stderr = ""; let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; if (stdout.length > 8000000) { try { child.kill("SIGKILL"); } catch {} } });
    child.stderr.on("data", (c) => { stderr += c; if (stderr.length > 1000000) { try { child.kill("SIGKILL"); } catch {} } });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ code: -1, timed_out: false, stdout, stderr: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, timed_out: killed, stdout, stderr }); });
    if (stdin != null) { try { child.stdin.end(String(stdin)); } catch {} }
  });
}

// docker_* tools shell out to the `docker` binary specifically.
function runDocker(argv, opts) { return runProc("docker", argv, opts); }

function formatResult(label, argv, result) {
  const lines = [`$ docker ${argv.join(" ")}`];
  if (result.timed_out) lines.push("[timed out — process killed]");
  lines.push(`exit: ${result.code}`);
  const out = truncate(result.stdout).trimEnd();
  const err = truncate(result.stderr, 4000).trimEnd();
  if (out) lines.push("--- stdout ---", out);
  if (err) lines.push("--- stderr ---", err);
  if (!out && !err) lines.push("(no output)");
  return lines.join("\n");
}

function toPairs(value, flag) {
  // Accepts an array of strings ("K=V", "host:container") or an object map.
  const out = [];
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) { const s = String(item).trim(); if (s) out.push(flag, s); }
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) out.push(flag, `${k}=${v}`);
  } else {
    const s = String(value).trim(); if (s) out.push(flag, s);
  }
  return out;
}

// Split a free-form command string into argv the same way most shells do for
// simple cases; callers that need exact control can pass command as an array.
function toArgv(command) {
  if (command == null) return [];
  if (Array.isArray(command)) return command.map((c) => String(c));
  const s = String(command);
  const parts = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((p) => p.replace(/^["']|["']$/g, ""));
}

// ── Read-only tools ──────────────────────────────────────────────────────────
async function dockerPs(args) {
  const argv = ["ps", "--no-trunc"];
  if (args.all) argv.push("-a");
  if (args.filter) argv.push("--filter", String(args.filter));
  argv.push("--format", "table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}");
  return formatResult("ps", argv, await runDocker(argv, { timeoutMs: 30000 }));
}

async function dockerImages(args) {
  const argv = ["images"];
  if (args.filter) argv.push("--filter", String(args.filter));
  if (args.repository) argv.push(assertName("repository", args.repository));
  argv.push("--format", "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}");
  return formatResult("images", argv, await runDocker(argv, { timeoutMs: 30000 }));
}

async function dockerLogs(args) {
  const name = assertName("container", args.container);
  const argv = ["logs"];
  const tail = Math.min(Math.max(Number(args.tail) || 200, 1), 10000);
  argv.push("--tail", String(tail));
  if (args.timestamps) argv.push("--timestamps");
  argv.push(name);
  return formatResult("logs", argv, await runDocker(argv, { timeoutMs: 30000 }));
}

async function dockerInspect(args) {
  const target = assertName("target", args.target || args.container || args.image);
  const argv = ["inspect"];
  if (args.format) argv.push("--format", String(args.format));
  argv.push(target);
  return formatResult("inspect", argv, await runDocker(argv, { timeoutMs: 30000 }));
}

// ── Active (mutating) tools ──────────────────────────────────────────────────
async function dockerPull(args) {
  const image = assertName("image", args.image);
  const argv = ["pull", image];
  return formatResult("pull", argv, await runDocker(argv, { timeoutMs: 600000 }));
}

async function dockerRun(args) {
  const image = assertName("image", args.image);
  const argv = ["run"];
  if (args.detach !== false) argv.push("-d");        // detached by default
  if (args.remove) argv.push("--rm");
  if (args.interactive) argv.push("-i");
  if (args.tty) argv.push("-t");
  if (args.name) argv.push("--name", assertName("name", args.name));
  if (args.network) argv.push("--network", String(args.network));
  if (args.workdir) argv.push("-w", String(args.workdir));
  if (args.restart) argv.push("--restart", String(args.restart));
  argv.push(...toPairs(args.env, "-e"));
  argv.push(...toPairs(args.ports, "-p"));
  argv.push(...toPairs(args.volumes, "-v"));
  argv.push(image);
  argv.push(...toArgv(args.command));
  // A detached run returns quickly; a foreground run may need longer.
  const timeoutMs = args.detach === false ? 300000 : 60000;
  return formatResult("run", argv, await runDocker(argv, { timeoutMs }));
}

async function dockerStart(args) {
  const name = assertName("container", args.container);
  const argv = ["start", name];
  return formatResult("start", argv, await runDocker(argv, { timeoutMs: 60000 }));
}

async function dockerStop(args) {
  const name = assertName("container", args.container);
  const argv = ["stop"];
  if (args.timeout != null) argv.push("-t", String(Math.min(Math.max(Number(args.timeout) || 10, 0), 300)));
  argv.push(name);
  return formatResult("stop", argv, await runDocker(argv, { timeoutMs: 120000 }));
}

async function dockerRm(args) {
  const name = assertName("container", args.container);
  const argv = ["rm"];
  if (args.force) argv.push("-f");
  if (args.volumes) argv.push("-v");
  argv.push(name);
  return formatResult("rm", argv, await runDocker(argv, { timeoutMs: 60000 }));
}

async function dockerRmi(args) {
  const image = assertName("image", args.image);
  const argv = ["rmi"];
  if (args.force) argv.push("-f");
  argv.push(image);
  return formatResult("rmi", argv, await runDocker(argv, { timeoutMs: 60000 }));
}

async function dockerExec(args) {
  const name = assertName("container", args.container);
  const cmd = toArgv(args.command);
  if (!cmd.length) throw new Error("command is required for docker_exec.");
  const argv = ["exec"];
  if (args.interactive) argv.push("-i");
  if (args.tty) argv.push("-t");
  if (args.user) argv.push("-u", String(args.user));
  if (args.workdir) argv.push("-w", String(args.workdir));
  argv.push(...toPairs(args.env, "-e"));
  argv.push(name, ...cmd);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000);
  return formatResult("exec", argv, await runDocker(argv, { timeoutMs }));
}

async function dockerBuild(args) {
  const context = String(args.context || ".");
  const argv = ["build"];
  if (args.tag) argv.push("-t", assertName("tag", args.tag));
  if (args.file) argv.push("-f", String(args.file));
  if (args.no_cache) argv.push("--no-cache");
  argv.push(...toPairs(args.build_args, "--build-arg"));
  argv.push(context);
  return formatResult("build", argv, await runDocker(argv, { timeoutMs: 600000 }));
}

// ── docker_scan: CVE scan an image with Trivy (preferred) or Grype ───────────
const SEV_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NEGLIGIBLE", "UNKNOWN"];

// Detection-gated: return the first available scanner binary, or null so the
// tool can print setup guidance instead of failing cryptically.
async function detectScanner(preferred) {
  const order = preferred === "trivy" ? ["trivy"] : preferred === "grype" ? ["grype"] : ["trivy", "grype"];
  for (const bin of order) {
    const ver = await runProc(bin, [bin === "trivy" ? "--version" : "version"], { timeoutMs: 15000 });
    if (ver.code === 0) return { bin, version: (ver.stdout || "").split(/\r?\n/)[0].trim() };
  }
  return null;
}

function normalizeTrivy(json) {
  const out = [];
  for (const r of (Array.isArray(json?.Results) ? json.Results : [])) {
    for (const v of (r.Vulnerabilities || [])) {
      out.push({
        id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion,
        fixed: v.FixedVersion || "", severity: String(v.Severity || "UNKNOWN").toUpperCase(),
      });
    }
  }
  return out;
}

function normalizeGrype(json) {
  return (Array.isArray(json?.matches) ? json.matches : []).map((m) => ({
    id: m.vulnerability?.id, pkg: m.artifact?.name, installed: m.artifact?.version,
    fixed: (m.vulnerability?.fix?.versions || []).join(",") || "",
    severity: String(m.vulnerability?.severity || "UNKNOWN").toUpperCase(),
  }));
}

async function dockerScan(args) {
  const image = assertName("image", args.image);
  const scanner = await detectScanner(String(args.scanner || "auto"));
  if (!scanner) {
    return [
      "docker_scan: no image scanner found on PATH.",
      "Install one of:",
      "  • Trivy — https://trivy.dev  (scoop install trivy | choco install trivy | brew install trivy)",
      "  • Grype — https://github.com/anchore/grype  (scoop install grype | brew install grype)",
      "Or run Trivy from a container via docker_cli, e.g.:",
      `  {"args":["run","--rm","-v","/var/run/docker.sock:/var/run/docker.sock","aquasec/trivy","image","${image}"]}`,
    ].join("\n");
  }
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 300000, 5000), 600000);
  const severityFilter = args.severity ? new Set(String(args.severity).toUpperCase().split(/[,\s]+/).filter(Boolean)) : null;

  let vulns;
  if (scanner.bin === "trivy") {
    const argv = ["image", "--format", "json", "--scanners", "vuln"];
    if (args.ignore_unfixed) argv.push("--ignore-unfixed");
    if (severityFilter) argv.push("--severity", [...severityFilter].join(","));
    argv.push(image);
    const run = await runProc("trivy", argv, { timeoutMs });
    if (!run.stdout) return formatResult("scan(trivy)", ["trivy", ...argv], run);
    try { vulns = normalizeTrivy(JSON.parse(run.stdout)); }
    catch (e) { return `docker_scan: could not parse trivy output — ${e.message}\n${truncate(run.stderr, 1000)}`; }
  } else {
    const argv = [image, "-o", "json"];
    if (args.ignore_unfixed) argv.push("--only-fixed");
    const run = await runProc("grype", argv, { timeoutMs });
    if (!run.stdout) return formatResult("scan(grype)", ["grype", ...argv], run);
    try { vulns = normalizeGrype(JSON.parse(run.stdout)); }
    catch (e) { return `docker_scan: could not parse grype output — ${e.message}\n${truncate(run.stderr, 1000)}`; }
    if (severityFilter) vulns = vulns.filter((v) => severityFilter.has(v.severity)); // grype has no --severity
  }

  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, 0]));
  for (const v of vulns) counts[v.severity] = (counts[v.severity] || 0) + 1;
  const rank = (s) => { const i = SEV_ORDER.indexOf(s); return i < 0 ? 99 : i; };
  vulns.sort((a, b) => rank(a.severity) - rank(b.severity) || String(a.id).localeCompare(String(b.id)));

  const maxRows = Math.min(Math.max(Number(args.max_findings) || 40, 1), 200);
  const shown = vulns.slice(0, maxRows);
  const lines = [`docker_scan — ${scanner.bin} (${scanner.version}) — image ${image}`];
  lines.push(`Vulnerabilities: ${vulns.length} total  ·  ${SEV_ORDER.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`).join("  ") || "none"}`);
  if (!vulns.length) { lines.push("No known vulnerabilities reported."); return lines.join("\n"); }
  lines.push("", `${"SEVERITY".padEnd(9)} ${"CVE".padEnd(20)} ${"PACKAGE".padEnd(22)} INSTALLED → FIXED`);
  for (const v of shown) {
    const fix = v.fixed ? `${v.installed} → ${v.fixed}` : `${v.installed} (no fix)`;
    lines.push(`${v.severity.padEnd(9)} ${String(v.id).padEnd(20)} ${String(v.pkg).slice(0, 22).padEnd(22)} ${fix}`);
  }
  if (vulns.length > shown.length) lines.push(`…and ${vulns.length - shown.length} more (raise max_findings or filter by severity).`);
  return lines.join("\n");
}

// Escape hatch for anything the typed tools don't cover. The subcommand and its
// arguments are passed straight through as an argv array (no shell).
async function dockerCli(args) {
  const argv = toArgv(args.args);
  if (!argv.length) throw new Error("args is required for docker_cli (e.g. ['network','ls']).");
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000);
  return formatResult("cli", argv, await runDocker(argv, { timeoutMs }));
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set([
  "docker_pull", "docker_run", "docker_start", "docker_stop",
  "docker_rm", "docker_rmi", "docker_exec", "docker_build", "docker_cli",
]);

function actionSummary(name, args) {
  switch (name) {
    case "docker_pull": return `Pull image: ${args.image}`;
    case "docker_run": return `Run ${args.image}${args.name ? ` as ${args.name}` : ""}`;
    case "docker_start": return `Start container: ${args.container}`;
    case "docker_stop": return `Stop container: ${args.container}`;
    case "docker_rm": return `Remove container: ${args.container}`;
    case "docker_rmi": return `Remove image: ${args.image}`;
    case "docker_exec": return `Exec in ${args.container}: ${Array.isArray(args.command) ? args.command.join(" ") : args.command}`;
    case "docker_build": return `Build image${args.tag ? ` ${args.tag}` : ""} from ${args.context || "."}`;
    case "docker_cli": return `docker ${Array.isArray(args.args) ? args.args.join(" ") : args.args}`;
    default: return "";
  }
}

export async function runDockerTool(name, args, opts = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${actionSummary(name, args)}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "docker_ps": return dockerPs(args);
    case "docker_images": return dockerImages(args);
    case "docker_logs": return dockerLogs(args);
    case "docker_inspect": return dockerInspect(args);
    case "docker_scan": return dockerScan(args);
    case "docker_pull": return dockerPull(args);
    case "docker_run": return dockerRun(args);
    case "docker_start": return dockerStart(args);
    case "docker_stop": return dockerStop(args);
    case "docker_rm": return dockerRm(args);
    case "docker_rmi": return dockerRmi(args);
    case "docker_exec": return dockerExec(args);
    case "docker_build": return dockerBuild(args);
    case "docker_cli": return dockerCli(args);
    default: throw new Error(`Unknown docker tool: ${name}`);
  }
}

export function dockerToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  const portsDesc = "Port mappings. Array like ['8080:80','443:443'] or an object {'8080':'80'}.";
  const envDesc = "Environment variables. Array like ['KEY=value'] or an object {KEY:'value'}.";
  const volDesc = "Volume/bind mounts. Array like ['/host/path:/container/path','name:/data'].";
  const cmdDesc = "Command to run. A string (split on spaces, quotes respected) or an array of exact argv tokens.";
  return [
    schema("docker_ps",
      "List Docker containers (running by default). Use all:true to include stopped ones.",
      {
        all: { type: "boolean", description: "Include stopped containers (docker ps -a). Default false." },
        filter: { type: "string", description: "Optional docker filter, e.g. 'status=exited' or 'name=web'." },
      }),
    schema("docker_images",
      "List local Docker images.",
      {
        repository: { type: "string", description: "Optional repository to filter by, e.g. 'nginx'." },
        filter: { type: "string", description: "Optional docker filter, e.g. 'dangling=true'." },
      }),
    schema("docker_logs",
      "Show the tail of a container's logs.",
      {
        container: { type: "string", description: "Container name or ID." },
        tail: { type: "number", description: "Number of trailing lines. Default 200, max 10000." },
        timestamps: { type: "boolean", description: "Prefix each line with a timestamp." },
      },
      ["container"]),
    schema("docker_inspect",
      "Inspect a container or image and return its low-level JSON (optionally a Go --format template).",
      {
        target: { type: "string", description: "Container or image name/ID to inspect." },
        format: { type: "string", description: "Optional Go template, e.g. '{{.State.Status}}'." },
      },
      ["target"]),
    schema("docker_pull",
      "Pull (install) an image from a registry, e.g. 'nginx:latest' or 'ghcr.io/org/app:1.2'.",
      {
        image: { type: "string", description: "Image reference to pull, including optional tag/digest." },
      },
      ["image"]),
    schema("docker_run",
      "Create and run a container from an image. Detached by default. Set ports/env/volumes and an optional command.",
      {
        image: { type: "string", description: "Image reference to run." },
        name: { type: "string", description: "Optional container name." },
        command: { description: cmdDesc },
        detach: { type: "boolean", description: "Run in background (-d). Default true. Set false to run in the foreground and capture output." },
        remove: { type: "boolean", description: "Remove the container when it exits (--rm)." },
        interactive: { type: "boolean", description: "Keep STDIN open (-i)." },
        tty: { type: "boolean", description: "Allocate a pseudo-TTY (-t)." },
        ports: { description: portsDesc },
        env: { description: envDesc },
        volumes: { description: volDesc },
        network: { type: "string", description: "Network to attach, e.g. 'host' or a user network name." },
        workdir: { type: "string", description: "Working directory inside the container (-w)." },
        restart: { type: "string", description: "Restart policy, e.g. 'always' or 'unless-stopped'." },
      },
      ["image"]),
    schema("docker_start",
      "Start an existing stopped container.",
      { container: { type: "string", description: "Container name or ID." } },
      ["container"]),
    schema("docker_stop",
      "Stop a running container.",
      {
        container: { type: "string", description: "Container name or ID." },
        timeout: { type: "number", description: "Seconds to wait before killing. Default 10." },
      },
      ["container"]),
    schema("docker_rm",
      "Remove a container. Use force:true to remove a running one.",
      {
        container: { type: "string", description: "Container name or ID." },
        force: { type: "boolean", description: "Force removal of a running container (-f)." },
        volumes: { type: "boolean", description: "Also remove anonymous volumes (-v)." },
      },
      ["container"]),
    schema("docker_rmi",
      "Remove a local image.",
      {
        image: { type: "string", description: "Image reference or ID." },
        force: { type: "boolean", description: "Force removal (-f)." },
      },
      ["image"]),
    schema("docker_exec",
      "Run a command inside a running container.",
      {
        container: { type: "string", description: "Container name or ID." },
        command: { description: cmdDesc },
        user: { type: "string", description: "User to run as (-u)." },
        workdir: { type: "string", description: "Working directory (-w)." },
        env: { description: envDesc },
        interactive: { type: "boolean", description: "Keep STDIN open (-i)." },
        tty: { type: "boolean", description: "Allocate a pseudo-TTY (-t)." },
        timeout_ms: { type: "number", description: "Command timeout. Default 120000, max 600000." },
      },
      ["container", "command"]),
    schema("docker_build",
      "Build an image from a build context directory containing a Dockerfile.",
      {
        context: { type: "string", description: "Build context path. Default '.'." },
        tag: { type: "string", description: "Image tag, e.g. 'myapp:dev'." },
        file: { type: "string", description: "Path to the Dockerfile (-f) if not in the context root." },
        no_cache: { type: "boolean", description: "Build without using the cache." },
        build_args: { description: "Build args. Array like ['KEY=value'] or an object map." },
      }),
    schema("docker_scan",
      "Scan a Docker image for known CVEs with Trivy (preferred) or Grype, returning a bounded severity summary + top findings (not the full dump). If no scanner is installed, returns install guidance. Read-only; may download a vuln DB on first run.",
      {
        image: { type: "string", description: "Image reference or ID to scan, e.g. 'nginx:latest'." },
        scanner: { type: "string", enum: ["auto", "trivy", "grype"], description: "Scanner to use. Default auto (trivy, then grype)." },
        severity: { type: "string", description: "Only report these severities, comma-separated, e.g. 'CRITICAL,HIGH'. Default: all." },
        ignore_unfixed: { type: "boolean", description: "Only report vulnerabilities that have a fix available." },
        max_findings: { type: "number", description: "Max findings to list. Default 40, max 200." },
        timeout_ms: { type: "number", description: "Scan timeout. Default 300000 (first run downloads a vuln DB), max 600000." },
      },
      ["image"]),
    schema("docker_cli",
      "Escape hatch: run an arbitrary `docker` subcommand for anything the typed tools don't cover (network/volume/compose/system, etc.). Args are passed straight through — no shell.",
      {
        args: { description: "Argv array after `docker`, e.g. ['network','ls'] or ['system','df']. A string is split on spaces." },
        timeout_ms: { type: "number", description: "Timeout. Default 120000, max 600000." },
      },
      ["args"]),
  ];
}
