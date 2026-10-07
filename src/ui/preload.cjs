const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deepseekUi", {
  info: () => ipcRenderer.invoke("app:info"),
  supportStatus: () => ipcRenderer.invoke("support:status"),
  respondSupport: (choice) => ipcRenderer.invoke("support:respond", choice),
  listRuns: () => ipcRenderer.invoke("runs:list"),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  readSession: (path) => ipcRenderer.invoke("sessions:read", path),
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
  listAgentInbox: (agentId) => ipcRenderer.invoke("agents:inbox", agentId)
});
