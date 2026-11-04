import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProviderModelCatalog, fetchProviderModels, contextLimitFor, providerConfig } from '../src/providers.js';
import { modelPrice, priceModelChoices } from '../src/model-pricing.js';
import { modelCapabilities } from '../src/multimodal.js';
import { buildProviderRequest } from '../src/provider-transport.js';
import { createRequire } from 'node:module';
const { usageTotals } = createRequire(import.meta.url)('../src/ui/dashboard-model.cjs');

test('catalog retains new and unpriced IDs, labels, metadata and pagination', async () => {
  const seen = [];
  const catalog = await fetchProviderModelCatalog('anthropic', 'test-key', { fetchImpl: async (url, init) => {
    seen.push(url);
    assert.equal(init.headers['x-api-key'], 'test-key');
    return Response.json(seen.length === 1
      ? { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_output_tokens: 128000 }], has_more: true, last_id: 'claude-haiku-5-5' }
      : { data: [{ id: 'claude-haiku-5-5' }, { id: 'future-model' }], has_more: false });
  } });
  assert.match(seen[1], /after_id=claude-haiku-5-5/);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].label, 'Claude Haiku 5.5');
  assert.match(catalog[0].description, /1,000,000.*128,000/);
  assert.equal(priceModelChoices(catalog, { provider: 'anthropic' }).at(-1).id, 'future-model');
});

test('ID-only catalog stays compatible and incomplete catalogs fail safely', async () => {
  const urls = [];
  const ids = await fetchProviderModels('reflection', 'test', { fetchImpl: async url => {
    urls.push(url);
    return Response.json(urls.length === 1
      ? { data: [{ id: 'Beam-1.0-501B-A23B' }], has_more: true, last_id: 'Beam-1.0-501B-A23B' }
      : { data: [{ id: 'future-beam' }] });
  } });
  assert.deepEqual(ids, ['Beam-1.0-501B-A23B', 'future-beam']);
  assert.match(urls[1], /after=Beam-1.0/);
  assert.equal(await fetchProviderModels('openai', 'test', { fetchImpl: async () => Response.json({ data: [{ id: 'partial' }], has_more: true }) }), null);
  assert.equal(await fetchProviderModels('openai', '', { fetchImpl: () => { throw Error('must not fetch'); } }), null);
});

test('new models have verified windows, prices, and modality support', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) assert.equal(contextLimitFor('openai', id), 1050000);
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.equal(contextLimitFor('anthropic', id), 1000000);
  for (const id of ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flashx-legal']) {
    assert.equal(contextLimitFor('glm', id), 1000000);
    assert.equal(modelCapabilities('glm', id).vision, true);
  }
  assert.equal(modelCapabilities('deepseek', 'deepseek-flash').vision, true);
  assert.equal(modelCapabilities('deepseek', 'deepseek-v4-pro').vision, false);
  assert.equal(providerConfig('deepseek').model, 'deepseek-flash');
  assert.equal(providerConfig('reflection').model, 'Beam-1.0-501B-A23B');
  assert.equal(contextLimitFor('reflection', 'Beam-1.0-501B-A23B'), 1048576);
  assert.equal(modelPrice('reflection', 'Beam-1.0-501B-A23B'), null);
  assert.equal(modelPrice('openai', 'gpt-6.1-terra').input, 1);
  assert.equal(modelPrice('anthropic', 'claude-sonnet-5-5').cached, 0.1);
  assert.equal(modelPrice('glm', 'glm-5.3-flashx-legal').output, 1.25);
});

test('long-context rates apply at the request boundary and are disclosed', () => {
  assert.equal(modelPrice('anthropic', 'claude-haiku-5-5', { inputTokens: 100000 }).input, 0.1);
  assert.equal(modelPrice('anthropic', 'claude-haiku-5-5', { inputTokens: 100001 }).input, 0.5);
  assert.equal(modelPrice('openai', 'gpt-6.1-terra', { inputTokens: 272000 }).output, 5);
  assert.equal(modelPrice('openai', 'gpt-6.1-terra', { inputTokens: 272001 }).output, 7.5);
  assert.match(priceModelChoices([{ id: 'claude-haiku-5-5' }], { provider: 'anthropic' })[0].description, /Above 100k/);
  const totals = usageTotals({ provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'assistant', usage: { prompt_tokens: 200000, completion_tokens: 1000 } }] }, modelPrice);
  assert.equal(totals.estimatedCost, 0.1025);
});

test('new reasoning models use supported request shapes without paid calls', () => {
  const messages = [{ role: 'user', content: 'test' }];
  const body = opts => JSON.parse(buildProviderRequest({ thinking: 'enabled', effort: 'max', ...opts }, messages, { apiKey: 'test' }).init.body);
  assert.equal(body({ provider: 'anthropic', model: 'claude-haiku-5-5' }).thinking.type, 'adaptive');
  assert.equal(body({ provider: 'openai', model: 'gpt-6.1-terra' }).reasoning.effort, 'max');
});
