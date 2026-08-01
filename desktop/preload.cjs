/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("veridiaDesktop", {
  getSystemInfo: () => ipcRenderer.invoke("veridia:get-system-info"),
  getDataLocation: () => ipcRenderer.invoke("veridia:get-data-location"),
  chooseDataDirectory: () =>
    ipcRenderer.invoke("veridia:choose-data-directory"),
  confirmDataDirectory: (dataDirectory) =>
    ipcRenderer.invoke("veridia:confirm-data-directory", dataDirectory),
  migrateDataDirectory: (dataDirectory) =>
    ipcRenderer.invoke("veridia:migrate-data-directory", dataDirectory),
  checkForUpdates: () => ipcRenderer.invoke("veridia:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("veridia:download-update"),
  installUpdate: () => ipcRenderer.invoke("veridia:install-update"),
  setAutoUpdate: (enabled) =>
    ipcRenderer.invoke("veridia:set-auto-update", Boolean(enabled)),
  getUpdateStatus: () => ipcRenderer.invoke("veridia:get-update-status"),
  storePersistentSession: (token) =>
    ipcRenderer.invoke("veridia:store-persistent-session", token),
  clearPersistentSession: () =>
    ipcRenderer.invoke("veridia:clear-persistent-session"),
  saveExportFile: (payload) =>
    ipcRenderer.invoke("veridia:save-export-file", payload),
  onUpdateStatus: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("veridia:update-status", handler);
    return () => ipcRenderer.removeListener("veridia:update-status", handler);
  },
});
