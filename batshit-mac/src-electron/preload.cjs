const { contextBridge, ipcRenderer } = require('electron');

const zero = Object.freeze({
  invoke(command, payload = {}) {
    return ipcRenderer.invoke('batshit:invoke', command, payload);
  },
  dialogs: Object.freeze({
    saveFile(options = {}) {
      return ipcRenderer.invoke('batshit:save-file', options);
    }
  })
});

contextBridge.exposeInMainWorld('zero', zero);
