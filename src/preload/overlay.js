'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only plain data crosses the bridge: no ipcRenderer object, no fs, no shell.
contextBridge.exposeInMainWorld('tanay', {
  onCaption: (cb) => ipcRenderer.on('tanay:caption', (_e, text) => cb(text)),
  onTranscript: (cb) => ipcRenderer.on('tanay:transcript', (_e, text) => cb(text)),
  onTranscriptReset: (cb) => ipcRenderer.on('tanay:transcript-reset', () => cb()),
  onAnswerStart: (cb) => ipcRenderer.on('tanay:answer-start', () => cb()),
  onAnswerDelta: (cb) => ipcRenderer.on('tanay:answer-delta', (_e, text) => cb(text)),
  onAnswerEnd: (cb) => ipcRenderer.on('tanay:answer-end', () => cb()),
  onStatus: (cb) => ipcRenderer.on('tanay:status', (_e, s) => cb(s)),
  onError: (cb) => ipcRenderer.on('tanay:error', (_e, message) => cb(message)),
  onMeta: (cb) => ipcRenderer.on('tanay:meta', (_e, meta) => cb(meta)),
  listen: () => ipcRenderer.send('tanay:listen-toggle'),
  askText: (text) => ipcRenderer.send('tanay:ask-text', text),
  screenshot: (text) => ipcRenderer.invoke('tanay:shot', text),
  clear: () => ipcRenderer.send('tanay:clear'),
  settings: () => ipcRenderer.send('tanay:settings'),
  openMicSettings: () => ipcRenderer.send('tanay:open-mic-settings'),
  openScreenSettings: () => ipcRenderer.send('tanay:open-screen-settings'),
  close: () => ipcRenderer.send('tanay:overlay-hide'),
  resize: (height) => ipcRenderer.send('tanay:overlay-resize', height),
});
