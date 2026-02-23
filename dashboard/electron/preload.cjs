const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
});
