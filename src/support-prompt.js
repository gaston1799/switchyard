export const PERSONAL_SUPPORT_URL = "https://gaston1799.github.io/#support";
export const SUPPORT_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;

export function shouldPromptForPersonalSupport(state = {}, now = Date.now()) {
  return state.donated !== true && !(Number(state.nextPromptAt) > now);
}

export function personalSupportResponse(choice, now = Date.now()) {
  if (choice === "donated") return { donated: true, respondedAt: new Date(now).toISOString() };
  if (choice === "open" || choice === "later") {
    return { donated: false, nextPromptAt: now + SUPPORT_REMINDER_MS, respondedAt: new Date(now).toISOString() };
  }
  throw new Error("Unknown personal support prompt choice.");
}
