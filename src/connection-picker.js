import { JsonProcess } from './native-process.js';
import { claudeAuthStatus } from './native-backends.js';
import { getProviderApiKey } from './config.js';
import { fetchProviderModels, providerConfig } from './providers.js';
import { priceModelChoices, PRICING_CHECKED } from './model-pricing.js';

export const CONNECTIONS = [
  { id: 'codex', label: 'ChatGPT / Codex', description: 'Use your signed-in Codex account' },
  { id: 'claude', label: 'Claude Code', description: 'Use your signed-in Claude account' },
  { id: 'deepseek', label: 'DeepSeek', description: 'API key' },
  { id: 'glm', label: 'GLM / Z.AI', description: 'API key' },
  { id: 'openai', label: 'OpenAI GPT', description: 'API key · separate API billing' },
  { id: 'anthropic', label: 'Anthropic Claude', description: 'API key · separate API billing' }
];

export async function discoverModels(opts, activeRpc = null) {
  const backend = opts.backend || 'api';
  if (backend === 'api') {
    const key = await getProviderApiKey(opts.provider);
    if (!key) throw new Error(`No ${providerConfig(opts.provider).label} API key configured. Run switchyard config set-${opts.provider === 'deepseek' ? '' : `${opts.provider}-`}key <key>, then retry.`);
    const models = await fetchProviderModels(opts.provider, key, { baseUrl: opts.baseUrl });
    if (!models) throw new Error('The provider model catalog is unavailable. Retry later or enter a model ID manually.');
    return models.map(id => ({ id, label: id, description: id === opts.model ? 'Current model' : '' }));
  }
  let rpc = activeRpc;
  try {
    if (backend === 'codex') {
      if (!rpc) {
        rpc = new JsonProcess('codex', ['app-server', '--stdio']);
        await rpc.request('initialize', { clientInfo: { name: 'switchyard', version: '0.3.0' } });
        rpc.send({ method: 'initialized', params: {} });
        const result = await rpc.request('account/read', { refreshToken: false });
        if (result.account?.type !== 'chatgpt') throw new Error('Sign in first: switchyard login codex');
      }
      const models = []; let cursor = null;
      do {
        const page = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        models.push(...(page.data || []).filter(m => !m.hidden).map(m => ({ id: m.model || m.id, label: m.displayName || m.model || m.id, description: m.description || '' })));
        if (page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      } while (cursor);
      return models;
    }
    if (backend === 'claude') {
      // A fresh initialize is metadata-only; no Claude model request is made.
      const auth = await claudeAuthStatus();
      if (!auth.loggedIn || auth.authMethod !== 'claude.ai') throw new Error('Sign in first: switchyard login claude');
      rpc = new JsonProcess('claude', ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json']);
      const result = await rpc.request('initialize', {}, true);
      return (result.models || []).map(m => ({ id: m.value, label: m.displayName || m.value, description: [m.resolvedModel, m.description].filter(Boolean).join(' · ') }));
    }
    throw new Error(`Unknown backend: ${backend}`);
  } finally { if (rpc && rpc !== activeRpc) await rpc.close(); }
}

export async function chooseModel(opts, choose, prompt, notice, activeRpc = null) {
  let models = [], problem = "";
  try { models = await discoverModels(opts, activeRpc); }
  catch (error) { problem = error.message; notice(error.message); }
  const items = [...priceModelChoices(models, opts), { id: '__manual', label: 'Enter a model ID manually', description: 'Price unknown; use when the catalog is unavailable or incomplete' }];
  const hint = (opts.backend || 'api') === 'api'
    ? `Cheapest example first (10k input + 1k output). USD/1M, checked ${PRICING_CHECKED}. Type to filter.`
    : 'Account plan / usage limits apply. Type to filter; provider access still applies.';
  const model = await choose('Choose a model', problem || hint, items);
  if (!model) return null;
  if (model !== '__manual') return model;
  return (await prompt('Model ID'))?.trim() || null;
}

export function applyApiModel(opts, session, provider, model, contextLimitFor) {
  opts.backend = 'api'; opts.provider = provider; opts.model = model;
  opts.baseUrl = provider === session.provider ? opts.baseUrl : providerConfig(provider).baseUrl;
  opts.contextLimit = contextLimitFor(provider, model);
  opts.balanceFallbackUsed = false;
  session.provider = provider; session.model = model; session.baseUrl = opts.baseUrl;
  session.config.provider = provider; session.config.contextLimit = opts.contextLimit;
  // Native reasoning/signatures are valid only for their original provider/model.
  for (const message of session.messages) delete message.providerState;
}

export const SLASH_HELP = [
  '/commands or /help — show local commands',
  '/model — choose a model for this connection',
  '/model <id> — select a model directly',
  '/provider — choose another API provider (API sessions)',
  '/usage — show usage and available account limits',
  '/session — show the session path and connection',
  '/exit — save and quit'
].join('\n');

export function parseSlash(text) {
  const match = String(text).trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), argument: (match[2] || '').trim() } : null;
}
