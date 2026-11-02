'use strict';

const fs = require('fs');
const path = require('path');
const { app, ipcMain, globalShortcut, systemPreferences, shell } = require('electron');

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
const { TanayVoice } = require('./stt/TanayVoice');
const { AnswerEngine } = require('./llm');

// ------------------------------------------------------------- resolve binaries
function resolveBin(bin, knownDirs = ['/opt/homebrew/bin', '/usr/local/bin']) {
  if (path.isAbsolute(bin)) return bin;
  for (const dir of knownDirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return bin;
}

// ------------------------------------------------------------ question detection
const { scoreQuestion, similarity, wordCount } = require('./detection');

// ------------------------------------------------------------------- app state
let voice = null;
let engine = null;
let listening = false;
let turns = [];
let askTimer = null;
let resumeText = '';
let lastAnswered = { text: '', at: 0 };
let speculated = false; // at most one speculative answer per utterance
let starting = false; // guards against overlapping getUserMedia requests

function overlaySend(channel, payload) {
  const win = windows.getOverlay();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// provider id -> config section (they differ in case for opencode-go)
const SECTIONS = { 'opencode-go': 'opencodeGo', deepseek: 'deepseek', opencode: 'opencode', commandcode: 'commandcode' };

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
  lastAnswered = { text: '', at: 0 };
  speculated = false;
  clearTimeout(askTimer);
  engine?.cancel();
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
function ask(triggerText, { speculative = false } = {}) {
  const cfg = config.load();
  const transcript = triggerText || turns.slice(-2).map((t) => t.text).join('\n');
  if (!transcript.trim()) return;

  lastAnswered = { text: transcript, at: Date.now() };
  overlaySend('tanay:answer-start');
  engine.ask({
    system: prompts.systemPrompt(cfg.profile),
    user: prompts.buildUserPrompt({
      transcript,
      context: turns.slice(-1 - cfg.contextTurns, -1).map((t) => t.text),
      resume: resumeText,
      profile: cfg.profile,
    }),
  });
}

function onFinalTranscript(text) {
  speculated = false; // the utterance is over; the next one may speculate again
  turns.push({ text, at: Date.now() });
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
 * The latest question, however long it is.
 *
 * Interviewers pause mid-question, and a pause longer than the VAD window can
 * split one question into two utterances. Taking only the newest fragment
 * answers half a question, so walk backwards and merge contiguous pieces until
 * the candidate starts answering.
 */
function pickLastQuestion() {
  const partial = (voice?.partialText || '').trim();
  const recent = turns.slice(-8);
  if (!recent.length) return partial;

  let index = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (scoreQuestion(recent[i].text).isQuestion) {
      index = i;
      break;
    }
  }
  if (index === -1) return partial || recent[recent.length - 1].text;

  let start = index;
  while (start > 0) {
    const prev = recent[start - 1];
    const gap = recent[start].at - prev.at;
    const prevScore = scoreQuestion(prev.text);
    const endsCleanly = /[.?!]\s*$/.test(prev.text.trim());
    // Merge only a fragment of the same question: it either carries question
    // signal itself, or it was cut off before any terminal punctuation. A
    // finished sentence with no question signal is the previous topic.
    const continuation = gap < 5000 && prev.text.length < 400 && (prevScore.score > 0 || !endsCleanly);
    if (!continuation) break;
    start -= 1;
  }

  const merged = recent
    .slice(start)
    .map((t) => t.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If the interviewer is still talking, their in-flight words belong in it too.
  if (partial && !merged.endsWith(partial)) {
    const tail = merged.toLowerCase().includes(partial.toLowerCase().slice(0, 24));
    if (!tail) return `${merged} ${partial}`.slice(0, 2000);
  }
  return merged.slice(0, 2000);
}

/** Hotkey path: no debounce, no waiting for the utterance to close. */
function answerNow() {
  clearTimeout(askTimer);
  const question = pickLastQuestion();
  if (!question) {
    overlaySend('tanay:error', 'Nothing heard yet — start listening first (⌘⇧L).');
    overlaySend('tanay:status', listening ? 'listening' : 'idle');
    return;
  }
  // Pressing the hotkey twice, or while the answer is already streaming, must
  // not restart the request and throw away tokens that are already on screen.
  if (engine.busy && lastAnswered.text && similarity(question, lastAnswered.text) > 0.5) return;
  ask(question, { manual: true });
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

  ipcMain.on('tanay:listen-toggle', () => {
    toggleListening();
    pushMeta();
  });

  ipcMain.on('tanay:clear', () => clearSession());

  ipcMain.on('tanay:overlay-hide', () => windows.getOverlay()?.hide());
  ipcMain.on('tanay:settings', () => windows.createSettings());

  // ------------------------------------------------------------------ settings
  ipcMain.on('settings:close', () => windows.getSettings()?.close());
  ipcMain.on('settings:open-config', () => shell.openPath(config.file()));

  ipcMain.handle('settings:get', async () => {
    const cfg = config.load();
    const opencodego = require('./llm/opencodego');
    let answerModels = [];
    try {
      answerModels = await opencodego.listModels(cfg.opencodeGo);
    } catch {
      answerModels = [];
    }
    return {
      hotkeys: cfg.hotkeys,
      defaults: config.DEFAULTS.hotkeys,
      autoAnswer: cfg.autoAnswer,
      provider: cfg.provider,
      models: { opencodeGo: cfg.opencodeGo.model, deepseek: cfg.deepseek.model },
      answerModels,
      hasKey: {
        'opencode-go': Boolean(cfg.opencodeGo.apiKey),
        deepseek: Boolean(cfg.deepseek.apiKey),
      },
      keysFromEnv: {
        'opencode-go': Boolean(process.env.OPENCODE_API_KEY),
        deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
      },
      transcription: {
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
      patch.deepseek = {};
      if (typeof payload.models.opencodeGo === 'string' && payload.models.opencodeGo)
        patch.opencodeGo.model = payload.models.opencodeGo;
      if (typeof payload.models.deepseek === 'string' && payload.models.deepseek)
        patch.deepseek.model = payload.models.deepseek;
    }

    // An empty key field means "keep what is stored"; a typed one replaces it.
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const section = payload.provider === 'deepseek' ? 'deepseek' : 'opencodeGo';
      patch[section] = { ...(patch[section] || {}), apiKey: payload.apiKey.trim() };
    }

    if (payload.transcription && typeof payload.transcription.modelPath === 'string') {
      patch.tanayvoice = { modelPath: payload.transcription.modelPath };
    }

    config.save(patch);
    const result = applyHotkeys();

    // A model change has to reach the running recogniser, not just the file.
    if (voice) {
      voice.cfg.modelPath = config.resolveModelPath();
      voice.cfg.partialModelPath = config.resolvePartialModelPath();
      if (listening) {
        stopListening();
        startListening();
      }
    }

    windows.refreshTray(trayState());
    pushMeta();

    const cfg = config.load();
    return {
      ok: result.failures.length === 0,
      failures: result.failures,
      registered: result.registered,
      models: { opencodeGo: cfg.opencodeGo.model, deepseek: cfg.deepseek.model },
      hasKey: {
        'opencode-go': Boolean(cfg.opencodeGo.apiKey),
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
    // Check the OS grant first. Asking here (rather than letting getUserMedia
    // surprise us) means a denied prompt produces a real instruction instead of
    // a bare "Microphone unavailable".
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          overlaySend(
            'tanay:error',
            'Microphone is off for TanayAI.\nSystem Settings → Privacy & Security → Microphone → enable TanayAI, then press ⌘⇧L.'
          );
          overlaySend('tanay:status', 'error');
          listening = false;
          watchMicrophonePermission();
          return;
        }
      }
    }

    const cfg = config.load();
    cfg.tanayvoice.modelPath = config.resolveModelPath();
    cfg.tanayvoice.partialModelPath = config.resolvePartialModelPath();
    cfg.tanayvoice.bin = resolveBin(cfg.tanayvoice.bin);

    if (!voice) {
      voice = new TanayVoice(cfg.tanayvoice);
      voice.on('partial', (t) => {
        overlaySend('tanay:caption', t);
        onPartialTranscript(t);
      });
      voice.on('final', onFinalTranscript);
      voice.on('error', (msg) => {
        overlaySend('tanay:error', msg);
        overlaySend('tanay:status', 'error');
      });
    } else {
      voice.cfg = cfg.tanayvoice;
    }

    if (!voice.start()) {
      listening = false;
      return;
    }
    windows.sendToCapture('start');
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

function stopListening() {
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
    if (win) win.showInactive();
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
      const picked = pickLastQuestion();
      console.log('[pick-test]', JSON.stringify(picked));
      console.log('[pick-test] words:', picked.split(/\s+/).length);
      app.quit();
    }

    // `electron . --capture-test` drives the REAL capture path (IPC command ->
    // capture.js -> worklet) and reports where it fails. Unlike --mic-test this
    // does not bypass our own code.
    if (process.argv.includes('--capture-test')) {
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
      turns.push('Okay so tell me about your last project.', 'Can you explain how indexing works in Postgres?');
      engine.onDelta = () => {
        if (!firstAt) firstAt = Date.now() - t0;
      };
      engine.onDone = (text) => {
        console.log(
          '[answer-now]',
          JSON.stringify({ picked: pickLastQuestion(), firstTokenMs: firstAt, totalMs: Date.now() - t0, chars: text.length })
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

    if (cfg.autoStart !== false && !process.env.TANAY_NO_AUTOSTART) startListening();


    pushMeta();
  });
}

app.on('window-all-closed', () => {
  // Subscribing at all stops Electron's default quit; a tray app keeps running.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopListening();
});

app.on('before-quit', () => stopListening());
