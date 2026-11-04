/* Browser-only transcript presentation. No Node access or model requests. */
window.TranscriptUI = (() => {
  function category(name) {
    if (/mcp/i.test(name)) return "mcp";
    if (/image|photo|vision/i.test(name)) return "image";
    if (/browser|browse|pbc/i.test(name)) return "browser";
    if (/search|fetch|web/i.test(name)) return "search";
    if (/write|edit|patch/i.test(name)) return "edit";
    if (/read|cat_file/i.test(name)) return "read";
    if (/cmd|shell|exec|terminal/i.test(name)) return "terminal";
    if (/agent|coord|handoff/i.test(name)) return "agent";
    if (/plan|goal|task/i.test(name)) return "plan";
    if (/file|glob|directory/i.test(name)) return "files";
    return "tool";
  }
  function icon(name) {
    const type = category(name);
    return `<span aria-hidden="true" class="tool-icon">${window.SwitchyardToolIcons?.[type] || ""}</span>`;
  }
  function renderMarkdown(body, text) {
    body.classList.add("markdown-body");
    if (window.SwitchyardMarkdown) body.innerHTML = window.SwitchyardMarkdown.render(text);
    else body.textContent = text;
    for (const input of body.querySelectorAll("input")) { input.type = "checkbox"; input.disabled = true; }
    for (const link of body.querySelectorAll("a")) {
      link.addEventListener("click", async event => {
        event.preventDefault();
        if (/^https?:\/\//i.test(link.getAttribute("href") || "")) {
          try { await window.deepseekUi?.openLink?.(link.href); }
          catch (error) { link.title = error.message; }
        }
      });
    }
    for (const pre of body.querySelectorAll("pre")) {
      const copy = document.createElement("button");
      copy.className = "code-copy quiet";
      copy.textContent = "Copy code";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || ""); copy.textContent = "Copied"; }
        catch { copy.textContent = "Copy unavailable"; }
      });
      pre.appendChild(copy);
    }
  }
  const cache = new Map();
  function getReview(session, refresh = false) {
    const key = JSON.stringify([session.path, session.updatedAt, session.touchedFiles]);
    if (refresh) cache.delete(key);
    if (!cache.has(key)) {
      if (cache.size > 30) cache.clear();
      cache.set(key, window.deepseekUi?.reviewFiles
        ? window.deepseekUi.reviewFiles(session.path)
        : Promise.reject(new Error("Restart Switchyard to enable file review.")));
    }
    return cache.get(key);
  }
  async function showReview(session, selectedPath) {
    let dialog = document.querySelector("#file-review-dialog");
    if (!dialog) { dialog = document.createElement("dialog"); dialog.id = "file-review-dialog"; document.body.appendChild(dialog); }
    dialog.innerHTML = '<header><h2>Review files</h2><button class="quiet">Close</button></header><p>Loading changes...</p><div class="review-content"></div>';
    dialog.querySelector("button").onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
    const content = dialog.querySelector(".review-content");
    try {
      const review = await getReview(session, true);
      dialog.querySelector("p").textContent = review.baseline;
      for (const file of review.files.filter(file => !selectedPath || file.path === selectedPath)) {
        const title = document.createElement("h3"); title.textContent = file.path; content.appendChild(title);
        const pre = document.createElement("pre"); pre.textContent = file.error || file.diff; content.appendChild(pre);
      }
    } catch (error) { dialog.querySelector("p").textContent = error.message; }
  }
  function appendFilesCard(parent, session) {
    const paths = [...new Set((session.touchedFiles || []).filter(path => typeof path === "string"))];
    if (!paths.length) return;
    const card = document.createElement("section");
    card.className = "files-card";
    card.setAttribute("aria-label", "Files touched in this session");
    card.innerHTML = `<header>${icon("files")}<div><strong>${paths.length} ${paths.length === 1 ? "file" : "files"} touched</strong><span class="file-baseline">Session files · changes compared with HEAD</span></div><button class="quiet">Review</button></header>`;
    card.querySelector("header button").onclick = () => showReview(session);
    const rows = new Map();
    let more;
    paths.forEach((path, index) => {
      if (index === 3) { more = document.createElement("details"); more.className = "files-more"; more.innerHTML = `<summary>Show ${paths.length - 3} more ${paths.length - 3 === 1 ? "file" : "files"}</summary>`; card.appendChild(more); }
      const row = document.createElement("button"); row.className = "file-row";
      const label = document.createElement("span"); label.className = "file-path"; label.textContent = path; row.title = path; row.appendChild(label);
      row.onclick = () => showReview(session, path);
      (more || card).appendChild(row); rows.set(path, row);
    });
    parent.appendChild(card);
    getReview(session).then(review => {
      card.querySelector(".file-baseline").title = review.baseline;
      const counted = review.files.filter(file => Number.isFinite(file.added) && Number.isFinite(file.deleted));
      if (counted.length) {
        const totals = document.createElement("span"); totals.className = "file-totals";
        const added = counted.reduce((sum, file) => sum + file.added, 0);
        const deleted = counted.reduce((sum, file) => sum + file.deleted, 0);
        totals.innerHTML = `${counted.length === paths.length ? "" : "Known changes: "}<span class="diff-added">+${added}</span><span class="diff-deleted">−${deleted}</span>`;
        card.querySelector("strong").after(totals);
      }
      for (const file of review.files) {
        const row = rows.get(file.path);
        if (row && Number.isFinite(file.added) && Number.isFinite(file.deleted)) {
          const stats = document.createElement("span");
          stats.innerHTML = `<span class="diff-added">+${file.added}</span><span class="diff-deleted">−${file.deleted}</span>`;
          row.appendChild(stats);
        } else if (row && file.error) row.title += " · " + file.error;
      }
    }).catch(error => { card.querySelector(".file-baseline").textContent = "Session files · review unavailable"; card.title = error.message; });
  }
  return { icon, renderMarkdown, appendFilesCard };
})();
