import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelPrice, priceModelChoices, sampleCost } from '../src/model-pricing.js';
import { chooseModel } from '../src/connection-picker.js';

const choices = ids => ids.map(id => ({ id, label: id }));

test('cheap examples sort before expensive and unknown models without mutating input', () => {
  const input = choices(['sora-2', 'gpt-5', 'gpt-5-nano', 'gpt-5.1-codex-mini']);
  const result = priceModelChoices(input, { provider: 'openai' });
  assert.deepEqual(result.map(m => m.id), ['gpt-5-nano', 'gpt-5.1-codex-mini', 'gpt-5', 'sora-2']);
  assert.equal(input[0].id, 'sora-2');
  assert.match(result[0].description, /USD\/1M: in \$0.05 · cached \$0.005 · out \$0.4/);
  assert.match(result[0].description, /\$0.00090/);
  assert.equal(result.at(-1).sampleCost, null);
  assert.match(result.at(-1).description, /unknown/);
});

test('unknown snapshots and fine-tunes do not inherit misleading family rates', () => {
  for (const id of ['gpt-5-nano-2099-01-01', 'ft:gpt-5-nano:abc', 'gpt-5-nano-audio', 'constructor']) {
    assert.equal(modelPrice('openai', id), null);
  }
});

test('published free models remain distinct from unknown rates', () => {
  const result = priceModelChoices(choices(['unknown', 'glm-4.7', 'glm-4.7-flash']), { provider: 'glm' });
  assert.equal(result[0].id, 'glm-4.7-flash');
  assert.equal(result[0].sampleCost, 0);
  assert.equal(result[2].price, null);
});

test('custom endpoints and peak rates are identified as references', () => {
  const [custom] = priceModelChoices(choices(['gpt-5-nano']), { provider: 'openai', baseUrl: 'http://localhost:9999/v1' });
  assert.match(custom.description, /Custom endpoint: vendor reference only/);
  const [normal] = priceModelChoices(choices(['gpt-5-nano']), { provider: 'openai', baseUrl: 'https://api.openai.com/v1/' });
  assert.doesNotMatch(normal.description, /Custom endpoint/);
  const [peak] = priceModelChoices(choices(['deepseek-v4-flash']), { provider: 'deepseek' });
  assert.match(peak.description, /Peak rates; off-peak 50% less/);
});

test('subscription model order and provider billing descriptions are preserved', () => {
  const input = [{ id: 'gpt-5', description: 'Requires usage credits' }, { id: 'gpt-5-nano' }];
  for (const backend of ['codex', 'claude']) {
    const result = priceModelChoices(input, { backend });
    assert.deepEqual(result.map(m => m.id), input.map(m => m.id));
    assert.match(result[0].description, /Account plan.*Requires usage credits/);
    assert.doesNotMatch(result[1].description, /USD|free|\$0/);
  }
});

test('Claude cache writes are separate from the uncached comparison estimate', () => {
  const [model] = priceModelChoices(choices(['claude-haiku-4-5']), { provider: 'anthropic' });
  assert.match(model.description, /write 5m \$1.25/);
  assert.equal(sampleCost(model.price), 0.015);
});

test('model catalog failure keeps the manual-entry fallback usable', async () => {
  const picked = await chooseModel({ backend: 'nonexistent' }, async (title, hint, items) => {
    assert.match(hint, /Unknown backend/);
    assert.equal(items.at(-1).id, '__manual');
    return '__manual';
  }, async () => ' custom-model ', () => {});
  assert.equal(picked, 'custom-model');
});
