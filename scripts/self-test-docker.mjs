// Self-test for src/docker_tools.js — schema shape, dispatch, argv-safety, and
// the docker_scan detection gate. No Docker daemon or scanner is required: the
// checks that would hit `docker`/`trivy` assert on the tool's error/guidance
// handling instead, so this runs anywhere.
import assert from "node:assert";
import { runDockerTool, dockerToolSchemas } from "../src/docker_tools.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  PASS ${name}`); }
async function checkAsync(name, fn) { await fn(); passed += 1; console.log(`  PASS ${name}`); }

const EXPECTED = [
  "docker_ps", "docker_images", "docker_logs", "docker_inspect", "docker_scan",
  "docker_pull", "docker_run", "docker_start", "docker_stop", "docker_rm",
  "docker_rmi", "docker_exec", "docker_build", "docker_cli",
];

check("schemas are well-formed and cover the expected tools", () => {
  const schemas = dockerToolSchemas();
  const names = schemas.map((s) => s.function.name);
  for (const s of schemas) {
    assert.equal(s.type, "function");
    assert.ok(s.function?.name && s.function?.parameters, `bad schema: ${JSON.stringify(s)}`);
    assert.equal(s.function.parameters.additionalProperties, false);
  }
  for (const name of EXPECTED) assert.ok(names.includes(name), `missing tool: ${name}`);
});

check("docker_scan requires an image", () => {
  const scan = dockerToolSchemas().find((s) => s.function.name === "docker_scan");
  assert.ok(scan.function.parameters.required.includes("image"));
});

await checkAsync("object names are validated (no shell injection)", async () => {
  for (const [tool, arg] of [["docker_start", "container"], ["docker_stop", "container"], ["docker_scan", "image"], ["docker_pull", "image"]]) {
    await assert.rejects(
      () => runDockerTool(tool, { [arg]: "x; rm -rf /" }, { permission: "full" }),
      /unexpected characters/,
      `${tool} should reject an injected ${arg}`
    );
  }
});

await checkAsync("unknown docker tool throws", async () => {
  await assert.rejects(() => runDockerTool("docker_nope", {}, { permission: "full" }), /Unknown docker tool/);
});

await checkAsync("docker_cli requires args", async () => {
  await assert.rejects(() => runDockerTool("docker_cli", {}, { permission: "full" }), /args is required/);
});

await checkAsync("active tools are blocked without permission when the user declines", async () => {
  const res = await runDockerTool("docker_pull", { image: "alpine:latest" }, { askYesNo: async () => false });
  assert.equal(res, "blocked by user");
});

await checkAsync("docker_scan gates on a missing scanner OR returns a summary", async () => {
  // No network/daemon assumptions: either trivy/grype is absent (guidance) or a
  // scan summary/erroring result comes back — all are non-throwing strings.
  const res = await runDockerTool("docker_scan", { image: "alpine:latest", timeout_ms: 60000 });
  assert.equal(typeof res, "string");
  assert.ok(res.length > 0);
});

console.log(`\nAll ${passed} docker-tools checks passed.`);
