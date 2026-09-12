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
  storePersistentSession: (token) =>
    ipcRenderer.invoke("veridia:store-persistent-session", token),
  clearPersistentSession: () =>
    ipcRenderer.invoke("veridia:clear-persistent-session"),
  saveExportFile: (payload) =>
    ipcRenderer.invoke("veridia:save-export-file", payload),
});
