// desktop/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {
  getVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
  openDataFolder: () => ipcRenderer.invoke('helix:open-data-folder'),
  saveFile: (payload) => ipcRenderer.invoke('helix:save-file', payload),
});
