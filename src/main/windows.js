'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen, nativeImage, Tray, Menu, app } = require('electron');
const config = require('./config');
const { trayTigerBitmap } = require('./tray-icon');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

let overlay = null;
let capture = null;
let systemCapture = null;
let tray = null;
let settingsWin = null;

// macOS ignores most "always on top" levels unless we use the screen-saver level
// and mark the window visible on every Space, including full-screen apps.
function pinOnTop(win) {
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  // Windows has no Spaces, and setVisibleOnAllWorkspaces is a no-op there.
  if (!IS_WIN) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Content protection is what keeps the overlay out of Zoom/Meet/Teams shares
  // and screen recordings (NSWindowSharingNone on macOS, WDA_EXCLUDEFROMCAPTURE
  // on Windows).
  win.setContentProtection(true);
}

// A kiosk app re-asserts its own window every time it takes the foreground,
// which is enough to push a plain topmost window behind it. Re-applying the
// topmost band and the z-order on a short timer puts the panel back in front
// without ever taking focus away from the app the user is working in.
let topWatchdog = null;
let topWatchdogWin = null;

function ensureOnTop() {
  const win = topWatchdogWin;
  if (!win || win.isDestroyed()) {
    stopTopWatchdog();
    return;
  }
  try {
    // Something minimised us from outside (the overlay cannot minimise itself).
    // Come back, but keep the panel inactive.
    if (win.isMinimized()) {
      win.restore();
      win.showInactive();
    }
    // The user pressed ×; do not fight a deliberate hide.
    if (!win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.moveTop();
  } catch {
    stopTopWatchdog();
  }
}

function startTopWatchdog(win, intervalMs = 900) {
  stopTopWatchdog();
  if (!IS_WIN || !intervalMs) return;
  topWatchdogWin = win;
  topWatchdog = setInterval(ensureOnTop, Math.max(250, Number(intervalMs) || 900));
  topWatchdog.unref?.();
}

function stopTopWatchdog() {
  if (topWatchdog) clearInterval(topWatchdog);
  topWatchdog = null;
  topWatchdogWin = null;
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
  startTopWatchdog(overlay, cfg.keepOnTopMs);
  overlay.setOpacity(cfg.opacity ?? 0.96);

  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => {
    stopTopWatchdog();
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

// A second hidden window that owns the desktop loopback stream on Windows.
// Chromium's getDisplayMedia with audio: 'loopback' captures the computer's own
// output (the other side of a call) without any native helper, so the macOS
// ScreenCaptureKit binary is not needed there.
function createSystemCapture() {
  systemReady = false;
  pendingSystemCommand = null;
  systemCapture = new BrowserWindow({
    width: 320,
    height: 160,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'system-audio.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  systemCapture.loadFile(path.join(__dirname, '..', 'renderer', 'capture', 'system.html'));
  systemCapture.webContents.once('did-finish-load', () => markSystemReady());
  systemCapture.on('closed', () => {
    systemCapture = null;
    systemReady = false;
  });
  return systemCapture;
}

let systemReady = false;
let pendingSystemCommand = null;

function markSystemReady() {
  systemReady = true;
  if (pendingSystemCommand) {
    const command = pendingSystemCommand;
    pendingSystemCommand = null;
    sendToSystem(command);
  }
}

function sendToSystem(command) {
  const win = systemCapture;
  if (!win || win.isDestroyed()) return false;
  if (!systemReady) {
    pendingSystemCommand = command;
    return true;
  }
  try {
    win.webContents.send('tanay:system-command', command);
    return true;
  } catch {
    systemReady = false;
    pendingSystemCommand = command;
    return false;
  }
}

/** Settings window: shortcut capture, provider/model. */
function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 560,
    height: 780,
    minHeight: 400,
    title: 'CloudyAI settings',
    resizable: true,
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
  // The settings window shows provider, model and shortcuts; keep it out of
  // screen shares like the panel.
  settingsWin.setContentProtection(true);
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
  // A template image is a macOS concept: on Windows the taskbar draws the icon
  // as-is, so the black glyph would vanish on a dark taskbar. Use the colour
  // app icon there instead.
  if (IS_WIN) {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    }
  }
  const size = IS_WIN ? 16 : 22;
  // White glyph when the coloured icon is missing, so it still shows on Windows.
  const buf = IS_WIN ? trayTigerBitmap(size, [255, 255, 255]) : trayTigerBitmap(size);
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}

function buildTray({ onToggle, onListen, onProvider, onQuit, isListening, provider }) {
  if (tray) return tray;
  tray = new Tray(trayIcon());
  tray.setToolTip('CloudyAI');
  // A left click toggles the panel. This is a mouse path to the app that no
  // keyboard hook can see, so it keeps working in environments that swallow
  // global hotkeys.
  tray.on('click', () => toggleOverlay());
  refreshTray({ onToggle, onListen, onProvider, onQuit, isListening, provider });
  return tray;
}

/**
 * "CommandOrControl+J" -> "⌘J" on macOS, "Ctrl+J" on Windows/Linux, for menu
 * labels and the overlay footer. The user can rebind anything, so this is
 * derived from the configured accelerator rather than hard-coded.
 */
const MAC_MODS = {
  commandorcontrol: '⌘',
  command: '⌘',
  cmd: '⌘',
  meta: '⌘',
  super: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
};
const PC_MODS = {
  commandorcontrol: 'Ctrl',
  command: 'Ctrl',
  cmd: 'Ctrl',
  meta: 'Super',
  super: 'Super',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
};
const NAMED_LABELS = {
  enter: '↵',
  return: '↵',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: '⌫',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

function toSymbols(accelerator) {
  if (!accelerator) return '';
  const mods = IS_MAC ? MAC_MODS : PC_MODS;
  const parts = String(accelerator)
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (mods[lower]) return mods[lower];
      if (NAMED_LABELS[lower]) return NAMED_LABELS[lower];
      return part.length === 1 ? part.toUpperCase() : part;
    });
  return IS_MAC ? parts.join('') : parts.join('+');
}

function refreshTray({
  onToggle,
  onListen,
  onAnswer,
  onProvider,
  onEditShortcuts,
  onSettings,
  onQuit,
  isListening,
  provider,
  hotkeyAnswer,
}) {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: isListening ? 'Stop listening' : 'Start listening', click: onListen },
      { label: `Answer last question  ${hotkeyAnswer || ''}`.trim(), click: onAnswer },
      { type: 'separator' },
      { label: 'Show / hide overlay', click: onToggle },
      { label: 'Settings…', accelerator: undefined, click: onSettings },
      {
        label: 'Answers from',
        submenu: ['opencode-go', 'commandcode-api', 'deepseek', 'opencode', 'commandcode'].map((p) => ({
          label: p,
          type: 'radio',
          checked: p === provider,
          click: () => onProvider(p),
        })),
      },
      { type: 'separator' },
      { label: 'Quit CloudyAI', click: onQuit },
    ])
  );
}

function toggleOverlay() {
  if (!overlay) return createOverlay();
  if (overlay.isVisible()) overlay.hide();
  else {
    overlay.showInactive();
    pinOnTop(overlay);
    startTopWatchdog(overlay, config.load().overlay?.keepOnTopMs);
  }
  return overlay;
}

function getOverlay() {
  return overlay;
}

function getCapture() {
  return capture;
}

function getSystemCapture() {
  return systemCapture;
}

// ---------------------------------------------------------------- mouse corner
// A passive trigger: watch where the pointer is and fire when it rests in a
// screen corner. Reading the cursor position needs no permission, no hook and
// no elevation, so nothing that filters the keyboard can stop it. Off by
// default; enable it in config.json under overlay.cornerTrigger.
let cornerTimer = null;

function startCornerTrigger(options = {}) {
  if (cornerTimer) return;
  const corner = options.corner || 'top-left';
  const size = Math.max(2, Number(options.size) || 4);
  const dwellMs = Math.max(150, Number(options.dwellMs) || 400);
  const onTrigger = typeof options.onTrigger === 'function' ? options.onTrigger : () => {};
  let enteredAt = 0;
  let armed = true;

  cornerTimer = setInterval(() => {
    if (!armed) return;
    let point;
    let area;
    try {
      point = screen.getCursorScreenPoint();
      area = screen.getDisplayNearestPoint(point).workArea;
    } catch {
      return;
    }

    const left = point.x <= area.x + size;
    const right = point.x >= area.x + area.width - size;
    const top = point.y <= area.y + size;
    const bottom = point.y >= area.y + area.height - size;
    const inside =
      (corner === 'top-left' && left && top) ||
      (corner === 'top-right' && right && top) ||
      (corner === 'bottom-left' && left && bottom) ||
      (corner === 'bottom-right' && right && bottom);

    if (!inside) {
      enteredAt = 0;
      armed = true;
      return;
    }
    if (!enteredAt) {
      enteredAt = Date.now();
      return;
    }
    if (Date.now() - enteredAt >= dwellMs) {
      // Fire once per visit: the pointer is still in the corner after the panel
      // opens, and toggling in a loop would be maddening.
      armed = false;
      enteredAt = 0;
      onTrigger();
    }
  }, 120);

  // Never hold the event loop open just for a pointer poll.
  cornerTimer.unref?.();
}

function stopCornerTrigger() {
  if (cornerTimer) clearInterval(cornerTimer);
  cornerTimer = null;
}

module.exports = {
  createOverlay,
  createCapture,
  createSystemCapture,
  createSettings,
  getSettings,
  sendToCapture,
  sendToSystem,
  markCaptureReady,
  markSystemReady,
  buildTray,
  refreshTray,
  toggleOverlay,
  getOverlay,
  getCapture,
  getSystemCapture,
  pinOnTop,
  startTopWatchdog,
  stopTopWatchdog,
  toSymbols,
  startCornerTrigger,
  stopCornerTrigger,
  IS_MAC,
  IS_WIN,
};
