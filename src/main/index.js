'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain, globalShortcut, systemPreferences, shell, desktopCapturer, screen, dialog, session } = require('electron');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Windows gets system audio from Chromium's own loopback (getDisplayMedia with
// audio: 'loopback'); macOS gets it from the ScreenCaptureKit helper.
const LOOPBACK_IN_RENDERER = IS_WIN;

// ---------------------------------------------------------------- env loading
// No dotenv dependency: read KEY=VALUE lines from .env next to package.json.
function loadEnv() {
  const candidates = [
    path.join(app.getAppPath(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(app.getPath('userData'), '.env'), // survives a Finder launch
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}

loadEnv();

const config = require('./config');
const windows = require('./windows');
const prompts = require('./prompts');
const hotkeys = require('./hotkeys');
const { CloudyVoice } = require('./stt/CloudyVoice');
const { CloudyEar } = require('./stt/CloudyEar');
const { CloudyAudio } = require('./audio/CloudyAudio');
const { MouseClicks } = require('./mouse/MouseClicks');
const { AnswerEngine } = require('./llm');
const { pickQuestion, shouldSkipAnswer, conversationFor } = require('./pick');
const docs = require('./docs');

// ------------------------------------------------------------- resolve binaries
function defaultBinDirs() {
  if (IS_WIN) {
    return [
      process.resourcesPath ? path.join(process.resourcesPath, 'whisper') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'whisper.cpp') : '',
      'C:\\Program Files\\whisper.cpp',
    ].filter(Boolean);
  }
  if (IS_MAC) return ['/opt/homebrew/bin', '/usr/local/bin'];
  return ['/usr/local/bin', '/usr/bin'];
}

function resolveBin(bin, knownDirs = defaultBinDirs()) {
  if (!bin) return bin;
  if (path.isAbsolute(bin)) return bin;
  // On Windows the executable carries .exe even though the config says
  // "whisper-cli"; try the suffixed name first, then the bare one.
  const names = IS_WIN && !path.extname(bin) ? [`${bin}.exe`, bin] : [bin];
  for (const dir of knownDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return bin; // let the OS resolve it on PATH
}

/**
 * Where the Parakeet helper lives: an explicit config path, the copy
 * electron-builder puts in Contents/Resources, or the SwiftPM build in dev.
 */
function resolveEarBin() {
  const cfg = config.load().cloudyvoice;
  if (cfg.parakeetBin && fs.existsSync(cfg.parakeetBin)) return cfg.parakeetBin;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'cloudy-ear');
    if (fs.existsSync(bundled)) return bundled;
  }

  const dev = path.join(app.getAppPath(), 'native', 'CloudyEar', '.build', 'release', 'CloudyEar');
  if (fs.existsSync(dev)) return dev;
  return '';
}

/** Where the system-audio helper lives (bundled copy or the SwiftPM build). */
function resolveAudioBin() {
  const cfg = config.load().cloudyvoice;
  if (cfg.audioBin && fs.existsSync(cfg.audioBin)) return cfg.audioBin;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'cloudy-audio');
    if (fs.existsSync(bundled)) return bundled;
  }

  const dev = path.join(app.getAppPath(), 'native', 'CloudyAudio', '.build', 'release', 'CloudyAudio');
  if (fs.existsSync(dev)) return dev;
  return '';
}

/**
 * Where the global mouse-click helper lives. Windows only: it installs a
 * low-level mouse hook so three clicks anywhere can be recognised without a
 * keyboard shortcut.
 */
function resolveMouseBin() {
  if (!IS_WIN) return '';
  const cfg = config.load().overlay?.mouseTrigger || {};
  if (cfg.bin && fs.existsSync(cfg.bin)) return cfg.bin;

  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'mouse', 'CloudyMouse.exe');
    if (fs.existsSync(bundled)) return bundled;
  }

  const dev = path.join(app.getAppPath(), 'vendor', 'mouse', 'CloudyMouse.exe');
  if (fs.existsSync(dev)) return dev;
  return '';
}

// ------------------------------------------------------------ question detection
const { stripFiller } = require('./detection');
// ------------------------------------------------------------------- app state
// Two recognisers run side by side: `them` reads the system loopback and `me`
// reads the microphone. They share one Parakeet model (see startListening).
let themVoice = null;
let meVoice = null;
let sharedEar = null;
// The recogniser that most recently produced speech. ⌘J answers the newest
// utterance regardless of which side of the call it came from.
let lastActiveVoice = null;
let systemAudio = null;
let engine = null;
let listening = false;
let turns = [];
let resumeText = '';
let jobDescriptionText = '';
let lastAnswered = { text: '', at: 0, utteranceId: null };
let starting = false; // guards against overlapping getUserMedia requests

function overlaySend(channel, payload) {
  const win = windows.getOverlay();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Every running recogniser, labelled by speaker. */
function allVoices() {
  return [themVoice, meVoice].filter(Boolean);
}

/** The source that spoke most recently, or null when nobody is running. */
function activeVoice() {
  let best = null;
  let bestAt = 0;
  for (const candidate of allVoices()) {
    const at = candidate.activityAt;
    if (at >= bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return best || lastActiveVoice || null;
}

// provider id -> config section (they differ in case for opencode-go)
const SECTIONS = {
  'opencode-go': 'opencodeGo',
  'commandcode-api': 'commandCodeApi',
  deepseek: 'deepseek',
  opencode: 'opencode',
  commandcode: 'commandcode',
};

// Providers that take a key typed into Settings, mapped to their config section.
const KEY_SECTIONS = {
  'opencode-go': 'opencodeGo',
  'commandcode-api': 'commandCodeApi',
  deepseek: 'deepseek',
};

/** The configured key for an action, drawn the way this platform writes keys. */
function hotkeyLabel(action) {
  const cfg = config.load();
  return windows.toSymbols(cfg.hotkeys?.[action]) || '';
}

function metaLine() {
  const cfg = config.load();
  const section = cfg[SECTIONS[cfg.provider] || cfg.provider] || {};
  const model = section.model || cfg.provider;
  const mode = `${hotkeyLabel('answer') || 'answer'} to answer`;
  return `${cfg.provider} · ${model} · ${mode} · ${turns.length} turns`;
}

function pushMeta() {
  overlaySend('tanay:meta', metaLine());
}

/** Shared by the ⌘⇧R hotkey and the tray; resets answers and transcript state. */
function clearSession() {
  turns = [];
  lastAnswered = { text: '', at: 0, utteranceId: null };
  engine?.cancel();
  // Drop the in-flight utterance too, not just the visible text.
  for (const v of allVoices()) v.clear();
  overlaySend('tanay:caption', { text: '', speaker: 'them' });
  overlaySend('tanay:transcript-reset');
  overlaySend('tanay:answer-start');
  overlaySend('tanay:answer-end');
  pushMeta();
}

/** Read the shortcut map from config and register it. Failures are reported, never fatal. */
let lastHotkeyResult = { registered: [], failures: [] };
function applyHotkeys() {
  const cfg = config.load();
  const result = hotkeys.apply(cfg.hotkeys, {
    answer: () => answerNow(),
    answerLastUtterance: () => ask(),
    screenshot: () => screenshotHotkey(),
    send: () => sendHotkey(),
    toggleOverlay: () => windows.toggleOverlay(),
    toggleListening: () => toggleListening(),
    clear: () => clearSession(),
  });
  lastHotkeyResult = result;
  console.log('[hotkeys]', result.registered.map((r) => `${r.action}=${r.accelerator}`).join(' '));
  if (result.failures.length) console.log('[hotkeys] failed', JSON.stringify(result.failures));

  if (result.failures.length) {
    const list = result.failures.map((f) => `${f.action} (${f.accelerator}) — ${f.reason}`).join('\n');
    overlaySend('tanay:error', `Shortcut not registered\n${list}`);
  }
  return result;
}

/**
 * The mouse-only fallback for summoning the panel. It only reads the pointer
 * position, so a keyboard hook cannot see or block it. Configured in
 * config.json under overlay.cornerTrigger; re-applied live like the hotkeys.
 */
function applyCornerTrigger() {
  const opts = config.load().overlay?.cornerTrigger || {};
  windows.stopCornerTrigger();
  if (!opts.enabled) return;
  windows.startCornerTrigger({
    corner: opts.corner,
    size: opts.size,
    dwellMs: opts.dwellMs,
    onTrigger: () => windows.toggleOverlay(),
  });
  console.log('[corner] toggle armed at', opts.corner || 'top-left');
}

/**
 * Three clicks anywhere summons the panel. A mouse hook is the only way to see
 * clicks that land on another app, which is why this uses a helper process.
 * Off by default; see overlay.mouseTrigger in config.json.
 */
let mouseWatcher = null;
let clickTimes = [];

function applyMouseTrigger() {
  const opts = config.load().overlay?.mouseTrigger || {};
  if (mouseWatcher) {
    mouseWatcher.stop();
    mouseWatcher = null;
  }
  clickTimes = [];

  if (!IS_WIN || !opts.enabled) return;

  const bin = resolveMouseBin();
  if (!bin) {
    overlaySend(
      'tanay:error',
      'The click trigger is on, but CloudyMouse.exe is missing from this build.\nReinstall, or use the corner trigger / the panel buttons.'
    );
    return;
  }

  const needed = Math.min(5, Math.max(2, Number(opts.clicks) || 3));
  const windowMs = Math.min(4000, Math.max(300, Number(opts.windowMs) || 1200));

  mouseWatcher = new MouseClicks({ bin });
  mouseWatcher.on('error', (message) => console.log('[mouse]', message));
  mouseWatcher.on('click', () => {
    const now = Date.now();
    clickTimes.push(now);
    while (clickTimes.length && now - clickTimes[0] > windowMs) clickTimes.shift();
    if (clickTimes.length >= needed) {
      clickTimes = [];
      windows.toggleOverlay();
    }
  });
  if (mouseWatcher.start()) console.log(`[mouse] ${needed} clicks within ${windowMs}ms toggles the panel`);
}

// Editing config.json while the app runs re-applies shortcuts immediately.
let configWatchTimer = null;
function watchConfig() {
  try {
    const dir = path.dirname(config.file());
    fs.watch(dir, (_event, filename) => {
      if (filename && filename !== 'config.json') return;
      clearTimeout(configWatchTimer);
      configWatchTimer = setTimeout(() => {
        try {
          config.reload();
          applyHotkeys();
          applyCornerTrigger();
          applyMouseTrigger();
          windows.startTopWatchdog(windows.getOverlay(), config.load().overlay?.keepOnTopMs);
          loadContextDocs({ quiet: true }).catch(() => {});
          overlaySend('tanay:meta', metaLine());
          windows.refreshTray(trayState());
        } catch (err) {
          overlaySend('tanay:error', `config.json could not be applied: ${err.message}`);
        }
      }, 250);
    });
  } catch {
    // Watching is a convenience; losing it must not stop the app.
  }
}

/**
 * Read the session documents once and keep the text in memory. A CV or job
 * description is large, so this is async and re-run only when settings change.
 */
async function loadContextDocs({ quiet = false } = {}) {
  const cfg = config.load();
  const problems = [];
  try {
    resumeText = await docs.loadText(cfg.resumePath, 'CV');
  } catch (err) {
    resumeText = '';
    problems.push(err.message);
  }
  try {
    const pasted = String(cfg.jobDescription || '').trim();
    jobDescriptionText = pasted || (await docs.loadText(cfg.jobDescriptionPath, 'job description'));
  } catch (err) {
    jobDescriptionText = '';
    problems.push(err.message);
  }
  if (!quiet) for (const message of problems) overlaySend('tanay:error', message);
  return problems;
}

// ---------------------------------------------------------------- answer flow
function ask(triggerText, { images = null, utteranceId = null } = {}) {
  const cfg = config.load();
  const transcript = triggerText || turns.slice(-1).map((t) => t.text).join('\n');
  if (!transcript.trim()) return;

  lastAnswered = { text: transcript, at: Date.now(), utteranceId };
  overlaySend('tanay:answer-start');
  engine.ask({
    system: prompts.systemPrompt(cfg.profile, {
      screenshot: Boolean(images?.length),
      sessionPrompt: cfg.sessionPrompt,
    }),
    user: prompts.buildUserPrompt({
      transcript,
      conversation: conversationFor(turns, transcript),
      resume: resumeText,
      jobDescription: jobDescriptionText,
      profile: cfg.profile,
      screenshot: Boolean(images?.length),
    }),
    images,
  });
}

/**
 * A typed question is its own turn: there is no speech to interpret, so the
 * text goes in the transcript slot and the speech context is left out.
 */
// What the model is asked when the user sends screenshots with an empty box.
const SCREENSHOT_DEFAULT_PROMPT =
  'Answer based on what is on this screen. If there is a question or task, answer it; if not, say what is on the screen and what I can do next.';

// Screenshots are held in the renderer until Send is pressed, so a stray
// capture costs nothing. Cap the batch so one request stays small.
const MAX_SCREENSHOTS = 5;

function askTyped(text, { images = null } = {}) {
  let typed = String(text || '').trim();
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!typed && !hasImages) return;
  if (!typed) typed = SCREENSHOT_DEFAULT_PROMPT;

  const cfg = config.load();
  lastAnswered = { text: typed, at: Date.now(), utteranceId: null };
  overlaySend('tanay:answer-start');
  engine.ask({
    system: prompts.systemPrompt(cfg.profile, {
      screenshot: hasImages,
      sessionPrompt: cfg.sessionPrompt,
    }),
    user: prompts.buildUserPrompt({
      transcript: typed,
      context: [],
      resume: resumeText,
      jobDescription: jobDescriptionText,
      profile: cfg.profile,
      screenshot: hasImages,
    }),
    images,
  });
}

/**
 * Capture the display the pointer is on and attach it to the question.
 * The overlay sets content protection, so it never appears in the image.
 */
async function captureScreen() {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    throw new Error(
      'Screen Recording is off for CloudyAI.\nSystem Settings → Privacy & Security → Screen Recording → enable CloudyAI, then try again.'
    );
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  // 1600 px wide is plenty for text the model has to read, and keeps the
  // base64 payload (and therefore the request) small.
  const width = Math.min(Math.round(display.size.width * scale), 1600);
  const height = Math.round((width * display.size.height) / display.size.width);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(
      IS_MAC
        ? 'Could not read the screen.\nGrant Screen Recording to CloudyAI in System Settings → Privacy & Security.'
        : 'Could not read the screen.\nClose any app that may be blocking screen capture and try again.'
    );
  }
  return source.thumbnail.toDataURL();
}

/**
 * Capture the display the pointer is on and hand the image back to the
 * overlay. Nothing is sent to the model here — the user collects one or more
 * shots, previews them, and presses Send.
 * The overlay sets content protection, so it never appears in the image.
 */
async function captureScreenshot() {
  overlaySend('tanay:status', 'capturing');
  try {
    const dataUrl = await captureScreen();

    // Debug aid: CLOUDY_SHOT_DUMP=/tmp/shot.png keeps the exact image captured.
    if (process.env.CLOUDY_SHOT_DUMP) {
      try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(process.env.CLOUDY_SHOT_DUMP, Buffer.from(base64, 'base64'));
        console.log('[shot] saved', process.env.CLOUDY_SHOT_DUMP);
      } catch (err) {
        console.log('[shot] could not save image:', err.message);
      }
    }

    return { ok: true, dataUrl };
  } catch (err) {
    overlaySend('tanay:error', err.message);
    overlaySend('tanay:status', 'error');
    return { ok: false, error: err.message };
  }
}

/**
 * Global shortcut: capture a screenshot and put it in the composer's queue.
 * It stays a preview until Send (⌘↵) — the same rule as the camera button, so
 * a stray shortcut costs nothing and is never sent to the model by accident.
 */
async function screenshotHotkey() {
  const win = windows.getOverlay();
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.showInactive();
    windows.pinOnTop(win);
  }
  const result = await captureScreenshot();
  if (result.ok) overlaySend('tanay:shot', { dataUrl: result.dataUrl });
}

/** Global shortcut: send whatever is in the composer (text + screenshots). */
function sendHotkey() {
  const win = windows.getOverlay();
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.showInactive();
    windows.pinOnTop(win);
  }
  overlaySend('tanay:send');
}

function onFinalTranscript(text, meta = {}) {
  const speaker = meta.speaker === 'me' ? 'me' : 'them';
  turns.push({
    text,
    at: meta.speechEndAt || Date.now(),
    utteranceId: meta.utteranceId ?? null,
    speaker,
  });
  if (turns.length > 200) turns = turns.slice(-200);

  // The live line is now committed as a chat bubble below.
  overlaySend('tanay:caption', { text: '', speaker });
  overlaySend('tanay:transcript', { text, speaker });
  pushMeta();
}

/**
 * The newest question ⌘J should answer, including text that is still in
 * flight. `pick.js` never walks back past the newest utterance to find a
 * better-scoring older one.
 */
function currentPick() {
  // Only the source that is actually talking (or just finished) can have text
  // in flight. Reading both at once would splice "them" and "me" together.
  const live = activeVoice();
  const picked = pickQuestion({
    turns,
    partial: (live?.partialText || '').trim(),
    pendingText: (live?.pendingText || '').trim(),
    speaking: Boolean(live?.speaking),
    now: Date.now(),
    maxAgeMs: 20000,
  });
  // In-flight text has no id in the picker; attach the live utterance so the
  // duplicate-answer guard can see it. While speaking, the live utterance is
  // the next id, not the one that just closed.
  const liveId = live?.speaking ? (live.utteranceId || 0) + 1 : live?.utteranceId;
  if (picked && picked.source !== 'turn' && liveId) {
    picked.utteranceId = liveId;
  }
  return picked;
}

/** Wait for the decode that is already running, but never longer than timeoutMs. */
function waitForFinal(timeoutMs) {
  const waiting = allVoices().filter((v) => v.finalizing);
  if (!waiting.length) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const listeners = [];
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [v, fn] of listeners) v.removeListener('final', fn);
      resolve();
    }
    for (const v of waiting) {
      const onFinal = () => finish();
      listeners.push([v, onFinal]);
      v.once('final', onFinal);
    }
  });
}

/** Hotkey path: no debounce, no waiting for the utterance to close. */
async function answerNow() {
  let picked = currentPick();

  // The utterance just closed and its decode is in flight. Wait for it rather
  // than falling back to the previous question.
  if (!picked?.text && allVoices().some((v) => v.finalizing)) {
    await waitForFinal(700);
    picked = currentPick();
  }

  const pickedText = String(picked?.text || '').trim();
  // A line that is only filler ("right, so, um") carries no question, but the
  // conversation still does. Fall back to the newest real line instead of
  // spending nothing and showing an error.
  const conversation = conversationFor(turns, pickedText);
  const question = pickedText && stripFiller(pickedText) ? pickedText : conversation[conversation.length - 1] || '';

  if (!question) {
    overlaySend('tanay:error', `Nothing heard yet — start listening first (${hotkeyLabel('toggleListening')}).`);
    overlaySend('tanay:status', listening ? 'listening' : 'idle');
    return;
  }

  // Only block when this exact utterance is already being answered. A new but
  // similar-sounding question must still go through.
  if (shouldSkipAnswer({ engineBusy: engine.busy, lastAnswered, picked })) {
    overlaySend('tanay:status', 'answering');
    overlaySend('tanay:error', `Already answering this question.\nPress ${hotkeyLabel('answerLastUtterance')} to force a new answer.`);
    return;
  }

  ask(question, { utteranceId: picked?.utteranceId ?? null });
}

// Registered before any window exists: a renderer can call these the moment
// it finishes loading, which is earlier than the end of app startup.
function registerIpcHandlers() {
  ipcMain.on('tanay:audio', (event, buffer) => {
    if (event.sender !== windows.getCapture()?.webContents) return; // only the capture window
    if (!listening) return;
    meVoice?.push(new Int16Array(buffer));
  });

  // Windows system audio: the hidden loopback window feeds the "them" recogniser.
  ipcMain.on('tanay:system-audio', (event, buffer) => {
    if (event.sender !== windows.getSystemCapture()?.webContents) return;
    if (!listening) return;
    themVoice?.push(new Int16Array(buffer));
  });

  ipcMain.on('tanay:system-ready', (event) => {
    if (event.sender !== windows.getSystemCapture()?.webContents) return;
    windows.markSystemReady();
  });

  ipcMain.on('tanay:system-error', (event, message) => {
    if (event.sender !== windows.getSystemCapture()?.webContents) return;
    // Loopback failed, but the microphone leg is independent and keeps running.
    themVoice?.stop();
    themVoice = null;
    overlaySend('tanay:error', `System audio unavailable: ${message}\nYour microphone is still being transcribed.`);
    overlaySend('tanay:status', listening ? 'listening' : 'error');
    windows.refreshTray(trayState());
  });

  // The renderer is where getUserMedia actually fails (denied permission,
  // no input device), so surface its error in the overlay instead of silently idling.
  ipcMain.on('tanay:capture-ready', (event) => {
    if (event.sender !== windows.getCapture()?.webContents) return;
    windows.markCaptureReady();
  });

  ipcMain.on('tanay:capture-error', (event, message) => {
    if (event.sender !== windows.getCapture()?.webContents) return;
    // Only the microphone leg failed. System audio may still be running, so the
    // session keeps going and the other participant is still transcribed.
    meVoice?.stop();
    meVoice = null;
    // Not every capture failure is a permission problem; do not claim it is.
    const permissionProblem = /notallowed|permission|denied/i.test(message);
    overlaySend(
      'tanay:error',
      permissionProblem
        ? `Microphone unavailable: ${message}\nYour voice will not be transcribed; the other side still is.`
        : `Microphone capture failed: ${message}`
    );
    overlaySend('tanay:status', listening ? 'listening' : 'error');
    windows.refreshTray(trayState());
    // If it was a permission problem, wait for the switch to flip and resume.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      watchMicrophonePermission();
    }
  });

  ipcMain.on('tanay:open-mic-settings', () => {
    shell.openExternal(
      IS_MAC ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : 'ms-settings:privacy-microphone'
    );
  });

  ipcMain.on('tanay:open-screen-settings', () => {
    shell.openExternal(
      IS_MAC
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        : 'ms-settings:privacy-screenshots'
    );
  });

  ipcMain.on('tanay:listen-toggle', () => {
    toggleListening();
    pushMeta();
  });

  ipcMain.on('tanay:clear', () => clearSession());

  // Typed questions and screenshot questions come from the overlay composer.
  // Images are collected in the overlay and only arrive here on Send.
  ipcMain.on('tanay:ask-text', (_event, text, images) =>
    askTyped(text, {
      images: Array.isArray(images) ? images.filter((img) => typeof img === 'string').slice(0, MAX_SCREENSHOTS) : null,
    })
  );
  ipcMain.handle('tanay:capture', () => captureScreenshot());

  ipcMain.on('tanay:overlay-hide', () => windows.getOverlay()?.hide());
  ipcMain.on('tanay:settings', () => windows.createSettings());

  // ------------------------------------------------------------------ settings
  ipcMain.on('settings:close', () => windows.getSettings()?.close());
  ipcMain.on('settings:open-config', () => shell.openPath(config.file()));

  ipcMain.handle('settings:get', async () => {
    const cfg = config.load();
    const opencodego = require('./llm/opencodego');
    const commandcodeapi = require('./llm/commandcodeapi');
    const [answerModels, commandCodeModels] = await Promise.all([
      opencodego.listModels(cfg.opencodeGo).catch(() => []),
      commandcodeapi.listModels(cfg.commandCodeApi).catch(() => []),
    ]);
    return {
      hotkeys: cfg.hotkeys,
      defaults: config.DEFAULTS.hotkeys,
      provider: cfg.provider,
      visionModel: cfg.visionModel || '',
      session: {
        prompt: cfg.sessionPrompt || '',
        jobDescriptionText: cfg.jobDescription || '',
        jobDescriptionFile: cfg.jobDescriptionPath ? path.basename(cfg.jobDescriptionPath) : '',
        jobDescriptionChars: jobDescriptionText.length,
        resumeFile: cfg.resumePath ? path.basename(cfg.resumePath) : '',
        resumeChars: resumeText.length,
      },
      models: {
        opencodeGo: cfg.opencodeGo.model,
        commandCodeApi: cfg.commandCodeApi.model,
        deepseek: cfg.deepseek.model,
      },
      answerModels,
      commandCodeModels,
      hasKey: {
        'opencode-go': Boolean(cfg.opencodeGo.apiKey),
        'commandcode-api': Boolean(cfg.commandCodeApi.apiKey),
        deepseek: Boolean(cfg.deepseek.apiKey),
      },
      keysFromEnv: {
        'opencode-go': Boolean(process.env.OPENCODE_API_KEY),
        'commandcode-api': Boolean(process.env.COMMANDCODE_API_KEY),
        deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
      },
      transcription: {
        engine: cfg.cloudyvoice.engine,
        source: cfg.cloudyvoice.source,
        captureSystem: cfg.cloudyvoice.captureSystem !== false,
        captureMic: cfg.cloudyvoice.captureMic !== false,
        parakeetAvailable: Boolean(resolveEarBin()),
        audioAvailable: Boolean(resolveAudioBin()),
        modelPath: config.resolveModelPath(),
        available: config.listModels(),
      },
      configPath: config.file(),
    };
  });

  ipcMain.handle('settings:reset-shortcuts', () => config.DEFAULTS.hotkeys);

  // Upload a CV / job description: picked, copied into <userData>/context,
  // text extracted here, and the config updated in one step.
  ipcMain.handle('settings:pick-document', async (_event, kind) => {
    const isResume = kind === 'resume';
    const picked = await dialog.showOpenDialog(windows.getSettings(), {
      title: isResume ? 'Choose your CV' : 'Choose the job description',
      buttonLabel: 'Use this file',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'txt', 'md', 'markdown'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };

    const source = picked.filePaths[0];
    try {
      const info = await docs.importDocument(isResume ? 'resume' : 'job-description', source);
      if (isResume) {
        config.save({ resumePath: info.path });
      } else {
        // A file replaces pasted text; only one source of truth.
        config.save({ jobDescriptionPath: info.path, jobDescription: '' });
      }
      await loadContextDocs({ quiet: true });
      pushMeta();
      return { ok: true, ...info };
    } catch (err) {
      return { canceled: false, ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:clear-document', async (_event, kind) => {
    const isResume = kind === 'resume';
    docs.removeDocument(isResume ? 'resume' : 'job-description');
    config.save(isResume ? { resumePath: '' } : { jobDescriptionPath: '', jobDescription: '' });
    await loadContextDocs({ quiet: true });
    pushMeta();
    return { ok: true };
  });

  ipcMain.handle('settings:save', async (_event, payload = {}) => {
    const patch = {};
    if (payload.hotkeys) patch.hotkeys = payload.hotkeys;

    if (payload.provider) patch.provider = payload.provider;
    if (typeof payload.visionModel === 'string') patch.visionModel = payload.visionModel.trim();
    if (typeof payload.sessionPrompt === 'string') {
      patch.sessionPrompt = payload.sessionPrompt.trim().slice(0, 4000);
    }
    // Pasted job description. Skipped while an uploaded file is attached, so
    // Save cannot silently erase the file by sending an empty box.
    if (typeof payload.jobDescriptionText === 'string' && !payload.keepJobDescriptionFile) {
      const text = payload.jobDescriptionText.trim().slice(0, docs.MAX_CHARS);
      patch.jobDescription = text;
      if (text) patch.jobDescriptionPath = '';
    }

    if (payload.models) {
      patch.opencodeGo = {};
      patch.commandCodeApi = {};
      patch.deepseek = {};
      if (typeof payload.models.opencodeGo === 'string' && payload.models.opencodeGo)
        patch.opencodeGo.model = payload.models.opencodeGo;
      if (typeof payload.models.commandCodeApi === 'string' && payload.models.commandCodeApi)
        patch.commandCodeApi.model = payload.models.commandCodeApi;
      if (typeof payload.models.deepseek === 'string' && payload.models.deepseek)
        patch.deepseek.model = payload.models.deepseek;
    }

    // An empty key field means "keep what is stored"; a typed one replaces it.
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const section = KEY_SECTIONS[payload.provider];
      if (section) patch[section] = { ...(patch[section] || {}), apiKey: payload.apiKey.trim() };
    }

    if (payload.transcription && typeof payload.transcription.modelPath === 'string') {
      patch.cloudyvoice = { modelPath: payload.transcription.modelPath };
      if (payload.transcription.engine === 'whisper' || payload.transcription.engine === 'parakeet') {
        patch.cloudyvoice.engine = payload.transcription.engine;
      }
      if (typeof payload.transcription.captureSystem === 'boolean') {
        patch.cloudyvoice.captureSystem = payload.transcription.captureSystem;
      }
      if (typeof payload.transcription.captureMic === 'boolean') {
        patch.cloudyvoice.captureMic = payload.transcription.captureMic;
      }
      // A source change (old single-source control) maps onto the two flags.
      if (payload.transcription.source === 'system') patch.cloudyvoice.captureSystem = true;
      if (payload.transcription.source === 'mic') patch.cloudyvoice.captureMic = true;
    }

    config.save(patch);
    const result = applyHotkeys();
    // Keep the in-memory CV / job description in step with the saved file.
    await loadContextDocs({ quiet: true });

    // Any recogniser change has to reach the running pipeline, not just the file.
    if (themVoice || meVoice) {
      const wasListening = listening;
      const engineChanged =
        patch.cloudyvoice?.engine &&
        patch.cloudyvoice.engine !== (themVoice || meVoice)?.cfg.engine;
      if (wasListening) stopListening();
      if (engineChanged) shutdownVoices();
      if (wasListening) startListening();
    }

    windows.refreshTray(trayState());
    pushMeta();

    const cfg = config.load();
    return {
      ok: result.failures.length === 0,
      failures: result.failures,
      registered: result.registered,
      models: {
        opencodeGo: cfg.opencodeGo.model,
        commandCodeApi: cfg.commandCodeApi.model,
        deepseek: cfg.deepseek.model,
      },
      hasKey: {
        'opencode-go': Boolean(cfg.opencodeGo.apiKey),
        'commandcode-api': Boolean(cfg.commandCodeApi.apiKey),
        deepseek: Boolean(cfg.deepseek.apiKey),
      },
    };
  });

  ipcMain.handle('tanay:open-config', () => shell.openPath(path.dirname(config.file())));
}

// ------------------------------------------------------------- listening toggle
async function startListening() {
  if (listening || starting) return;
  starting = true;

  try {
    const cfg = config.load();
    const captureSystem = cfg.cloudyvoice.captureSystem !== false;
    const captureMic = cfg.cloudyvoice.captureMic !== false;

    if (!captureSystem && !captureMic) {
      overlaySend(
        'tanay:error',
        'Both audio sources are off.\nOpen Settings (⚙) and enable system audio, the microphone, or both.'
      );
      overlaySend('tanay:status', 'error');
      return;
    }

    // A source that was turned off in Settings must not linger from the
    // previous session.
    if (!captureSystem) {
      themVoice?.stop();
      themVoice = null;
      systemAudio?.stop();
      systemAudio = null;
    }
    if (!captureMic && meVoice) {
      meVoice.stop();
      meVoice = null;
    }

    // Shared recogniser configuration for both sources.
    cfg.cloudyvoice.modelPath = config.resolveModelPath();
    cfg.cloudyvoice.partialModelPath = config.resolvePartialModelPath();
    cfg.cloudyvoice.bin = resolveBin(cfg.cloudyvoice.bin);

    // One Parakeet model, kept in memory, shared by both sources. Loading it
    // twice would double memory for no gain.
    if (cfg.cloudyvoice.engine === 'parakeet') {
      const earBin = resolveEarBin();
      if (earBin) {
        cfg.cloudyvoice.parakeetBin = earBin;
        if (!sharedEar) {
          sharedEar = new CloudyEar({ bin: earBin, modelsDir: cfg.cloudyvoice.parakeetModelsDir });
          sharedEar.on('loading', () => overlaySend('tanay:status', 'loading'));
          sharedEar.on('progress', (percent) =>
            overlaySend('tanay:status', `loading speech model… ${percent}%`)
          );
          sharedEar.on('ready', () => overlaySend('tanay:status', listening ? 'listening' : 'idle'));
          sharedEar.on('error', (message) => overlaySend('tanay:error', `Parakeet: ${message}`));
        }
      } else {
        cfg.cloudyvoice.engine = 'whisper';
        overlaySend(
          'tanay:error',
          'Parakeet helper is not built — using whisper for now.\nRun: npm run build:ear, then restart CloudyAI.'
        );
      }
    }

    let systemReady = false;
    let micReady = false;

    // ---------------------------------------------------- the other side (them)
    if (captureSystem) {
      if (LOOPBACK_IN_RENDERER) {
        // Windows: Chromium's own WASAPI loopback, no helper binary involved.
        themVoice = ensureVoice('them', cfg.cloudyvoice);
        if (themVoice.start()) {
          systemReady = windows.sendToSystem('start') !== false;
        }
      } else if (!IS_MAC) {
        cfg.cloudyvoice.captureSystem = false;
        overlaySend(
          'tanay:error',
          'System audio capture is not supported on this platform.\nOnly your microphone will be transcribed.'
        );
      } else {
        const audioBin = resolveAudioBin();
        if (!audioBin) {
          overlaySend(
            'tanay:error',
            'System audio helper is not built.\nRun: npm run build:audio, then restart CloudyAI.'
          );
        } else {
          cfg.cloudyvoice.audioBin = audioBin;
          themVoice = ensureVoice('them', cfg.cloudyvoice);
          if (themVoice.start()) {
            if (!systemAudio) {
              systemAudio = new CloudyAudio({ bin: audioBin });
              systemAudio.on('audio', (pcm) => {
                if (listening) themVoice?.push(pcm);
              });
              systemAudio.on('error', (message, info = {}) => {
                overlaySend(
                  'tanay:error',
                  info.fatal
                    ? `Screen & System Audio Recording is off for CloudyAI.\nSystem Settings → Privacy & Security → Screen & System Audio Recording → enable CloudyAI, then press ${hotkeyLabel('toggleListening')} (or relaunch).`
                    : message
                );
                if (info.fatal) {
                  themVoice?.stop();
                  themVoice = null;
                  // The microphone leg can keep running; only the system side died.
                  if (!meVoice) listening = false;
                  overlaySend('tanay:status', listening ? 'listening' : 'error');
                  watchScreenPermission();
                  windows.refreshTray(trayState());
                }
              });
            }
            systemReady = systemAudio.start();
          }
        }
      }
    }

    // ---------------------------------------------------------- my voice (me)
    if (captureMic) {
      let allowed = true;
      if (process.platform === 'darwin') {
        // Check the OS grant first. Asking here (rather than letting
        // getUserMedia surprise us) means a denied prompt produces a real
        // instruction instead of a bare "Microphone unavailable".
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status !== 'granted') {
          allowed = await systemPreferences.askForMediaAccess('microphone');
        }
      }
      if (!allowed) {
        overlaySend(
          'tanay:error',
          IS_MAC
            ? 'Microphone is off for CloudyAI, so your own voice will not be transcribed.\n' +
                `System Settings → Privacy & Security → Microphone → enable CloudyAI, then press ${hotkeyLabel('toggleListening')}.\n` +
                'The other participant is still being recorded.'
            : 'Microphone access was refused, so your own voice will not be transcribed.\n' +
                'Settings → Privacy → Microphone → let desktop apps use the microphone, then restart CloudyAI.\n' +
                'The other participant is still being recorded.'
        );
        watchMicrophonePermission();
      } else {
        meVoice = ensureVoice('me', cfg.cloudyvoice);
        if (meVoice.start()) {
          windows.sendToCapture('start');
          micReady = true;
        }
      }
    }

    listening = systemReady || micReady;
    overlaySend('tanay:status', listening ? 'listening' : 'error');

    if (!listening) {
      overlaySend(
        'tanay:error',
        IS_MAC
          ? 'No audio source started.\nEnable System & Screen Audio Recording and the Microphone for CloudyAI in System Settings → Privacy & Security.'
          : 'No audio source started.\nCheck that the microphone is plugged in and allowed, and that the speech model is installed (Settings → Transcription).'
      );
      return;
    }

    if (systemReady && micReady) {
      overlaySend('tanay:status', 'listening');
    }
  } finally {
    starting = false;
  }
}

/**
 * Build or re-configure one recogniser. Both sources share the Parakeet model;
 * each keeps its own VAD, speech buffer and utterance counter.
 */
function ensureVoice(speaker, baseCfg) {
  const existing = speaker === 'them' ? themVoice : meVoice;
  const cfg = {
    ...baseCfg,
    speaker,
    utteranceBase: speaker === 'me' ? 1000000 : 0,
    ear: baseCfg.engine === 'parakeet' ? sharedEar : null,
  };

  if (existing) {
    existing.cfg = cfg;
    existing.speaker = speaker;
    return existing;
  }

  const v = new CloudyVoice(cfg);
  v.on('partial', (text) => {
    lastActiveVoice = v;
    overlaySend('tanay:caption', { text, speaker });
  });
  v.on('final', (text, meta = {}) => {
    lastActiveVoice = v;
    onFinalTranscript(text, { ...meta, speaker });
  });
  v.on('error', (message) => {
    overlaySend('tanay:error', `${speaker === 'me' ? 'Microphone' : 'System audio'}: ${message}`);
    overlaySend('tanay:status', 'error');
  });
  if (speaker === 'them') themVoice = v;
  else meVoice = v;
  return v;
}

/** Tear down both recognisers (engine change, or app quit). */
function shutdownVoices() {
  for (const v of allVoices()) v.shutdown();
  themVoice = null;
  meVoice = null;
  lastActiveVoice = null;
  sharedEar?.shutdown();
  sharedEar = null;
}

// After a denial, keep watching: the user usually flips the switch in System
// Settings a few seconds later, and the app should resume on its own.
let permissionTimer = null;
function watchMicrophonePermission() {
  if (permissionTimer || process.platform !== 'darwin') return;
  let tries = 0;
  permissionTimer = setInterval(() => {
    tries += 1;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') {
      clearInterval(permissionTimer);
      permissionTimer = null;
      startListening();
    } else if (tries >= 60) {
      clearInterval(permissionTimer);
      permissionTimer = null;
    }
  }, 2000);
}

let screenPermissionTimer = null;
function watchScreenPermission() {
  if (screenPermissionTimer || process.platform !== 'darwin') return;
  let tries = 0;
  screenPermissionTimer = setInterval(() => {
    tries += 1;
    if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
      clearInterval(screenPermissionTimer);
      screenPermissionTimer = null;
      startListening();
    } else if (tries >= 90) {
      clearInterval(screenPermissionTimer);
      screenPermissionTimer = null;
    }
  }, 2000);
}

function stopListening() {
  systemAudio?.stop();
  systemAudio = null;
  if (LOOPBACK_IN_RENDERER) windows.sendToSystem('stop');
  if (!listening) return;
  for (const v of allVoices()) v.stop();
  windows.sendToCapture('stop');
  listening = false;
  overlaySend('tanay:status', 'idle');
}

function toggleListening() {
  listening ? stopListening() : startListening();
  windows.refreshTray(trayState());
}

function trayState() {
  const cfg = config.load();
  return {
    isListening: listening,
    provider: cfg.provider,
    hotkeyAnswer: windows.toSymbols(cfg.hotkeys?.answer) || (IS_MAC ? '⌘J' : 'Ctrl+J'),
    onToggle: () => windows.toggleOverlay(),
    onListen: toggleListening,
    onAnswer: answerNow,
    onEditShortcuts: () => windows.createSettings(),
    onSettings: () => windows.createSettings(),
    onProvider: (p) => {
      config.save({ provider: p });
      pushMeta();
      windows.refreshTray(trayState());
    },
    onQuit: () => {
      stopListening();
      app.quit();
    },
  };
}

// ----------------------------------------------------------------------- wiring
app.setActivationPolicy?.('accessory'); // tray-only: no Dock icon, no app switcher entry

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = windows.getOverlay();
    if (win) {
      win.showInactive();
      windows.pinOnTop(win);
    }
  });

  app.whenReady().then(async () => {
    await loadContextDocs({ quiet: true });

    engine = new AnswerEngine({
      onDelta: (d) => overlaySend('tanay:answer-delta', d),
      onDone: () => overlaySend('tanay:answer-end'),
      onError: (msg) => {
        overlaySend('tanay:error', msg);
        overlaySend('tanay:status', 'error');
      },
    });

    app.dock?.hide();

    if (LOOPBACK_IN_RENDERER) {
      // getDisplayMedia is called by a hidden window, so there is nobody to show
      // a picker to. Grant the primary screen plus its own audio (loopback):
      // Chromium supplies the WASAPI loopback internally on Windows.
      session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'] });
          const primary = sources[0];
          if (!primary) return callback({});
          callback({ video: primary, audio: 'loopback' });
        } catch (err) {
          console.log('[system-audio] loopback source failed:', err.message);
          callback({});
        }
      });
    }

    windows.createOverlay();
    windows.createCapture();
    if (LOOPBACK_IN_RENDERER) windows.createSystemCapture();
    windows.buildTray(trayState());
    registerIpcHandlers();
    engine.warm();

    // `electron . --settings-test` checks the settings window reflects stored
    // credentials and models without exposing the key itself.
    if (process.argv.includes('--settings-test')) {
      (async () => {
        const win = windows.createSettings();
        win.webContents.on('console-message', (_e, level, message) => {
          console.log(`[settings-console ${level}]`, message);
        });
        win.webContents.on('preload-error', (_e, path, error) => {
          console.log('[settings-preload-error]', path, error.message);
        });
        if (win.webContents.isLoading()) {
          await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 600));
        const probe = await win.webContents.executeJavaScript(
          `(async () => {
             const out = { bridge: typeof window.tanaySettings, rows: document.querySelectorAll('.row').length };
             try { const r = await window.tanaySettings.get(); out.ok = true; out.keys = r ? Object.keys(r) : null; }
             catch (e) { out.ok = false; out.err = String(e && e.message ? e.message : e); }
             return out;
           })()`
        );
        console.log('[settings-probe]', JSON.stringify(probe));

        const state = await win.webContents.executeJavaScript(`({
          provider: document.getElementById('provider').value,
          model: document.getElementById('model').value,
          modelOptions: document.getElementById('model').options.length,
          reasoningTagged: Array.from(document.getElementById('model').options).filter(o => /reasoning/.test(o.textContent)).length,
          keyPlaceholder: document.getElementById('apiKey').placeholder,
          keyType: document.getElementById('apiKey').type,
          keyHint: document.getElementById('keyHint').textContent,
          sttOptions: document.getElementById('sttModel').options.length,
          shortcuts: document.querySelectorAll('.shortcut-row').length
        })`);
        console.log('[settings-test]', JSON.stringify(state));
        app.quit();
      })();
    }

    // `electron . --thinking-test` checks the yellow blinker is on screen while
    // the model has produced nothing, and gone once tokens arrive.
    if (process.argv.includes('--thinking-test')) {
      (async () => {
        const overlay = windows.getOverlay();
        if (overlay.webContents.isLoading()) {
          await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 200));

        overlay.webContents.send('tanay:answer-start');
        await new Promise((r) => setTimeout(r, 250));
        const during = await overlay.webContents.executeJavaScript(`(() => {
          const dot = document.querySelector('.blink-dot');
          if (!dot) return { blinkDot: false };
          const style = getComputedStyle(dot);
          return { blinkDot: true, color: style.backgroundColor, animation: style.animationName, iteration: style.animationIterationCount };
        })()`);

        overlay.webContents.send('tanay:answer-delta', '**Q: test**\n\nanswer text');
        await new Promise((r) => setTimeout(r, 200));
        const after = await overlay.webContents.executeJavaScript(`({ blinkDot: Boolean(document.querySelector('.blink-dot')) })`);

        console.log('[thinking-test]', JSON.stringify({ during, after }));
        app.quit();
      })();
    }

    // `electron . --transcript-test` checks the panel renders the whole
    // transcript (scrollable, not clipped) instead of a single trimmed line.
    if (process.argv.includes('--transcript-test')) {
      (async () => {
        const overlay = windows.getOverlay();
        if (overlay.webContents.isLoading()) {
          await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 200));

        const long =
          'Can you walk me through how you would design a rate limiter for a public API that receives ten thousand requests per second, and what tradeoffs would you consider between a token bucket and a sliding window, and how would you handle bursts from a single tenant?';
        overlay.webContents.send('tanay:transcript', 'Okay so let me ask you something about distributed systems.');
        overlay.webContents.send('tanay:transcript', long);
        // Push enough text that the region must scroll rather than clip.
        for (let i = 0; i < 4; i++) overlay.webContents.send('tanay:transcript', `${long} (${i + 1})`);
        overlay.webContents.send('tanay:caption', 'And how would you monitor it in production');
        await new Promise((r) => setTimeout(r, 400));

        const state = await overlay.webContents.executeJavaScript(
          `(() => {
             const t = document.getElementById('transcript');
             const live = document.getElementById('caption');
             return {
               paragraphs: t.querySelectorAll('p').length,
               chars: t.textContent.length,
               scrollHeight: t.scrollHeight,
               clientHeight: t.clientHeight,
               overflowing: t.scrollHeight > t.clientHeight,
               scrolledToBottom: Math.abs(t.scrollHeight - t.clientHeight - t.scrollTop) < 4,
               live: live.textContent,
               panelHeight: document.body.clientHeight
             };
           })()`
        );
        console.log('[transcript-test]', JSON.stringify(state));
        app.quit();
      })();
    }

    // `electron . --pick-test` proves the hotkey grabs the whole question even
    // when the VAD split it, instead of only the newest fragment.
    if (process.argv.includes('--pick-test')) {
      const now = Date.now();
      turns.push(
        { text: 'Okay so let me ask you something.', at: now - 12000 },
        { text: 'Can you walk me through how you would design a rate limiter', at: now - 6000 },
        { text: 'for a public API with ten thousand requests per second,', at: now - 4000 },
        { text: 'and what tradeoffs would you consider between token bucket and sliding window?', at: now - 2000 }
      );
      const picked = currentPick();
      console.log('[pick-test]', JSON.stringify(picked));
      console.log('[pick-test] words:', (picked?.text || '').split(/\s+/).filter(Boolean).length);
      app.quit();
    }

    // `electron . --listen-test` runs the whole new path: system audio ->
    // VAD -> Parakeet -> transcript, with a generated question played into the
    // system output. No microphone involved.
    if (process.argv.includes('--listen-test')) {
      (async () => {
        config.load().cloudyvoice.captureSystem = true;
        config.load().cloudyvoice.captureMic = false;
        await startListening();
        if (!themVoice) {
          console.log('[listen-test] no recogniser');
          app.quit();
          return;
        }

        const clip = path.join(app.getPath('temp'), 'cloudy-listen-test.aiff');
        themVoice.on('final', (text, meta = {}) => {
          console.log(
            '[listen-test] final',
            JSON.stringify({
              text,
              decodeMs: meta.decodeMs,
              sinceSpeechEndMs: meta.speechEndAt ? Date.now() - meta.speechEndAt : null,
            })
          );
        });
        const make = spawn('say', [
          '-o',
          clip,
          'Can you explain how database indexes work and when would you use a composite index over a single column index?',
        ]);
        make.on('close', () => {
          setTimeout(() => spawn('afplay', [clip]), 2200);
        });

        setTimeout(() => {
          console.log(
            '[listen-test]',
            JSON.stringify({ listening, turns: turns.map((t) => t.text) })
          );
          stopListening();
          app.quit();
        }, 15000);
      })();
    }

    // `electron . --sysaudio-test` captures system audio for five seconds while
    // a built-in macOS sound plays, and reports frames + RMS. Proves the
    // helper, the frame protocol and the permission in one run.
    if (process.argv.includes('--sysaudio-test')) {
      (async () => {
        const bin = resolveAudioBin();
        if (!bin) {
          console.log('[sysaudio-test] helper not built');
          app.quit();
          return;
        }
        const capture = new CloudyAudio({ bin });
        let frames = 0;
        let samples = 0;
        let sumSq = 0;
        let peak = 0;
        capture.on('audio', (pcm) => {
          frames += 1;
          samples += pcm.length;
          for (let i = 0; i < pcm.length; i++) {
            const v = pcm[i];
            sumSq += v * v;
            if (Math.abs(v) > peak) peak = Math.abs(v);
          }
        });
        capture.on('error', (message) => console.log('[sysaudio-test] error', message));
        capture.start();

        // Generate a known clip and play it after the stream has warmed up, so
        // the test cannot pass or fail on SCK startup timing.
        const clip = path.join(app.getPath('temp'), 'cloudy-sysaudio-test.aiff');
        const make = spawn('say', [
          '-o',
          clip,
          'Can you explain how database indexes work and when would you use a composite index over a single column index?',
        ]);
        make.on('close', () => {
          setTimeout(() => {
            spawn('afplay', [clip]);
          }, 2200);
        });

        setTimeout(() => {
          capture.stop();
          const rms = samples ? Math.sqrt(sumSq / samples) : 0;
          console.log(
            '[sysaudio-test]',
            JSON.stringify({ frames, samples, seconds: +(samples / 16000).toFixed(2), peak, rms: Math.round(rms) })
          );
          app.quit();
        }, 10000);
      })();
    }

    // `electron . --capture-test` drives the REAL capture path (IPC command ->
    // capture.js -> worklet) and reports where it fails. Unlike --mic-test this
    // does not bypass our own code. It is the microphone path, so force it.
    if (process.argv.includes('--capture-test')) {
      config.load().cloudyvoice.captureSystem = false;
      config.load().cloudyvoice.captureMic = true;
      const cap = windows.getCapture();
      if (cap.webContents.isLoading()) {
        await new Promise((resolve) => cap.webContents.once('did-finish-load', resolve));
      }
      const lines = [];
      cap.webContents.on('console-message', (_e, level, message) => {
        lines.push(`capture console[${level}] ${message}`);
        console.log('[capture-test]', message);
      });

      let chunks = 0;
      const origHandler = ipcMain.listeners('tanay:audio')[0];
      if (origHandler) ipcMain.removeListener('tanay:audio', origHandler);
      ipcMain.on('tanay:audio', (event, buffer) => {
        chunks += 1;
        if (event.sender !== cap.webContents) return;
        if (listening && meVoice) meVoice.push(new Int16Array(buffer));
      });

      await startListening();
      await new Promise((r) => setTimeout(r, 4000));

      const probe = await cap.webContents.executeJavaScript(
        `({
           bridge: typeof window.tanay,
           onCommand: window.tanay ? typeof window.tanay.onCommand : 'missing',
           state: document.getElementById('state') ? document.getElementById('state').textContent : null,
           log: window.__capLog || null
         })`
      );
      console.log('[capture-test] probe', JSON.stringify(probe, null, 1));
      console.log('[capture-test]', JSON.stringify({ listening, audioChunks: chunks }));
      app.quit();
    }

    // `electron . --mic-error-test` pushes the exact failure the user saw and
    // checks the overlay offers a remedy instead of just an error string.
    if (process.argv.includes('--mic-error-test')) {
      (async () => {
        const overlay = windows.getOverlay();
        if (overlay.webContents.isLoading()) {
          await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 200)); // let the preload bridge attach
        overlay.webContents.send('tanay:error', 'Microphone unavailable: The user aborted a request.');
        await new Promise((r) => setTimeout(r, 400));
        const state = await overlay.webContents.executeJavaScript(
          `({ hidden: document.getElementById('actions').hidden, label: document.getElementById('micSettings').textContent })`
        );
        console.log('[mic-error]', JSON.stringify(state));
        app.quit();
      })();
    }

    // `electron . --shot-test` captures the real screen (the overlay must be
    // absent from it), saves the PNG, and has the configured model answer
    // from that image alone.
    if (process.argv.includes('--shot-test')) {
      (async () => {
        const overlay = windows.getOverlay();
        if (overlay.webContents.isLoading()) {
          await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 600));

        const dataUrl = await captureScreen();
        const png = process.env.CLOUDY_SHOT_DUMP || path.join(app.getPath('temp'), 'cloudy-shot.png');
        fs.writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
        console.log('[shot-test] image', png, `${Math.round(dataUrl.length / 1024)} KB`);

        const cfg = config.load();
        const probe = new AnswerEngine({
          onDelta: () => {},
          onDone: (text) => {
            console.log('[shot-test] answer', JSON.stringify(text.slice(0, 400)));
            app.quit();
          },
          onError: (message) => {
            console.log('[shot-test] error', message);
            app.quit();
          },
        });
        probe.ask({
          system: prompts.systemPrompt(cfg.profile, { screenshot: true }),
          user: prompts.buildUserPrompt({
            transcript:
              'Answer based on what is on this screen. If there is a question or task, answer it; if not, say what is on the screen and what I can do next.',
            profile: cfg.profile,
            screenshot: true,
          }),
          images: [dataUrl],
        });
      })();
    }

    // `electron . --composer-test` checks the composer: Enter sends typed text,
    // the camera adds a preview instead of sending, two captures collect into a
    // batch, and Send ships every image with the prompt.
    if (process.argv.includes('--composer-test')) {
      (async () => {
        const overlay = windows.getOverlay();
        if (overlay.webContents.isLoading()) {
          await new Promise((resolve) => overlay.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 200)); // let the preload bridge attach

        const dom = await overlay.webContents.executeJavaScript(`({
          prompt: Boolean(document.getElementById('prompt')),
          send: Boolean(document.getElementById('send')),
          shot: Boolean(document.getElementById('shot')),
          shots: Boolean(document.getElementById('shots')),
          bridge: typeof window.tanay.askText === 'function' && typeof window.tanay.capture === 'function',
          placeholder: document.getElementById('prompt') ? document.getElementById('prompt').placeholder : ''
        })`);
        console.log('[composer-test] dom', JSON.stringify(dom));

        // Swap the answer call for a recorder: the wiring is what matters here,
        // not the provider. CLOUDY_LIVE_SHOT=1 restores the real call.
        const live = process.env.CLOUDY_LIVE_SHOT === '1';
        const realAsk = engine.ask;
        let captured = null;
        engine.ask = (args) => { captured = args; };

        const typed = 'Explain database indexes in one line.';
        await overlay.webContents.executeJavaScript(`(() => {
          const p = document.getElementById('prompt');
          p.value = ${JSON.stringify(typed)};
          p.dispatchEvent(new Event('input'));
          p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()`);
        await new Promise((r) => setTimeout(r, 250));
        const typedState = await overlay.webContents.executeJavaScript(`({
          cleared: document.getElementById('prompt').value === '',
          enabled: !document.getElementById('send').disabled
        })`);
        console.log(
          '[composer-test] typed',
          JSON.stringify({
            sent: Boolean(captured && captured.user.includes(typed)),
            ...typedState,
          })
        );

        // Capture twice: the camera must only queue previews, never send.
        captured = null;
        if (live) engine.ask = realAsk;
        await overlay.webContents.executeJavaScript(`document.getElementById('shot').click()`);
        await new Promise((r) => setTimeout(r, 1200));
        await overlay.webContents.executeJavaScript(`document.getElementById('shot').click()`);
        await new Promise((r) => setTimeout(r, 1200));

        const pending = await overlay.webContents.executeJavaScript(`({
          previews: document.querySelectorAll('#shots .shot').length,
          stripHidden: document.getElementById('shots').hidden,
          status: document.getElementById('status').textContent,
          answer: document.getElementById('answer').textContent.slice(0, 120),
          sendEnabled: !document.getElementById('send').disabled
        })`);
        console.log(
          '[composer-test] queued',
          JSON.stringify({
            live,
            screenAccess: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'n/a',
            sentBeforeSend: Boolean(captured && captured.images && captured.images.length),
            ...pending,
          })
        );

        // Press Send with an empty box: the default screenshot prompt goes out.
        if (live) engine.ask = realAsk;
        await overlay.webContents.executeJavaScript(`document.getElementById('send').click()`);
        await new Promise((r) => setTimeout(r, 400));

        if (live) {
          const deadline = Date.now() + 25000;
          while (Date.now() < deadline) {
            const status = await overlay.webContents.executeJavaScript(
              `document.getElementById('status').textContent`
            );
            if (/listening|idle|error/.test(status)) break;
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        const sentState = await overlay.webContents.executeJavaScript(`({
          previews: document.querySelectorAll('#shots .shot').length,
          stripHidden: document.getElementById('shots').hidden,
          status: document.getElementById('status').textContent
        })`);
        console.log(
          '[composer-test] sent',
          JSON.stringify({
            live,
            images: captured && captured.images ? captured.images.length : 0,
            png: Boolean(captured && captured.images && captured.images[0].startsWith('data:image/png')),
            defaultPrompt: Boolean(
              captured && captured.user.includes('Answer based on what is on this screen.')
            ),
            screenshotTag: Boolean(captured && captured.user.includes('<screenshot>')),
            ...sentState,
          })
        );

        app.quit();
      })();
    }

    // `electron . --settings-test` checks the session-context controls exist and
    // the document bridge is wired, without opening a file dialog.
    if (process.argv.includes('--settings-test')) {
      (async () => {
        const win = windows.createSettings();
        if (win.webContents.isLoading()) {
          await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
        }
        await new Promise((r) => setTimeout(r, 300));

        const dom = await win.webContents.executeJavaScript(`({
          sessionPrompt: Boolean(document.getElementById('sessionPrompt')),
          jdText: Boolean(document.getElementById('jdText')),
          resumePick: Boolean(document.getElementById('resumePick')),
          jdPick: Boolean(document.getElementById('jdPick')),
          bridge: typeof window.tanaySettings.pickDocument === 'function'
            && typeof window.tanaySettings.clearDocument === 'function',
          promptValue: document.getElementById('sessionPrompt') ? document.getElementById('sessionPrompt').value : '',
          jdHidden: document.getElementById('jdText') ? document.getElementById('jdText').hidden : null
        })`);
        console.log('[settings-test] dom', JSON.stringify(dom));

        const cfg = config.load();
        console.log(
          '[settings-test] context',
          JSON.stringify({
            sessionPromptChars: (cfg.sessionPrompt || '').length,
            resume: cfg.resumePath ? path.basename(cfg.resumePath) : '',
            jobDescriptionFile: cfg.jobDescriptionPath ? path.basename(cfg.jobDescriptionPath) : '',
            jobDescriptionPastedChars: (cfg.jobDescription || '').length,
            resumeTextChars: resumeText.length,
            jobDescriptionTextChars: jobDescriptionText.length,
          })
        );

        app.quit();
      })();
    }

    // `electron . --mic-test` reports the real permission state and the exact
    // getUserMedia error, instead of guessing from the overlay message.
    if (process.argv.includes('--mic-test')) {
      (async () => {
        const before = systemPreferences.getMediaAccessStatus('microphone');
        console.log('[mic] status before:', before);
        if (before !== 'granted') {
          const asked = await systemPreferences.askForMediaAccess('microphone');
          console.log('[mic] askForMediaAccess ->', asked);
        }
        console.log('[mic] status after:', systemPreferences.getMediaAccessStatus('microphone'));

        const win = windows.getCapture();
        try {
          const result = await win.webContents.executeJavaScript(
            `(async () => {
               try {
                 const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
                 const track = stream.getAudioTracks()[0];
                 const info = track ? { label: track.label, state: track.readyState } : null;
                 stream.getTracks().forEach(t => t.stop());
                 return { ok: true, track: info };
               } catch (err) { return { ok: false, name: err.name, message: err.message }; }
             })()`
          );
          console.log('[mic] getUserMedia:', JSON.stringify(result));
        } catch (err) {
          console.log('[mic] executeJavaScript failed:', err.message);
        }
        app.quit();
      })();
    }

    // `electron . --answer-now` exercises the ⌘J path: pick the last question
    // out of the transcript and answer it, with no capture running.
    if (process.argv.includes('--answer-now')) {
      const t0 = Date.now();
      let firstAt = 0;
      const now = Date.now();
      turns.push(
        { text: 'Okay so tell me about your last project.', at: now - 4000, utteranceId: 1 },
        { text: 'Can you explain how indexing works in Postgres?', at: now - 1000, utteranceId: 2 }
      );
      engine.onDelta = () => {
        if (!firstAt) firstAt = Date.now() - t0;
      };
      engine.onDone = (text) => {
        console.log(
          '[answer-now]',
          JSON.stringify({
            picked: currentPick(),
            firstTokenMs: firstAt,
            totalMs: Date.now() - t0,
            chars: text.length,
          })
        );
        console.log(text.slice(0, 140));
        app.quit();
      };
      engine.onError = (message) => {
        console.log('[answer-now] error:', message);
        app.quit();
      };
      answerNow();
    }

    // `electron . --ask` runs one real answer through the configured provider
    // and prints latency. It is the only honest way to measure the whole path.
    if (process.argv.includes('--ask')) {
      const t0 = Date.now();
      let firstAt = 0;
      const probe = new AnswerEngine({
        onDelta: () => {
          if (!firstAt) firstAt = Date.now() - t0;
        },
        onDone: (text) => {
          console.log(
            '[ask]',
            JSON.stringify({
              provider: config.load().provider,
              model: config.load().opencodeGo?.model,
              firstTokenMs: firstAt,
              totalMs: Date.now() - t0,
              chars: text.length,
            })
          );
          console.log(text.slice(0, 160));
          app.quit();
        },
        onError: (message) => {
          console.log('[ask] error:', message);
          app.quit();
        },
      });
      probe.ask({
        system: prompts.systemPrompt('interview'),
        user: prompts.buildUserPrompt({ transcript: 'What is a hash map and why is lookup O(1)?', profile: 'interview' }),
      });
    }

    // `electron . --smoke` boots headlessly-ish, reports window state, and exits.
    // Keeps CI/verification honest without a human looking at the screen.
    if (process.argv.includes('--smoke') && !process.argv.includes('--ask')) {
      const log = [];
      for (const [name, win] of [
        ['overlay', windows.getOverlay()],
        ['capture', windows.getCapture()],
      ]) {
        win.webContents.on('did-fail-load', (_e, code, desc) => log.push(`${name} load failed ${code} ${desc}`));
        win.webContents.on('console-message', (_e, level, message) => {
          if (level >= 2) log.push(`${name} console[${level}] ${message}`); // warnings and errors only
        });
        win.webContents.on('render-process-gone', (_e, d) => log.push(`${name} renderer gone: ${d.reason}`));
      }

      // Also load the settings window so its renderer/IPC bridge is exercised.
      const settingsWin = windows.createSettings();
      settingsWin.webContents.on('console-message', (_e, level, message) => log.push(`settings console[${level}] ${message}`));
      settingsWin.webContents.on('did-fail-load', (_e, code, desc) => log.push(`settings load failed ${code} ${desc}`));
      setTimeout(() => {
        const o = windows.getOverlay();
        const c = windows.getCapture();
        const report = {
          overlay: !!o,
          overlayVisible: o?.isVisible() ?? null,
          overlayLoading: o?.webContents.isLoading() ?? null,
          contentProtected: o?.isContentProtected?.() ?? null,
          capture: !!c,
          captureLoading: c?.webContents.isLoading() ?? null,
          settings: !!windows.getSettings(),
          settingsLoading: windows.getSettings()?.webContents.isLoading() ?? null,
          listening,
          shortcuts: lastHotkeyResult.registered.map((r) => `${r.action}=${r.accelerator}`),
          shortcutFailures: lastHotkeyResult.failures,
          problems: log,
        };
        console.log('[smoke]', JSON.stringify(report, null, 2));
        app.quit();
      }, 4500);
    }

    const cfg = config.load();
    applyHotkeys();
    applyCornerTrigger();
    applyMouseTrigger();
    watchConfig();

    if (cfg.autoStart !== false && !process.env.CLOUDY_NO_AUTOSTART) startListening();


    pushMeta();
  });
}

app.on('window-all-closed', () => {
  // Subscribing at all stops Electron's default quit; a tray app keeps running.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  mouseWatcher?.stop();
  windows.stopCornerTrigger();
  stopListening();
  shutdownVoices();
});

app.on('before-quit', () => stopListening());
