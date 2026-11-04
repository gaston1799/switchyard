const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekUi", {
  reviewFiles: (sessionPath) => ipcRenderer.invoke("files:review", sessionPath),
  openLink: (url) => ipcRenderer.invoke("app:open-link", url),
  info: () => ipcRenderer.invoke("app:info"),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: () => ipcRenderer.invoke('projects:create'),
  selectProject: (id) => ipcRenderer.invoke('projects:select', id),
  showAppMenu: (input) => ipcRenderer.invoke("app:menu", input),
  listConnections: () => ipcRenderer.invoke("connections:list"),
  listModels: (connectionId) => ipcRenderer.invoke("models:list", connectionId),
  dashboard: () => ipcRenderer.invoke("dashboard:summary"),
  refreshDashboard: () => ipcRenderer.invoke("dashboard:refresh"),
  supportStatus: () => ipcRenderer.invoke("support:status"),
  respondSupport: (choice) => ipcRenderer.invoke("support:respond", choice),
  listRuns: () => ipcRenderer.invoke("runs:list"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  readSession: (path) => ipcRenderer.invoke("sessions:read", path),
  renameSession: (input) => ipcRenderer.invoke("sessions:rename", input),
  startChat: (input) => ipcRenderer.invoke("chat:start", input),
  onRuns: (handler) => {
    const listener = (_event, runs) => handler(runs);
    ipcRenderer.on("runs:update", listener);
    return () => ipcRenderer.off("runs:update", listener);
  },
  onRun: (handler) => {
    const listener = (_event, run) => handler(run);
    ipcRenderer.on("run:update", listener);
    return () => ipcRenderer.off("run:update", listener);
  },
  listAgents: (options) => ipcRenderer.invoke("agents:list", options),
  sendAgentMessage: (input) => ipcRenderer.invoke("agents:send", input),
  listAgentInbox: (agentId) => ipcRenderer.invoke("agents:inbox", agentId),
  listAgentMessages: (agentId) => ipcRenderer.invoke("agents:messages", agentId)
});
