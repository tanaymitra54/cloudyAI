'use strict';

const path = require('path');
const { BrowserWindow, screen, nativeImage, Tray, Menu, app } = require('electron');
const config = require('./config');

let overlay = null;
let capture = null;
let tray = null;
let settingsWin = null;

// macOS ignores most "always on top" levels unless we use the screen-saver level
// and mark the window visible on every Space, including full-screen apps.
function pinOnTop(win) {
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Content protection is what keeps the overlay out of Zoom/Meet/Teams shares
  // and screen recordings (NSWindowSharingNone on macOS).
  win.setContentProtection(true);
}

function createOverlay() {
  const cfg = config.load().overlay;
  const { workArea } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    x: Math.round(workArea.x + (workArea.width - cfg.width) / 2),
    y: workArea.y + 60,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
  pinOnTop(overlay);
  overlay.setOpacity(cfg.opacity ?? 0.96);

  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => {
    overlay = null;
  });
  return overlay;
}

// A hidden window that owns the microphone stream and the audio worklet.
// Keeping capture out of the overlay means closing the overlay cannot kill audio.
function createCapture() {
  captureReady = false;
  pendingCaptureCommand = null;
  capture = new BrowserWindow({
    width: 420,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'capture.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  capture.loadFile(path.join(__dirname, '..', 'renderer', 'capture', 'index.html'));
  capture.webContents.once('did-finish-load', () => markCaptureReady());
  capture.on('closed', () => {
    capture = null;
    captureReady = false;
  });
  return capture;
}

/** Settings window: shortcut capture, provider/model, auto-answer. */
function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 540,
    height: 660,
    title: 'TanayAI settings',
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#16171b',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    app.focus({ steal: true });
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  return settingsWin;
}

function getSettings() {
  return settingsWin;
}

/** Send a command to the capture window, tolerating a not-yet-loaded renderer. */
// The renderer's load event is not a reliable readiness signal: isLoading() can
// still report true after the load finished, in which case a queued
// did-finish-load listener never fires and the command is lost. So the renderer
// announces readiness and we queue until then.
let captureReady = false;
let pendingCaptureCommand = null;

function markCaptureReady() {
  captureReady = true;
  if (pendingCaptureCommand) {
    const command = pendingCaptureCommand;
    pendingCaptureCommand = null;
    sendToCapture(command);
  }
}

function sendToCapture(command) {
  const win = capture;
  if (!win || win.isDestroyed()) {
    console.log('[capture] send skipped, no window:', command);
    return false;
  }
  if (!captureReady) {
    console.log('[capture] queued until ready:', command);
    pendingCaptureCommand = command;
    return true;
  }
  try {
    win.webContents.send('tanay:capture-command', command);
    console.log('[capture] sent:', command);
    return true;
  } catch (err) {
    console.log('[capture] send failed, will retry when ready:', err.message);
    captureReady = false;
    pendingCaptureCommand = command;
    return false;
  }
}

function trayIcon() {
  // 22x22 template image drawn in-memory: a ring with a filled centre.
  const size = 22;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = d <= 10 && d >= 7;
      const dot = d <= 3.2;
      const a = ring || dot ? 255 : 0;
      const i = (y * size + x) * 4;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = a; // A
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  img.setTemplateImage(true);
  return img;
}

function buildTray({ onToggle, onListen, onProvider, onQuit, isListening, provider }) {
  if (tray) return tray;
  tray = new Tray(trayIcon());
  tray.setToolTip('TanayAI');
  refreshTray({ onToggle, onListen, onProvider, onQuit, isListening, provider });
  return tray;
}

// "CommandOrControl+J" -> "⌘J" for menu labels.
function toSymbols(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .replace(/CommandOrControl|Command|Cmd/gi, '⌘')
    .replace(/Shift/gi, '⇧')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/\+/g, '');
}

function refreshTray({
  onToggle,
  onListen,
  onAnswer,
  onToggleAuto,
  onProvider,
  onEditShortcuts,
  onSettings,
  onQuit,
  isListening,
  provider,
  autoAnswer,
  hotkeyAnswer,
}) {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: isListening ? 'Stop listening' : 'Start listening', click: onListen },
      { label: `Answer last question  ${hotkeyAnswer || ''}`.trim(), click: onAnswer },
      { type: 'separator' },
      { label: 'Show / hide overlay', click: onToggle },
      {
        label: 'Auto-answer questions',
        type: 'checkbox',
        checked: Boolean(autoAnswer),
        click: () => onToggleAuto(),
      },
      { label: 'Settings…', accelerator: undefined, click: onSettings },
      {
        label: 'Answers from',
        submenu: ['opencode-go', 'deepseek', 'opencode', 'commandcode'].map((p) => ({
          label: p,
          type: 'radio',
          checked: p === provider,
          click: () => onProvider(p),
        })),
      },
      { type: 'separator' },
      { label: 'Quit TanayAI', click: onQuit },
    ])
  );
}

function toggleOverlay() {
  if (!overlay) return createOverlay();
  if (overlay.isVisible()) overlay.hide();
  else {
    overlay.showInactive();
    pinOnTop(overlay);
  }
  return overlay;
}

function getOverlay() {
  return overlay;
}

function getCapture() {
  return capture;
}

module.exports = {
  createOverlay,
  createCapture,
  createSettings,
  getSettings,
  sendToCapture,
  markCaptureReady,
  buildTray,
  refreshTray,
  toggleOverlay,
  getOverlay,
  getCapture,
  pinOnTop,
  toSymbols,
};
