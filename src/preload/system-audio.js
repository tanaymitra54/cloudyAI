'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the hidden desktop-loopback window (Windows system audio).
contextBridge.exposeInMainWorld('tanaySystem', {
  send: (arrayBuffer) => ipcRenderer.send('tanay:system-audio', arrayBuffer),
  fail: (message) => ipcRenderer.send('tanay:system-error', String(message)),
  onCommand: (cb) => ipcRenderer.on('tanay:system-command', (_e, cmd) => cb(cmd)),
});

ipcRenderer.send('tanay:system-ready');
