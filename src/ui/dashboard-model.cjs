function usageTotals(session, priceLookup) {
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, pricedTurns: 0, unpricedTurns: 0, estimatedCost: 0 };
  const provider = session.provider || session.config?.provider || "";
  const model = session.model || "";
  const isApi = (session.config?.backend || "api") === "api";
  for (const message of session.messages || []) {
    if (message.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.raw?.input_tokens) || 0;
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.raw?.output_tokens) || 0;
    const cached = Math.min(input, Number(
      usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.raw?.cache_read_input_tokens
      ?? usage.raw?.prompt_tokens_details?.cached_tokens
    ) || 0);
    const raw = usage.raw || {};
    const hasCacheTtls = raw.cache_creation && (
      raw.cache_creation.ephemeral_5m_input_tokens != null || raw.cache_creation.ephemeral_1h_input_tokens != null
    );
    const write5m = hasCacheTtls
      ? Number(raw.cache_creation.ephemeral_5m_input_tokens) || 0
      : Number(
      usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? usage.raw?.cache_creation_input_tokens
      ) || 0;
    const write1h = hasCacheTtls ? Number(raw.cache_creation.ephemeral_1h_input_tokens) || 0 : 0;
    const written = write5m + write1h;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cachedTokens += cached;
    if (!input && !output && !written) continue;
    const price = isApi ? priceLookup(provider, model, { inputTokens: input }) : null;
    if (!price || price.input == null || price.output == null || (cached && price.cached == null) || (write5m && price.write == null) || (write1h && price.write1h == null)) {
      totals.unpricedTurns += 1;
      continue;
    }
    const uncached = Math.max(0, input - cached - written);
    totals.estimatedCost += (
      uncached * price.input
      + (cached ? cached * price.cached : 0)
      + (write5m ? write5m * price.write : 0)
      + (write1h ? write1h * price.write1h : 0)
      + output * price.output
    ) / 1_000_000;
    totals.pricedTurns += 1;
  }
  return totals;
}

function eventLabel(event, agentNames) {
  const name = id => agentNames.get(id) || id || "Agent";
  switch (event.type) {
    case "agent_registered": return `${name(event.agentId)} joined the coordination board`;
    case "agent_stopped": return `${name(event.agentId)} stopped (${event.state || "unknown"})`;
    case "message_sent": return `${name(event.from)} sent a ${event.messageType || "message"} to ${name(event.to)}`;
    case "task_claimed": return `${name(event.agentId)} claimed task ${event.taskId || ""}`.trim();
    case "task_handoff": return `${name(event.agentId)} handed off task ${event.taskId || ""}`.trim();
    default: return String(event.type || "Coordination event").replaceAll("_", " ");
  }
}

function isOperatorAgent(agent) {
  return agent.agentId === "ui" || agent.agentId === "cli" || agent.role === "operator";
}

function buildDashboardModel({ sessions = [], agents = [], events = [], eventTotal = events.length, eventsToday, runs = [], now = new Date() }) {
  const names = new Map(agents.map(agent => [agent.agentId, agent.displayName || agent.agentId]));
  const visibleAgents = agents.filter(agent => !isOperatorAgent(agent));
  const live = visibleAgents.filter(agent => agent.live);
  const today = now.toDateString();
  const metrics = sessions.reduce((all, session) => {
    all.inputTokens += session.inputTokens || 0;
    all.outputTokens += session.outputTokens || 0;
    all.cachedTokens += session.cachedTokens || 0;
    all.estimatedCost += session.estimatedCost || 0;
    all.pricedTurns += session.pricedTurns || 0;
    all.unpricedTurns += session.unpricedTurns || 0;
    return all;
  }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCost: 0, pricedTurns: 0, unpricedTurns: 0 });
  const recentActivity = [
    ...events.map(event => ({
      id: event.id,
      type: event.type || "event",
      label: eventLabel(event, names),
      createdAt: event.createdAt || "",
      source: "coordination"
    })),
    ...runs.map(run => ({
      id: run.id,
      type: `run_${run.status}`,
      label: `${run.status === "running" ? "Running" : run.status === "error" ? "Run failed" : "Run completed"}: ${run.session?.title || run.prompt || run.id}`,
      createdAt: run.updatedAt || run.createdAt || "",
      source: "run"
    }))
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
  const modelMap = new Map();
  for (const session of sessions) {
    const key = `${session.provider || "native"}/${session.model || session.backend || "unknown"}`;
    const row = modelMap.get(key) || { provider: session.provider || session.backend || "unknown", model: session.model || "unknown", sessions: 0, tokens: 0, estimatedCost: 0, pricedTurns: 0, unpricedTurns: 0 };
    row.sessions += 1;
    row.tokens += (session.inputTokens || 0) + (session.outputTokens || 0);
    row.estimatedCost += session.estimatedCost || 0;
    row.pricedTurns += session.pricedTurns || 0;
    row.unpricedTurns += session.unpricedTurns || 0;
    modelMap.set(key, row);
  }
  return {
    metrics: {
      totalSessions: sessions.length,
      activeAgents: live.length,
      activeSubagents: live.filter(agent => agent.coordinatorId || agent.parentAgentId).length,
      eventsToday: eventsToday ?? events.filter(event => event.createdAt && new Date(event.createdAt).toDateString() === today).length,
      totalEvents: eventTotal,
      totalTokens: metrics.inputTokens + metrics.outputTokens,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cachedTokens: metrics.cachedTokens,
      estimatedCost: metrics.estimatedCost,
      pricedTurns: metrics.pricedTurns,
      unpricedTurns: metrics.unpricedTurns
    },
    agents: visibleAgents.map(agent => ({ ...agent, displayName: agent.displayName || agent.agentId })),
    recentActivity,
    models: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
    runs
  };
}

module.exports = { usageTotals, buildDashboardModel };
