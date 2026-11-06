'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tanaySettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
  resetShortcuts: () => ipcRenderer.invoke('settings:reset-shortcuts'),
  pickDocument: (kind) => ipcRenderer.invoke('settings:pick-document', kind),
  clearDocument: (kind) => ipcRenderer.invoke('settings:clear-document', kind),
  openConfig: () => ipcRenderer.send('settings:open-config'),
  close: () => ipcRenderer.send('settings:close'),
});
