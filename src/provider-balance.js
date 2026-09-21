import { normalizeProvider, providerConfig } from "./providers.js";

export const DEEPSEEK_TOP_UP_URL = "https://platform.deepseek.com/top_up";

function finiteAmount(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDeepSeekBalance(payload) {
  const balances = Array.isArray(payload?.balance_infos)
    ? payload.balance_infos.map((entry) => ({
      currency: String(entry?.currency || "").toUpperCase(),
      total: finiteAmount(entry?.total_balance),
      granted: finiteAmount(entry?.granted_balance),
      toppedUp: finiteAmount(entry?.topped_up_balance)
    })).filter((entry) => entry.currency && entry.total !== null)
    : [];

  return {
    provider: "deepseek",
    available: payload?.is_available === true,
    balances
  };
}

export function selectCurrencyBalance(status, currency = "USD") {
  const wanted = String(currency || "USD").trim().toUpperCase();
  return status?.balances?.find((entry) => entry.currency === wanted) || null;
}

export function isBelowMinimum(status, minimum, currency = "USD") {
  const threshold = Number(minimum);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Minimum balance must be a non-negative number.");
  const balance = selectCurrencyBalance(status, currency);
  if (!balance) throw new Error(`No ${String(currency).toUpperCase()} balance was returned by the provider.`);
  return balance.total < threshold;
}

export async function getProviderBalance(providerName = "deepseek", options = {}) {
  const provider = normalizeProvider(providerName);
  if (provider !== "deepseek") {
    throw new Error(`${providerConfig(provider).label} does not publish a supported account-balance endpoint for this harness.`);
  }

  const apiKey = String(options.apiKey || "").trim();
  if (!apiKey) throw new Error("No DeepSeek API key found. Run: dsw config set-key <key>");

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = String(options.baseUrl || providerConfig(provider).baseUrl).replace(/\/$/, "");
    const response = await fetchImpl(`${baseUrl}/user/balance`, {
      method: "GET",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      const error = new Error(`DeepSeek balance request failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return normalizeDeepSeekBalance(await response.json());
  } finally {
    clearTimeout(timer);
  }
}
