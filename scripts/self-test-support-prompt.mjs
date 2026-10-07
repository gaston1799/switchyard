import assert from "node:assert/strict";
import { PERSONAL_SUPPORT_URL, SUPPORT_REMINDER_MS, personalSupportResponse, shouldPromptForPersonalSupport } from "../src/support-prompt.js";

const now = Date.UTC(2026, 0, 1);
assert.equal(PERSONAL_SUPPORT_URL, "https://gaston1799.github.io/#support");
assert.equal(shouldPromptForPersonalSupport({}, now), true);
for (const choice of ["open", "later"]) {
  const state = personalSupportResponse(choice, now);
  assert.equal(shouldPromptForPersonalSupport(state, now + SUPPORT_REMINDER_MS - 1), false);
  assert.equal(shouldPromptForPersonalSupport(state, now + SUPPORT_REMINDER_MS), true);
}
assert.equal(shouldPromptForPersonalSupport(personalSupportResponse("donated", now), now + 10 * SUPPORT_REMINDER_MS), false);
assert.throws(() => personalSupportResponse("other", now), /Unknown personal support prompt choice/);
console.log("Personal support reminder checks passed.");
