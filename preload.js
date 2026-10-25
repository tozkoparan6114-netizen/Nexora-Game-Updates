const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lvLauncher', {
  status: () => ipcRenderer.invoke('lv:status'),
  install: () => ipcRenderer.invoke('lv:install'),
  update: () => ipcRenderer.invoke('lv:update'),
  play: () => ipcRenderer.invoke('lv:play'),
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('lv:download-progress');
    ipcRenderer.on('lv:download-progress', (_event, data) => callback(data));
  }
});
