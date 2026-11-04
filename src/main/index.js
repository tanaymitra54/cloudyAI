'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain, globalShortcut, systemPreferences, shell, desktopCapturer, screen } = require('electron');

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
const { CloudyAudio } = require('./audio/CloudyAudio');
const { AnswerEngine } = require('./llm');
const { pickQuestion, shouldSkipAnswer } = require('./pick');

// ------------------------------------------------------------- resolve binaries
function resolveBin(bin, knownDirs = ['/opt/homebrew/bin', '/usr/local/bin']) {
  if (path.isAbsolute(bin)) return bin;
  for (const dir of knownDirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return bin;
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

// ------------------------------------------------------------ question detection
const { scoreQuestion, similarity, wordCount } = require('./detection');

// ------------------------------------------------------------------- app state
let voice = null;
let systemAudio = null;
let engine = null;
let listening = false;
let turns = [];
let askTimer = null;
let resumeText = '';
let lastAnswered = { text: '', at: 0, utteranceId: null };
let speculated = false; // at most one speculative answer per utterance
let starting = false; // guards against overlapping getUserMedia requests

function overlaySend(channel, payload) {
  const win = windows.getOverlay();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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

function metaLine() {
  const cfg = config.load();
  const section = cfg[SECTIONS[cfg.provider] || cfg.provider] || {};
  const model = section.model || cfg.provider;
  const mode = cfg.autoAnswer ? 'auto-answer' : '⌘J to answer';
  return `${cfg.provider} · ${model} · ${mode} · ${turns.length} turns`;
}

function pushMeta() {
  overlaySend('tanay:meta', metaLine());
}

/** Shared by the ⌘⇧R hotkey and the tray; resets answers and transcript state. */
function clearSession() {
  turns = [];
  lastAnswered = { text: '', at: 0, utteranceId: null };
  speculated = false;
  clearTimeout(askTimer);
  engine?.cancel();
  // Drop the in-flight utterance too, not just the visible text.
  voice?.clear();
  overlaySend('tanay:caption', '');
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

function loadResume() {
  const cfg = config.load();
  if (!cfg.resumePath) {
    resumeText = '';
    return;
  }
  try {
    resumeText = fs.readFileSync(cfg.resumePath, 'utf8');
  } catch (err) {
    resumeText = '';
    overlaySend('tanay:error', `Could not read resume: ${err.message}`);
  }
}

// ---------------------------------------------------------------- answer flow
function ask(triggerText, { speculative = false, images = null, utteranceId = null } = {}) {
  const cfg = config.load();
  const transcript = triggerText || turns.slice(-1).map((t) => t.text).join('\n');
  if (!transcript.trim()) return;

  lastAnswered = { text: transcript, at: Date.now(), utteranceId };
  overlaySend('tanay:answer-start');
  engine.ask({
    system: prompts.systemPrompt(cfg.profile, { screenshot: Boolean(images?.length) }),
    user: prompts.buildUserPrompt({
      transcript,
      context: turns.slice(-1 - cfg.contextTurns, -1).map((t) => t.text),
      resume: resumeText,
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
function askTyped(text, { images = null } = {}) {
  const typed = String(text || '').trim();
  if (!typed) return;

  const cfg = config.load();
  lastAnswered = { text: typed, at: Date.now(), utteranceId: null };
  overlaySend('tanay:answer-start');
  engine.ask({
    system: prompts.systemPrompt(cfg.profile, { screenshot: Boolean(images?.length) }),
    user: prompts.buildUserPrompt({
      transcript: typed,
      context: [],
      resume: resumeText,
      profile: cfg.profile,
      screenshot: Boolean(images?.length),
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
      'Could not read the screen.\nGrant Screen Recording to CloudyAI in System Settings → Privacy & Security.'
    );
  }
  return source.thumbnail.toDataURL();
}

async function answerFromScreenshot(promptText) {
  overlaySend('tanay:status', 'capturing');
  try {
    const dataUrl = await captureScreen();

    // Debug aid: CLOUDY_SHOT_DUMP=/tmp/shot.png keeps the exact image sent.
    if (process.env.CLOUDY_SHOT_DUMP) {
      try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(process.env.CLOUDY_SHOT_DUMP, Buffer.from(base64, 'base64'));
        console.log('[shot] saved', process.env.CLOUDY_SHOT_DUMP);
      } catch (err) {
        console.log('[shot] could not save image:', err.message);
      }
    }

    const typed = String(promptText || '').trim();
    askTyped(typed || 'Answer based on what is on this screen. If there is a question or task, answer it; if not, say what is on the screen and what I can do next.', {
      images: [dataUrl],
    });
    return true;
  } catch (err) {
    overlaySend('tanay:error', err.message);
    overlaySend('tanay:status', 'error');
    return false;
  }
}

function onFinalTranscript(text, meta = {}) {
  speculated = false; // the utterance is over; the next one may speculate again
  turns.push({
    text,
    at: meta.speechEndAt || Date.now(),
    utteranceId: meta.utteranceId ?? null,
  });
  if (turns.length > 60) turns = turns.slice(-60);

  overlaySend('tanay:caption', ''); // the live line is now committed below
  overlaySend('tanay:transcript', text);
  pushMeta();

  // Manual mode: keep transcribing, but wait for the hotkey before spending a
  // request. This is what stops it from reacting to your own voice.
  if (!config.load().autoAnswer) return;

  // If the speculative pass already answered this, do not burn a second call.
  if (lastAnswered.text) {
    const sim = similarity(text, lastAnswered.text);
    const grew = wordCount(text) > wordCount(lastAnswered.text) * 1.15;
    // Skipping is only safe when the final says nothing the speculative answer
    // did not already see. A question that kept growing deserves a fresh answer.
    if (sim > 0.5 && !grew) return;
  }

  const verdict = scoreQuestion(text);
  if (!verdict.isQuestion) return;

  // A strong question can be answered immediately; a weak one waits briefly in
  // case the speaker is still finishing the sentence.
  clearTimeout(askTimer);
  askTimer = setTimeout(() => ask(text), verdict.strong ? 0 : 250);
}

// Answer from the live caption, before the utterance even closes. This hides
// the VAD silence window plus the final whisper decode (~1 s in practice).
function onPartialTranscript(text) {
  if (!config.load().autoAnswer) return;
  if (speculated) return;
  const verdict = scoreQuestion(text);
  if (!verdict.speculativeSafe) return;
  if (lastAnswered.text && similarity(text, lastAnswered.text) > 0.5) return;
  speculated = true;
  ask(text, { speculative: true });
}

/**
 * The newest question ⌘J should answer, including text that is still in
 * flight. `pick.js` never walks back past the newest utterance to find a
 * better-scoring older one.
 */
function currentPick() {
  const picked = pickQuestion({
    turns,
    partial: (voice?.partialText || '').trim(),
    pendingText: (voice?.pendingText || '').trim(),
    speaking: Boolean(voice?.speaking),
    now: Date.now(),
    maxAgeMs: 20000,
  });
  // In-flight text has no id in the picker; attach the live utterance so the
  // duplicate-answer guard can see it. While speaking, the live utterance is
  // the next id, not the one that just closed.
  const liveId = voice?.speaking ? (voice.utteranceId || 0) + 1 : voice?.utteranceId;
  if (picked && picked.source !== 'turn' && liveId) {
    picked.utteranceId = liveId;
  }
  return picked;
}

/** Wait for the decode that is already running, but never longer than timeoutMs. */
function waitForFinal(timeoutMs) {
  return new Promise((resolve) => {
    if (!voice) return resolve();
    let settled = false;
    const onFinal = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      voice.removeListener('final', onFinal);
      resolve();
    }
    voice.once('final', onFinal);
  });
}

/** Hotkey path: no debounce, no waiting for the utterance to close. */
async function answerNow() {
  clearTimeout(askTimer);

  let picked = currentPick();

  // The utterance just closed and its decode is in flight. Wait for it rather
  // than falling back to the previous question.
  if (!picked?.text && voice?.finalizing) {
    await waitForFinal(700);
    picked = currentPick();
  }

  const question = picked?.text || '';
  if (!question) {
    overlaySend('tanay:error', 'Nothing heard yet — start listening first (⌘⇧L).');
    overlaySend('tanay:status', listening ? 'listening' : 'idle');
    return;
  }

  // Only block when this exact utterance is already being answered. A new but
  // similar-sounding question must still go through.
  if (shouldSkipAnswer({ engineBusy: engine.busy, lastAnswered, picked })) {
    overlaySend('tanay:status', 'answering');
    overlaySend('tanay:error', 'Already answering this question.\nPress ⌘⇧↵ to force a new answer.');
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
    voice.push(new Int16Array(buffer));
  });

  // The renderer is where getUserMedia actually fails (denied permission,
  // no input device), so surface its error in the overlay instead of silently idling.
  ipcMain.on('tanay:capture-ready', (event) => {
    if (event.sender !== windows.getCapture()?.webContents) return;
    windows.markCaptureReady();
  });

  ipcMain.on('tanay:capture-error', (event, message) => {
    if (event.sender !== windows.getCapture()?.webContents) return;
    listening = false;
    voice?.stop();
    // Not every capture failure is a permission problem; do not claim it is.
    const permissionProblem = /notallowed|permission|denied/i.test(message);
    overlaySend(
      'tanay:error',
      permissionProblem ? `Microphone unavailable: ${message}` : `Audio capture failed: ${message}`
    );
    overlaySend('tanay:status', 'error');
    windows.refreshTray(trayState());
    // If it was a permission problem, wait for the switch to flip and resume.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      watchMicrophonePermission();
    }
  });

  ipcMain.on('tanay:open-mic-settings', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  });

  ipcMain.on('tanay:open-screen-settings', () => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });

  ipcMain.on('tanay:listen-toggle', () => {
    toggleListening();
    pushMeta();
  });

  ipcMain.on('tanay:clear', () => clearSession());

  // Typed questions and screenshot questions come from the overlay composer.
  ipcMain.on('tanay:ask-text', (_event, text) => askTyped(text));
  ipcMain.handle('tanay:shot', (_event, text) => answerFromScreenshot(text));

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
      autoAnswer: cfg.autoAnswer,
      provider: cfg.provider,
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
        parakeetAvailable: Boolean(resolveEarBin()),
        audioAvailable: Boolean(resolveAudioBin()),
        modelPath: config.resolveModelPath(),
        available: config.listModels(),
      },
      configPath: config.file(),
    };
  });

  ipcMain.handle('settings:reset-shortcuts', () => config.DEFAULTS.hotkeys);

  ipcMain.handle('settings:save', (_event, payload = {}) => {
    const patch = {};
    if (payload.hotkeys) patch.hotkeys = payload.hotkeys;
    if (typeof payload.autoAnswer === 'boolean') patch.autoAnswer = payload.autoAnswer;
    if (payload.provider) patch.provider = payload.provider;

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
      if (payload.transcription.source === 'system' || payload.transcription.source === 'mic') {
        patch.cloudyvoice.source = payload.transcription.source;
      }
    }

    config.save(patch);
    const result = applyHotkeys();

    // A model or engine change has to reach the running recogniser, not just the file.
    if (voice) {
      const engineChanged = patch.cloudyvoice?.engine && patch.cloudyvoice.engine !== voice.cfg.engine;
      if (engineChanged) {
        const wasListening = listening;
        if (wasListening) stopListening();
        voice.shutdown();
        voice = null;
        if (wasListening) startListening();
      } else {
        voice.cfg.modelPath = config.resolveModelPath();
        voice.cfg.partialModelPath = config.resolvePartialModelPath();
        voice.cfg.source = config.load().cloudyvoice.source;
        if (listening) {
          stopListening();
          startListening();
        }
      }
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
    const source = cfg.cloudyvoice.source || 'system';
    let audioBin = '';

    if (source === 'system') {
      // The helper owns the Screen & System Audio Recording preflight and the
      // OS prompt. Checking getMediaAccessStatus('screen') here was wrong: after
      // a reset it reports "denied" and the helper never got to ask, so the
      // permission dialog never appeared.
      audioBin = resolveAudioBin();
      if (!audioBin) {
        overlaySend(
          'tanay:error',
          'System audio helper is not built.\nRun: npm run build:audio, then restart CloudyAI.'
        );
        overlaySend('tanay:status', 'error');
        return;
      }
      cfg.cloudyvoice.audioBin = audioBin;
    } else if (process.platform === 'darwin') {
      // Check the OS grant first. Asking here (rather than letting getUserMedia
      // surprise us) means a denied prompt produces a real instruction instead
      // of a bare "Microphone unavailable".
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          overlaySend(
            'tanay:error',
            'Microphone is off for CloudyAI.\nSystem Settings → Privacy & Security → Microphone → enable CloudyAI, then press ⌘⇧L.'
          );
          overlaySend('tanay:status', 'error');
          listening = false;
          watchMicrophonePermission();
          return;
        }
      }
    }

    cfg.cloudyvoice.modelPath = config.resolveModelPath();
    cfg.cloudyvoice.partialModelPath = config.resolvePartialModelPath();
    cfg.cloudyvoice.bin = resolveBin(cfg.cloudyvoice.bin);

    if (cfg.cloudyvoice.engine === 'parakeet') {
      const earBin = resolveEarBin();
      if (earBin) cfg.cloudyvoice.parakeetBin = earBin;
      else {
        cfg.cloudyvoice.engine = 'whisper';
        overlaySend(
          'tanay:error',
          'Parakeet helper is not built — using whisper for now.\nRun: npm run build:ear, then restart CloudyAI.'
        );
      }
    }

    if (!voice) {
      voice = new CloudyVoice(cfg.cloudyvoice);
      voice.on('partial', (t) => {
        overlaySend('tanay:caption', t);
        onPartialTranscript(t);
      });
      voice.on('final', onFinalTranscript);
      voice.on('error', (msg) => {
        overlaySend('tanay:error', msg);
        overlaySend('tanay:status', 'error');
      });
      // The Parakeet model is loaded once at startup; the panel says so instead
      // of looking frozen during the first-run download.
      voice.on('loading', () => overlaySend('tanay:status', 'loading'));
      voice.on('ready', () => overlaySend('tanay:status', listening ? 'listening' : 'idle'));
    } else {
      voice.cfg = cfg.cloudyvoice;
    }

    if (!voice.start()) {
      listening = false;
      return;
    }

    if (source === 'system') {
      if (!systemAudio) {
        systemAudio = new CloudyAudio({ bin: audioBin });
        systemAudio.on('audio', (pcm) => {
          if (listening) voice.push(pcm);
        });
        systemAudio.on('error', (message, info = {}) => {
          overlaySend(
            'tanay:error',
            info.fatal
              ? 'Screen & System Audio Recording is off for CloudyAI.\nSystem Settings → Privacy & Security → Screen & System Audio Recording → enable CloudyAI, then press ⌘⇧L (or relaunch).'
              : message
          );
          overlaySend('tanay:status', 'error');
          if (info.fatal) {
            listening = false;
            voice?.stop();
            watchScreenPermission();
            windows.refreshTray(trayState());
          }
        });
      }
      if (!systemAudio.start()) {
        listening = false;
        return;
      }
    } else {
      windows.sendToCapture('start');
    }

    listening = true;
    overlaySend('tanay:status', 'listening');
  } finally {
    starting = false;
  }
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
  if (!listening) return;
  clearTimeout(askTimer);
  voice?.stop();
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
    autoAnswer: cfg.autoAnswer,
    hotkeyAnswer: windows.toSymbols ? windows.toSymbols(cfg.hotkeys?.answer) : '⌘J',
    onToggle: () => windows.toggleOverlay(),
    onListen: toggleListening,
    onAnswer: answerNow,
    onEditShortcuts: () => windows.createSettings(),
    onSettings: () => windows.createSettings(),
    onToggleAuto: () => {
      config.save({ autoAnswer: !config.load().autoAnswer });
      pushMeta();
      windows.refreshTray(trayState());
    },
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
    loadResume();

    engine = new AnswerEngine({
      onDelta: (d) => overlaySend('tanay:answer-delta', d),
      onDone: () => overlaySend('tanay:answer-end'),
      onError: (msg) => {
        overlaySend('tanay:error', msg);
        overlaySend('tanay:status', 'error');
      },
    });

    app.dock?.hide();

    windows.createOverlay();
    windows.createCapture();
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
        config.load().cloudyvoice.source = 'system';
        await startListening();
        if (!voice) {
          console.log('[listen-test] no recogniser');
          app.quit();
          return;
        }

        const clip = path.join(app.getPath('temp'), 'cloudy-listen-test.aiff');
        voice.on('final', (text, meta = {}) => {
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
      config.load().cloudyvoice.source = 'mic';
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
        if (listening && voice) voice.push(new Int16Array(buffer));
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

    // `electron . --composer-test` checks the typed-prompt box and the
    // screenshot button: the elements exist, Enter sends the text, and the
    // screenshot path hands an image to the engine.
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
          bridge: typeof window.tanay.askText === 'function' && typeof window.tanay.screenshot === 'function',
          placeholder: document.getElementById('prompt') ? document.getElementById('prompt').placeholder : ''
        })`);
        console.log('[composer-test] dom', JSON.stringify(dom));

        // Swap the answer call for a recorder: the typed part checks the wiring,
        // not the provider. CLOUDY_LIVE_SHOT=1 restores the real call for the
        // screenshot so the image path is proven end to end.
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

        captured = null;
        if (live) engine.ask = realAsk;
        await overlay.webContents.executeJavaScript(`document.getElementById('shot').click()`);
        await new Promise((r) => setTimeout(r, 1500));

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

        const shotState = await overlay.webContents.executeJavaScript(`({
          status: document.getElementById('status').textContent,
          answer: document.getElementById('answer').textContent.slice(0, 120)
        })`);
        console.log(
          '[composer-test] shot',
          JSON.stringify({
            live,
            screenAccess: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'n/a',
            attached: Boolean(captured && captured.images && captured.images.length),
            png: Boolean(captured && captured.images && captured.images[0].startsWith('data:image/png')),
            defaultPrompt: Boolean(
              captured && captured.user.includes('Answer based on what is on this screen.')
            ),
            screenshotTag: Boolean(captured && captured.user.includes('<screenshot>')),
            ...shotState,
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
  stopListening();
  voice?.shutdown();
  voice = null;
});

app.on('before-quit', () => stopListening());
