import assert from "node:assert/strict";
import {
  getProviderBalance,
  isBelowMinimum,
  normalizeDeepSeekBalance,
  selectCurrencyBalance
} from "../src/provider-balance.js";

const fixture = {
  is_available: true,
  balance_infos: [{
    currency: "USD",
    total_balance: "12.50",
    granted_balance: "2.50",
    topped_up_balance: "10.00"
  }]
};

const normalized = normalizeDeepSeekBalance(fixture);
assert.equal(normalized.available, true);
assert.deepEqual(selectCurrencyBalance(normalized, "usd"), {
  currency: "USD",
  total: 12.5,
  granted: 2.5,
  toppedUp: 10
});
assert.equal(isBelowMinimum(normalized, 15), true);
assert.equal(isBelowMinimum(normalized, 10), false);

let requestedUrl = "";
let requestedAuth = "";
const fetched = await getProviderBalance("deepseek", {
  apiKey: "test-key",
  fetchImpl: async (url, options) => {
    requestedUrl = url;
    requestedAuth = options.headers.Authorization;
    return { ok: true, status: 200, json: async () => fixture };
  }
});
assert.equal(requestedUrl, "https://api.deepseek.com/user/balance");
assert.equal(requestedAuth, "Bearer test-key");
assert.equal(fetched.balances[0].total, 12.5);

await assert.rejects(() => getProviderBalance("glm", { apiKey: "test-key" }), /does not publish/);
console.log("provider balance checks passed");
