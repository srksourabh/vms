'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('secureGate', {
  health: () => ipcRenderer.invoke('health'),
  openApp: () => ipcRenderer.invoke('open-app'),
});
