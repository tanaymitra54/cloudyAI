'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tanay', {
  capture: {
    send: (arrayBuffer) => ipcRenderer.send('tanay:audio', arrayBuffer),
    fail: (message) => ipcRenderer.send('tanay:capture-error', String(message)),
  },
  onCommand: (cb) => ipcRenderer.on('tanay:capture-command', (_e, cmd) => cb(cmd)),
});

// Tell main this renderer can receive commands. Main queues until this arrives,
// because a load-event race can otherwise drop the start command entirely.
ipcRenderer.send('tanay:capture-ready');
