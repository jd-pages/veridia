/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("veridiaDesktop", {
  getSystemInfo: () => ipcRenderer.invoke("veridia:get-system-info"),
  checkForUpdates: () => ipcRenderer.invoke("veridia:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("veridia:download-update"),
  installUpdate: () => ipcRenderer.invoke("veridia:install-update"),
  setAutoUpdate: (enabled) =>
    ipcRenderer.invoke("veridia:set-auto-update", Boolean(enabled)),
  openReleaseNotes: () => ipcRenderer.invoke("veridia:open-release-notes"),
  getUpdateStatus: () => ipcRenderer.invoke("veridia:get-update-status"),
  onUpdateStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("veridia:update-status", handler);
    return () => ipcRenderer.removeListener("veridia:update-status", handler);
  },
});
