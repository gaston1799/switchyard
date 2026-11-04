// Run with: pbc tab eval Switchyard --file scripts/self-test-sidebar-browser.js --port <debug-port>
(() => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const original = { sessions, runs, projects, selectedSessionPath, query: document.querySelector('#session-search').value };
  const collapsed = new Set(collapsedChatGroups);
  const expanded = new Set(expandedChatGroups);
  try {
    projects = [];
    document.querySelector('#session-search').value = '';
    sessions = Array.from({ length: 7 }, (_, index) => ({
      path: `C:/preview/session-${index}.json`, title: `Preview chat ${index}`,
      coordDir: index % 2 ? 'C:/preview/team' : 'c:\\preview\\team\\',
      workspace: 'C:/preview/project', agentRole: 'worker', active: false
    }));
    sessions.push({ path: 'C:/preview/other.json', title: 'Other chat', coordDir: 'C:/preview/other', active: false });
    selectedSessionPath = sessions[0].path;
    runs = [{ id: 'preview', sessionPath: sessions[0].path, status: 'running' }];
    renderSessions();
    assert(document.querySelectorAll('.chat-folder').length === 2, 'Equivalent coordination paths must share a folder');
    assert(document.querySelectorAll('.chat-row').length === 6, 'Large folders must initially show five chats');
    assert(document.querySelectorAll('.chat-spinner').length === 1, 'Running chat needs exactly one activity spinner');
    const spinner = document.querySelector('.chat-spinner');
    assert(spinner.getAttribute('aria-label') === 'Working', 'Spinner must have an accessible label');
    assert(getComputedStyle(spinner).animationName === 'chat-spin' || matchMedia('(prefers-reduced-motion: reduce)').matches, 'Activity indicator must animate unless reduced motion is enabled');
    document.querySelector('.chat-show-more').click();
    assert(document.querySelectorAll('.chat-row').length === 8, 'Show more must expose hidden chats');
    runs[0].status = 'complete';
    renderSessions();
    assert(!document.querySelector('.chat-spinner'), 'Completed chats must stop spinning');
    runs = [];
    sessions[1].active = true;
    renderSessions();
    assert(document.querySelectorAll('.chat-spinner').length === 1, 'Externally running agents must show activity');
    document.querySelector('#session-search').value = 'Other chat';
    renderSessions();
    assert(document.querySelectorAll('.chat-row').length === 1, 'Search must filter across folders');
    assert(!document.querySelector('[data-page="sessions"]'), 'Redundant Chats navigation must be absent');
    assert(document.querySelector('.window-titlebar .main-nav'), 'Navigation must occupy the title bar');
    assert(!document.querySelector('main > .main-nav'), 'Chat must not lose height to a second navigation row');
    assert(document.querySelector('#new-project') && document.querySelector('#project-picker'), 'Project controls must be visible');
    return { passed: true, checks: 9 };
  } finally {
    sessions = original.sessions;
    projects = original.projects;
    runs = original.runs;
    selectedSessionPath = original.selectedSessionPath;
    document.querySelector('#session-search').value = original.query;
    collapsedChatGroups.clear();
    expandedChatGroups.clear();
    for (const key of collapsed) collapsedChatGroups.add(key);
    for (const key of expanded) expandedChatGroups.add(key);
    renderSessions();
  }
})()
