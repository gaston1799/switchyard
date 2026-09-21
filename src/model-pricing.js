import { providerConfig } from './providers.js';

// Reference USD / million text tokens, checked against these official pages.
// Exact IDs only: never guess prices for snapshots, fine-tunes or new variants.
export const PRICING_CHECKED = '2026-09-21';
export const PRICING_SOURCES = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  glm: 'https://docs.z.ai/guides/overview/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/'
};
// [input, cached input, output, cache write (5m for Claude)]
const rates = {
  openai: {
    // Older models verified at /api/docs/models/<id>.
    'gpt-5-nano': [0.05, 0.005, 0.4],
    'gpt-5-mini': [0.25, 0.025, 2],
    'gpt-5': [1.25, 0.125, 10],
    'gpt-5.1': [1.25, 0.125, 10],
    'gpt-5.1-codex': [1.25, 0.125, 10],
    'gpt-5.1-codex-mini': [0.25, 0.025, 2],
    'gpt-4.1-nano': [0.1, 0.025, 0.4],
    'gpt-4.1-mini': [0.4, 0.1, 1.6],
    'gpt-4o-mini': [0.15, 0.075, 0.6],
    'gpt-4o': [2.5, 1.25, 10],
    'gpt-4.1': [2, 0.5, 8],
    'gpt-5-codex': [1.25, 0.125, 10],
    'gpt-5.2': [1.75, 0.175, 14],
    'gpt-5.2-codex': [1.75, 0.175, 14],
    'gpt-5.4': [2.5, 0.25, 15],
    'gpt-5.4-mini': [0.75, 0.075, 4.5],
    'gpt-5.4-nano': [0.2, 0.02, 1.25],
    'o3': [2, 0.5, 8],
    'o3-mini': [1.1, 0.55, 4.4],
    'o4-mini': [1.1, 0.275, 4.4],
    'gpt-6-astra': [10, 1, 50, 12.5],
    'gpt-5.6-sol': [4, 0.4, 20, 5],
    'gpt-5.6-terra': [2, 0.2, 12, 2.5],
    'gpt-5.6-luna': [0.2, 0.02, 1.2, 0.25],
    'gpt-5.5': [5, 0.5, 30],
    'gpt-5.3-codex': [1.75, 0.175, 14]
  },
  anthropic: {
    'claude-haiku-4-5': [1, 0.1, 5, 1.25],
    'claude-sonnet-4-5': [3, 0.3, 15, 3.75],
    'claude-sonnet-4-6': [3, 0.3, 15, 3.75],
    'claude-sonnet-5': [2, 0.2, 10, 2.5],
    'claude-opus-4-5': [5, 0.5, 25, 6.25],
    'claude-opus-4-6': [5, 0.5, 25, 6.25],
    'claude-opus-4-7': [5, 0.5, 25, 6.25],
    'claude-opus-4-8': [5, 0.5, 25, 6.25],
    'claude-opus-5': [5, 0.5, 25, 6.25],
    'claude-fable-5': [10, 1, 50, 12.5],
    'claude-fable-5-1': [10, 0.25, 50, 12.5]
  },
  glm: {
    'glm-5.1': [1.4, 0.26, 4.4],
    'glm-5': [1, 0.2, 3.2],
    'glm-4.7': [0.6, 0.11, 2.2],
    'glm-4.6': [0.6, 0.11, 2.2],
    'glm-4.5': [0.6, 0.11, 2.2],
    'glm-4.7-flashx': [0.07, 0.01, 0.4],
    'glm-4.5-air': [0.2, 0.03, 1.1],
    'glm-4.7-flash': [0, 0, 0],
    'glm-4.5-flash': [0, 0, 0]
  },
  // Peak reference rates; off-peak is half. Do not predict billing time.
  deepseek: {
    'deepseek-flash': [0.3, 0.006, 1.2],
    'deepseek-v4-flash': [0.3, 0.006, 1.2],
    'deepseek-v4-flash-vision-exp': [0.3, 0.006, 1.2],
    'deepseek-v4-pro': [1.32, 0.044, 3.96]
  }
};

export function modelPrice(provider, id) {
  const row = Object.hasOwn(rates[provider] || {}, id.toLowerCase()) ? rates[provider][id.toLowerCase()] : null;
  if (!row) return null;
  const [input, cached, output, write] = row;
  return { input, cached, output, write, source: PRICING_SOURCES[provider], checked: PRICING_CHECKED };
}

const dollars = value => `$${value}`;
// Fixed comparison workload, not a forecast of the user's entire agent run.
export const sampleCost = price => (price.input * 10_000 + price.output * 1_000) / 1_000_000;

export function priceModelChoices(models, opts) {
  if (opts.backend && opts.backend !== 'api') {
    return models.map(model => ({ ...model, description: ['Account plan / usage limits apply', model.description].filter(Boolean).join(' · ') }));
  }
  const custom = opts.baseUrl && opts.baseUrl.replace(/\/+$/, '') !== providerConfig(opts.provider).baseUrl.replace(/\/+$/, '');
  return models.map(model => {
    const price = modelPrice(opts.provider, model.id);
    const cost = price ? sampleCost(price) : null;
    const description = price
      ? `USD/1M: in ${dollars(price.input)} · cached ${dollars(price.cached)} · out ${dollars(price.output)}`
        + (price.write != null ? ` · write${opts.provider === 'anthropic' ? ' 5m' : ''} ${dollars(price.write)}` : '')
        + (custom ? ' · Custom endpoint: vendor reference only' : '')
        + (opts.provider === 'deepseek' ? ' · Peak rates; off-peak 50% less' : ' · Standard base rates')
        + ` · Example 10k in + 1k out: $${cost.toFixed(5)} (no caching)`
        + ` · Checked ${price.checked}; extra tool/long-context charges may apply`
      : 'Price unknown · Check provider pricing; not assumed free';
    return { ...model, price, sampleCost: cost, description: [description, model.description].filter(Boolean).join(' · ') };
  }).sort((a, b) => (a.sampleCost ?? Infinity) - (b.sampleCost ?? Infinity) || a.id.localeCompare(b.id));
}
