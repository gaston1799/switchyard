// Run with PBC tab eval --file against the isolated renderer preview.
(() => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const body = document.createElement("div");
  TranscriptUI.renderMarkdown(body, '# Heading\n\n**Bold** and `inline`\n\n- First\n  - Nested\n\n```js\nconst x = "<tag>";\n```\n\n| Key | Value |\n| --- | --- |\n| One | Two |\n\n[Safe](https://example.com)\n\n<script>window.uiInjected=true</script><img src=x onerror="window.uiInjected=true"><iframe src="https://example.com"></iframe>[Unsafe](javascript:alert(1))\n<input type="password" value="test">');
  assert(body.querySelector("h1")?.textContent === "Heading", "Heading missing");
  assert(body.querySelector("strong")?.textContent === "Bold", "Bold missing");
  assert(body.querySelector("li ul li"), "Nested list missing");
  assert(body.querySelector("pre code")?.textContent.includes('<tag>'), "Code must preserve literal HTML");
  assert(body.querySelector("table tbody td")?.textContent === "One", "GFM table missing");
  assert(body.querySelector(".code-copy"), "Code copy button missing");
  assert(!body.querySelector("script,img,iframe,svg,[onerror]"), "Active HTML was not removed");
  assert([...body.querySelectorAll("a")].every(link => !/^javascript:/i.test(link.getAttribute("href") || "")), "Unsafe link survived");
  assert([...body.querySelectorAll("input")].every(input => input.disabled && input.type === "checkbox"), "HTML inputs must be inert");
  assert(Object.keys(window.SwitchyardToolIcons).length === 11, "Expected eleven tool icons");
  assert(!document.querySelector(".history").textContent.includes("HIDDEN REASONING"), "Reasoning appeared");
  assert(document.querySelectorAll(".files-card .file-row").length === 5, "Preview files card missing paths");
  assert(window.uiPreviewSession?.path === "visual-preview", "Run only in the isolated preview");
  renderMessages(uiPreviewSession, "running");
  assert(!document.querySelector(".files-card"), "Files card must wait for the final response");
  renderMessages(uiPreviewSession, "complete");
  assert(document.querySelector(".message.assistant:last-child .files-card"), "Files card must follow the final response");
  return JSON.stringify({ passed: true, checks: ["headings", "emphasis", "nested lists", "code", "tables", "copy button", "HTML sanitization", "safe links", "inert inputs", "11 icons", "hidden reasoning", "files card"] });
})()
