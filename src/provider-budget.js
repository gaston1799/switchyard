const MARKER = '## Switchyard provider budget';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function isoFromEpoch(value) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const number = finite(value); if (number === null) return null;
  const date = new Date(number > 10_000_000_000 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function budgetLevel({ remainingPercent = null, balance = null } = {}) {
  const percent = finite(remainingPercent), dollars = finite(balance);
  if ((percent !== null && percent <= 5) || (dollars !== null && dollars <= 0.25)) return 'critical';
  if ((percent !== null && percent <= 15) || (dollars !== null && dollars <= 1)) return 'low';
  if (percent !== null || dollars !== null) return 'ok';
  return 'unknown';
}

export function deepSeekBudget(status, checkedAt = new Date().toISOString()) {
  const item = status?.balances?.find(value => value.currency === 'USD') || status?.balances?.[0];
  const balance = finite(item?.total);
  return { provider: 'deepseek', source: 'api_balance', checkedAt, available: status?.available === true,
    currency: item?.currency || null, balance, level: budgetLevel({ balance }), resetAt: null };
}

export function codexBudget(data, checkedAt = new Date().toISOString()) {
  const buckets = Object.values(data?.rateLimitsByLimitId || { codex: data?.rateLimits }).filter(Boolean);
  const bucket = buckets.find(item => item?.limitId === 'codex') || buckets[0];
  const windows = [bucket?.primary, bucket?.secondary].filter(Boolean).map(item => ({
    durationMinutes: finite(item.windowDurationMins),
    remainingPercent: item.usedPercent == null ? null : Math.max(0, 100 - Number(item.usedPercent)),
    resetAt: isoFromEpoch(item.resetsAt)
  }));
  const values = windows.map(item => item.remainingPercent).filter(value => value !== null);
  const remainingPercent = values.length ? Math.min(...values) : null;
  return { provider: 'codex', source: 'subscription_rate_limits', checkedAt, available: Boolean(bucket),
    remainingPercent, windows, level: budgetLevel({ remainingPercent }),
    resetAt: windows.map(item => item.resetAt).filter(Boolean).sort()[0] || null,
    creditBalance: bucket?.credits?.balance ?? null, resetCredits: data?.rateLimitResetCredits?.availableCount ?? null };
}

export function claudeBudget(info = {}, checkedAt = new Date().toISOString()) {
  const utilization = finite(info.utilization ?? info.used_percent ?? info.usedPercent);
  const explicit = finite(info.remaining_percent ?? info.remainingPercent);
  const remainingPercent = explicit ?? (utilization === null ? null : Math.max(0, utilization <= 1 ? (1 - utilization) * 100 : 100 - utilization));
  const status = String(info.status || 'unknown');
  return { provider: 'claude', source: 'subscription_rate_limit_event', checkedAt, status,
    rateLimitType: info.rate_limit_type || info.rateLimitType || null, remainingPercent,
    resetAt: isoFromEpoch(info.resets_at ?? info.resetsAt ?? info.reset_at ?? info.resetAt),
    level: ['rejected', 'blocked'].includes(status) ? 'critical' : budgetLevel({ remainingPercent }) };
}

export function unavailableBudget(provider, source = 'provider_does_not_expose_balance') {
  return { provider, source, checkedAt: new Date().toISOString(), available: false, level: 'unknown', resetAt: null };
}

export function formatBudget(status) {
  if (!status) return 'Provider budget: unavailable.';
  const parts = [`Provider budget: ${status.provider}`, `state=${status.level || 'unknown'}`];
  if (status.balance != null) parts.push(`balance=${status.currency || 'USD'} ${Number(status.balance).toFixed(2)}`);
  if (status.remainingPercent != null) parts.push(`remaining=${Math.round(status.remainingPercent)}%`);
  if (status.resetAt) parts.push(`next_reset=${status.resetAt}`);
  if (status.windows?.length) parts.push(`windows=${status.windows.map(item => `${item.remainingPercent == null ? '?' : Math.round(item.remainingPercent)}%/${item.durationMinutes ?? '?'}m/reset:${item.resetAt || '?'}`).join(',')}`);
  if (status.status && status.status !== 'unknown') parts.push(`provider_status=${status.status}`);
  if (status.level === 'unknown') parts.push('balance_or_quota_not_exposed=true');
  return parts.join(' · ');
}

export function budgetPrompt(status) {
  const guidance = status?.level === 'critical'
    ? 'Quota is critical. Do not begin another long operation. Save durable state, finish the smallest safe unit of work, and give a concise handoff before cutoff.'
    : status?.level === 'low'
      ? 'Quota is low. Prefer short bounded steps, persist progress often, and find a safe stopping point before starting expensive work.'
      : status?.level === 'unknown'
        ? 'The provider does not expose a usable balance here. Do not claim a known remaining balance or reset time.'
        : 'Quota is healthy enough for normal work; continue to persist meaningful progress.';
  return `${MARKER}\n${formatBudget(status)}\n${guidance}`;
}

export function upsertBudgetContext(messages, status) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.find(message => message.role === 'system');
  if (!system) return list;
  const base = String(system.content || '').replace(new RegExp(`\\n*${MARKER}[\\s\\S]*$`), '').trimEnd();
  system.content = `${base}\n\n${budgetPrompt(status)}`;
  return list;
}
