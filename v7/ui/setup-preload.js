const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('setupwin', {
  onData(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('setup:data', listener);
    ipcRenderer.invoke('setup:child', 'ready').then(callback);
    return () => ipcRenderer.removeListener('setup:data', listener);
  },
  action(payload) { return ipcRenderer.invoke('setup:child', 'action', payload || {}); }
});
