import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { usageTotals, buildDashboardModel } = require("../src/ui/dashboard-model.cjs");
const html = await readFile(new URL("../src/ui/index.html", import.meta.url), "utf8");
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inlineScripts.length, 1, "UI should have one inline application script");
assert.doesNotThrow(() => new vm.Script(inlineScripts[0][1]), "inline UI script should parse");
for (const id of ["dashboard-stats", "dashboard-agent-tree", "dashboard-activity", "agents-page-tree", "activity-page-feed", "analytics-table", "health-grid"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `dashboard markup should contain #${id}`);
}
const prices = {
  input: 1,
  cached: 0.1,
  write: 1,
  output: 2
};
const sessions = [
  {
    provider: "openai",
    model: "gpt-test",
    config: { backend: "api" },
    messages: [{ role: "assistant", usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }
    } }]
  },
  {
    provider: "anthropic",
    model: "claude-subscription",
    config: { backend: "claude" },
    messages: [{ role: "assistant", usage: { input_tokens: 40, output_tokens: 10 } }]
  }
];
const lookup = (provider, model) => provider === "openai" && model === "gpt-test" ? prices : null;
const apiUsage = usageTotals(sessions[0], lookup);
assert.deepEqual(apiUsage, {
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: 20,
  pricedTurns: 1,
  unpricedTurns: 0,
  estimatedCost: 0.000182
});
const subscriptionUsage = usageTotals(sessions[1], lookup);
assert.equal(subscriptionUsage.estimatedCost, 0);
assert.equal(subscriptionUsage.unpricedTurns, 1);
const longCacheUsage = usageTotals({
  provider: "openai",
  model: "gpt-test",
  config: { backend: "api" },
  messages: [{ role: "assistant", usage: {
    prompt_tokens: 10,
    completion_tokens: 1,
    prompt_tokens_details: { cache_write_tokens: 10 },
    raw: { cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } }
  } }]
}, () => ({ input: 1, cached: 0.1, write: 2, write1h: 3, output: 2 }));
assert.equal(longCacheUsage.estimatedCost, 0.000028);

const now = new Date("2026-10-10T12:00:00.000Z");
const model = buildDashboardModel({
  sessions: [
    { provider: "openai", model: "gpt-test", ...apiUsage },
    { provider: "anthropic", model: "claude-subscription", ...subscriptionUsage }
  ],
  agents: [
    { agentId: "lead", displayName: "Coordinator", live: true },
    { agentId: "worker", displayName: "Research", coordinatorId: "lead", live: true },
    { agentId: "old", live: false },
    { agentId: "ui", role: "operator", live: true }
  ],
  events: [{ type: "message_sent", from: "lead", to: "worker", createdAt: now.toISOString() }],
  eventTotal: 12,
  now
});
assert.equal(model.metrics.totalSessions, 2);
assert.equal(model.metrics.activeAgents, 2);
assert.equal(model.metrics.activeSubagents, 1);
assert.equal(model.metrics.eventsToday, 1);
assert.equal(model.metrics.totalEvents, 12);
assert.equal(model.recentActivity[0].label, "Coordinator sent a message to Research");
assert.equal(model.models.length, 2);
console.log("Dashboard model self-test passed.");
