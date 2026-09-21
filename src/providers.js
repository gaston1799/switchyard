export const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    contextLimit: 1_048_576
  },
  glm: {
    label: "GLM",
    envKey: "GLM_API_KEY",
    baseUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.7",
    contextLimit: 204_800
  },
  anthropic: {
    label: "Claude", envKey: "ANTHROPIC_API_KEY", protocol: "messages",
    baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6", contextLimit: 200_000
  },
  openai: {
    label: "OpenAI", envKey: "OPENAI_API_KEY", protocol: "responses",
    baseUrl: "https://api.openai.com/v1", model: "gpt-5", contextLimit: 400_000
  }
};

export function normalizeProvider(provider) {
  const input = String(provider || "deepseek").trim().toLowerCase();
  const value = ({ claude: "anthropic", gpt: "openai" })[input] || input;
  if (!PROVIDERS[value]) throw new Error(`Unknown provider '${provider}'. Use ${Object.keys(PROVIDERS).join(" or ")}.`);
  return value;
}

export function providerConfig(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

/**
 * Context windows, per model.
 *
 * Hardcoded from vendor documentation because NO provider reports them.
 * Re-checked against all three live endpoints on 2026-09-21:
 *   api.deepseek.com/models  -> id, object, owned_by
 *   api.z.ai .../v4/models   -> id, object, created, owned_by
 *   api.openai.com/v1/models -> id, object, created, owned_by, shutdown_date
 * Model NAMES are discoverable at runtime; their windows are not, so this table
 * is the only place the truth can live.
 *
 * Nor can the window be measured cheaply. OpenAI's overflow error is "Your input
 * exceeds the context window of this model" with no figure, so discovery would
 * mean a binary search whose ACCEPTED probes bill hundreds of thousands of input
 * tokens each. Rejections are free; acceptances are not, and an acceptance is the
 * only thing that establishes a lower bound. Not worth real money per model.
 *
 * CONFIRMED entries come from vendor docs or provider listings. INFERRED
 * entries are marked as such and take the conservative reading of their family,
 * because guessing high is the dangerous direction: auto-compaction would not
 * fire before the real limit and the request fails outright on overflow.
 * Guessing low only compacts earlier than necessary.
 *
 * Exact-name matches are tried before family patterns, so a model that differs
 * from its family cannot be swallowed by the family rule.
 */
const MODEL_CONTEXT_LIMITS = new Map([
  // GPT-5 family -- CONFIRMED at 400K by vendor documentation. The `^gpt-5`
  // family rule below covers 5.1, 5.2, the pro and codex variants, and every
  // dated alias (gpt-5-2025-08-07 and friends), which previously all fell
  // through to the 131K floor and compacted at ~118K on a 400K model.
  ["gpt-5", 400_000],
  ["gpt-5-mini", 400_000],
  ["gpt-5-nano", 400_000],

  // The exceptions the family rule must NOT swallow. Exact names are matched
  // first, which is what makes a broad `^gpt-5` rule safe.
  //
  // `gpt-5-chat-latest` is the non-reasoning chat model and does not carry the
  // family's window; held at the documented 128K. `gpt-5-search-api` has no
  // published figure, so it stays at the floor rather than inheriting 400K --
  // guessing high is the direction that breaks a request outright.
  ["gpt-5-chat-latest", 128_000],
  ["gpt-5-search-api", 131_072],
  // Conservative baseline; callers can explicitly select a larger supported window.
  ["claude-sonnet-4-6", 200_000],
  ["claude-opus-4-6", 200_000],
  // GLM 4.x — CONFIRMED. 4.6 expanded the window from 128K to 200K; 4.5 and the
  // air variant remain at 128K.
  ["glm-4.5", 131_072],
  ["glm-4.5-air", 131_072],
  ["glm-4.6", 204_800],
  ["glm-4.7", 204_800],

  // GLM 5.x — 5.2 and 5.3 CONFIRMED at 1M by vendor documentation.
  ["glm-5.2", 1_048_576],
  ["glm-5.3", 1_048_576],

  // INFERRED. No vendor figure found for these. They sit in the 5.x family, but
  // "turbo" and "flash" variants are routinely cut down relative to the model
  // they derive from -- glm-4.5-air is exactly that at half its family's
  // window. Held at the conservative floor until someone confirms a number.
  ["glm-5", 131_072],
  ["glm-5-turbo", 131_072],
  ["glm-5.1", 131_072],
  ["glm-5.3-flash", 131_072],

  // DeepSeek V4 — CONFIRMED. Documented as a 1,000,000-token total context for
  // every hosted V4 id. Deliberately the documented round million rather than
  // 2^20, which is 48,576 tokens more than the vendor promises.
  ["deepseek-v4-flash", 1_000_000],
  ["deepseek-v4-pro", 1_000_000],
  ["deepseek-v4-flash-vision-exp", 1_000_000]
]);

/** Family fallbacks, tried only when no exact name matches. */
const MODEL_CONTEXT_FAMILIES = [
  [/^glm-4\.5|^glm-4-32b/, 131_072],
  [/^glm-4\./, 204_800],
  [/^deepseek-v4/, 1_000_000],

  // GPT-5, every variant and dated alias -- INFERRED from the family's
  // CONFIRMED 400K. One live data point agrees: on 2026-09-21 a ~400K-token
  // input to gpt-5.2 was rejected as exceeding the window, which is what a
  // 400K TOTAL budget does once a completion is reserved.
  //
  // Safe in the conservative direction. If a newer 5.x ships a larger window
  // this compacts earlier than it needs to; it cannot overrun one. The two
  // models that genuinely sit below the family have exact entries above.
  [/^gpt-5/, 400_000],

  // GPT-4.1 family -- CONFIRMED at ~1M by vendor documentation.
  [/^gpt-4\.1/, 1_047_576]
];

/**
 * What an unrecognised model is assumed to hold.
 *
 * The smallest window any supported model has. A newly released model nobody
 * has added here degrades to cautious rather than broken.
 */
export const UNKNOWN_MODEL_CONTEXT_LIMIT = 131_072;

export function contextLimitFor(provider, model) {
  const normalized = normalizeProvider(provider);
  const name = String(model || providerConfig(normalized).model).toLowerCase();
  const exact = MODEL_CONTEXT_LIMITS.get(name);
  if (exact !== undefined) return exact;
  for (const [pattern, limit] of MODEL_CONTEXT_FAMILIES) {
    if (pattern.test(name)) return limit;
  }
  return UNKNOWN_MODEL_CONTEXT_LIMIT;
}

/** True when the table recognises the model rather than falling back. */
export function hasKnownContextLimit(model) {
  const name = String(model || "").toLowerCase();
  if (MODEL_CONTEXT_LIMITS.has(name)) return true;
  return MODEL_CONTEXT_FAMILIES.some(([pattern]) => pattern.test(name));
}

/**
 * The models a provider will actually serve for this key.
 *
 * Listing is not entitlement, but a model absent from the list is certainly not
 * spawnable, so this is worth having before a spawn rather than after a failed
 * one. Returns null — never throws — when the catalog cannot be fetched: an
 * unreachable models endpoint must not stop an agent starting on a model that
 * would have worked.
 */
export async function fetchProviderModels(provider, apiKey, { timeoutMs = 15_000, baseUrl, fetchImpl = fetch } = {}) {
  const normalized = normalizeProvider(provider);
  const endpoint = String(baseUrl || providerConfig(normalized).baseUrl).replace(/\/$/, "");
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const ids = [];
    let after = "";
    for (let page = 0; page < 20; page++) {
      const query = normalized === "anthropic" ? `?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}` : "";
      const response = await fetchImpl(`${endpoint}/models${query}`, {
        headers: { authorization: `Bearer ${apiKey}`, ...(normalized === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) },
        signal: controller.signal
      });
      if (!response.ok) return null;
      const body = await response.json();
      ids.push(...(body?.data || body?.models || []).map((entry) => entry?.id || entry?.name).filter((id) => typeof id === "string" && id.length > 0));
      if (!body.has_more) return ids.length ? [...new Set(ids)] : null;
      if (!body.last_id || body.last_id === after) return null;
      after = body.last_id;
    }
    return null; // Incomplete catalogs must not reject otherwise usable models.
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
