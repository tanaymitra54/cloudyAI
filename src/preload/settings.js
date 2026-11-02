'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tanaySettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
  resetShortcuts: () => ipcRenderer.invoke('settings:reset-shortcuts'),
  openConfig: () => ipcRenderer.send('settings:open-config'),
  close: () => ipcRenderer.send('settings:close'),
});
