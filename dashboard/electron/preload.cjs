const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  selectFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),

  // Update API — invoke (renderer → main)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),

  // Update API — events (main → renderer)
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, data) => cb(data)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:download-progress', (_e, data) => cb(data)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_e, data) => cb(data)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, data) => cb(data)),
  removeUpdateListeners: () => {
    ipcRenderer.removeAllListeners('update:available');
    ipcRenderer.removeAllListeners('update:download-progress');
    ipcRenderer.removeAllListeners('update:downloaded');
    ipcRenderer.removeAllListeners('update:error');
  },
});
