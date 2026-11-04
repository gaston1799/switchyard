import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

const html = await readFile(new URL("../src/ui/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
assert.ok(scripts.length, "desktop UI should contain its renderer script");
for (const [index, source] of scripts.entries()) new Script(source, { filename: `index.html inline script ${index + 1}` });
for (const match of html.matchAll(/<script\s+src="([^"]+)"/g)) {
  const source = await readFile(new URL(`../src/ui/${match[1]}`, import.meta.url), "utf8");
  new Script(source, { filename: match[1] });
}

for (const id of ["prompt", "connection", "model", "attach-image", "image-files", "attachments", "permission", "agent-role", "send"]) {
  assert.match(html, new RegExp(`id=[\"']${id}[\"']`), `desktop composer should include #${id}`);
}
assert.match(html, /addEventListener\("paste"/i, "desktop composer should accept clipboard paste events");
assert.match(html, /window\.deepseekUi\.listModels/, "desktop composer should discover provider models");
assert.match(html, /<option value="coordinator">Coordinator<\/option>/, "desktop composer should allow coordinator role selection");

console.log("Desktop UI renderer self-test passed.");

const blockSource = scripts.join("\n").replace(/\r/g, "").match(/function transcriptBlocks\(messages\) \{[\s\S]*?\n    \}\n/)[0];
const toBlocks = new Script(`(${blockSource})`).runInNewContext();
const blocks = toBlocks([
  { role: "user", content: "Check the workspace" },
  { role: "assistant", reasoning: "private reasoning", content: "I�ll check the workspace.", toolCalls: [{ id: "a", name: "read_text_file", arguments: "{}" }] },
  { role: "tool", toolCallId: "a", content: "file contents" },
  { role: "assistant", reasoning: "more private reasoning", toolCalls: [{ id: "b", name: "run_cmd", arguments: "{}" }] },
  { role: "tool", toolCallId: "b", content: "command result" },
  { role: "assistant", reasoning: "hidden only" },
  { role: "assistant", content: "The workspace is ready." },
]);
assert.equal(blocks.length, 4, "tool replies and reasoning must not create standalone messages");
assert.equal(blocks[2].tools.length, 2, "consecutive tool activity shares one group");
assert.equal(blocks[2].tools[0].result, "file contents");
assert.equal(blocks[2].tools[1].result, "command result");
assert.ok(!JSON.stringify(blocks).includes("private reasoning"));
assert.equal(toBlocks([{ role: "assistant", reasoning: "hidden only" }]).length, 0);
assert.equal(toBlocks([{ role: "tool", content: "orphan result" }])[0].tools[0].result, "orphan result");
console.log("Compact transcript grouping self-test passed.");

const promptSource = scripts.join("\n").replace(/\r/g, "").match(/function hasSubmittedRunPrompt\(messages, run\) \{[\s\S]*?\n    \}/)[0];
const hasSubmittedRunPrompt = new Script(`(${promptSource})`).runInNewContext();
assert.equal(hasSubmittedRunPrompt([
  { role: "system", content: "system" },
  { role: "user", content: "new harness test" },
  { role: "assistant", toolCalls: [{ name: "agent_list" }] },
  { role: "tool", content: "agents" },
], { prompt: "new harness test", messageCountBefore: 0 }), true, "streaming should not append a second copy of a prompt already saved before tool calls");
assert.equal(hasSubmittedRunPrompt([
  { role: "user", content: "same prompt from an older turn" },
], { prompt: "same prompt from an older turn", messageCountBefore: 1 }), false, "a repeated prompt from an earlier turn must not hide the new prompt while streaming");
assert.equal(hasSubmittedRunPrompt([
  { role: "user", content: "describe this image\n\n[The user attached 1 image. Inspect each with tools.]" },
], { prompt: "describe this image", messageCountBefore: 0 }), true, "image instructions appended to the saved user message should not cause a duplicate prompt");
console.log("Streaming prompt deduplication self-test passed.");

const assistantSource = scripts.join("\n").replace(/\r/g, "").match(/function hasRunAssistantMessage\(messages, run\) \{[\s\S]*?\n    \}/)[0];
const hasRunAssistantMessage = new Script(`(${assistantSource})`).runInNewContext();
assert.equal(hasRunAssistantMessage([
  { role: "user", content: "older prompt" },
  { role: "assistant", content: "older answer" },
  { role: "user", content: "new prompt" },
  { role: "assistant", content: "new answer", toolCalls: [{ name: "get_runtime_context" }] },
], { messageCountBefore: 2 }), true, "a persisted assistant turn should replace duplicate live stdout");
assert.equal(hasRunAssistantMessage([
  { role: "user", content: "older prompt" },
  { role: "assistant", content: "older answer" },
], { messageCountBefore: 2 }), false, "live output should remain visible before the current assistant message is saved");
console.log("Streaming assistant deduplication self-test passed.");
