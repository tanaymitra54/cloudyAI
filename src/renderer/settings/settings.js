'use strict';

const ACTIONS = [
  ['answer', 'Answer last question'],
  ['answerLastUtterance', 'Answer without question check'],
  ['screenshot', 'Screenshot the active screen'],
  ['send', 'Send text + screenshots'],
  ['toggleListening', 'Start / stop listening'],
  ['toggleOverlay', 'Show / hide panel'],
  ['clear', 'Clear transcript'],
];

// macOS draws shortcuts as symbols; Windows and Linux spell the modifiers out.
const IS_MAC = /Mac/i.test(navigator.userAgent);

const MOD_SYMBOLS = IS_MAC
  ? [
      ['CommandOrControl', '⌘'],
      ['Command', '⌘'],
      ['Control', '⌃'],
      ['Alt', '⌥'],
      ['Shift', '⇧'],
    ]
  : [
      ['CommandOrControl', 'Ctrl'],
      ['Command', 'Ctrl'],
      ['Control', 'Ctrl'],
      ['Alt', 'Alt'],
      ['Shift', 'Shift'],
    ];

const shortcutsEl = document.getElementById('shortcuts');
const providerEl = document.getElementById('provider');
const modelEl = document.getElementById('model');
const visionModelEl = document.getElementById('visionModel');
const visionHintEl = document.getElementById('visionHint');
const apiKeyEl = document.getElementById('apiKey');
const keyHintEl = document.getElementById('keyHint');
const sttModelEl = document.getElementById('sttModel');
const sttEngineEl = document.getElementById('sttEngine');
const captureSystemEl = document.getElementById('captureSystem');
const captureMicEl = document.getElementById('captureMic');
const sessionPromptEl = document.getElementById('sessionPrompt');
const jdTextEl = document.getElementById('jdText');
const resumeFileEl = document.getElementById('resumeFile');
const resumeHintEl = document.getElementById('resumeHint');
const resumePickEl = document.getElementById('resumePick');
const resumeClearEl = document.getElementById('resumeClear');
const jdFileEl = document.getElementById('jdFile');
const jdHintEl = document.getElementById('jdHint');
const jdPickEl = document.getElementById('jdPick');
const jdClearEl = document.getElementById('jdClear');
const statusEl = document.getElementById('status');

let state = { hotkeys: {}, defaults: {}, models: {}, provider: 'opencode-go', visionModel: '', session: {} };
let recording = null; // action currently capturing keys

/**
 * Show which CV / job description is loaded. A file is the source of truth, so
 * the pasted box is hidden while one is attached — otherwise it is not obvious
 * which text the model actually receives.
 */
function renderDocuments() {
  const session = state.session || {};

  const resumeName = session.resumeFile || '';
  resumeFileEl.textContent = resumeName || 'No file';
  resumeFileEl.className = `doc-file${resumeName ? '' : ' empty'}`;
  resumeClearEl.hidden = !resumeName;
  resumeHintEl.textContent = resumeName
    ? `Answers use this CV — ${session.resumeChars || 0} characters of text read.`
    : 'The model answers using your real experience. PDF, .txt or .md.';

  const jdName = session.jobDescriptionFile || '';
  jdFileEl.textContent = jdName || 'No file';
  jdFileEl.className = `doc-file${jdName ? '' : ' empty'}`;
  jdClearEl.hidden = !jdName;

  // A file and pasted text are alternatives; the file wins and the box is hidden.
  jdTextEl.hidden = Boolean(jdName);
  jdTextEl.value = jdName ? '' : session.jobDescriptionText || '';
  jdHintEl.textContent = jdName
    ? `Answers target this posting — ${session.jobDescriptionChars || 0} characters of text read.`
    : 'Answers are angled toward this role. Paste the posting, or upload a PDF.';
}

/** Uploads apply immediately (no Save needed) and re-render the document rows. */
async function pickDocument(kind) {
  statusEl.className = 'status';
  statusEl.textContent = 'Reading file…';
  const result = await window.tanaySettings.pickDocument(kind);
  if (result.canceled) {
    statusEl.textContent = '';
    return;
  }
  if (!result.ok) {
    statusEl.className = 'status error';
    statusEl.textContent = result.error;
    return;
  }
  state.session = {
    ...(state.session || {}),
    ...(kind === 'resume'
      ? { resumeFile: result.name, resumeChars: result.chars }
      : { jobDescriptionFile: result.name, jobDescriptionChars: result.chars, jobDescriptionText: '' }),
  };
  renderDocuments();
  statusEl.className = 'status';
  statusEl.textContent = `${kind === 'resume' ? 'CV' : 'Job description'} loaded — ${result.chars} characters.`;
}

async function clearDocument(kind) {
  await window.tanaySettings.clearDocument(kind);
  state.session = {
    ...(state.session || {}),
    ...(kind === 'resume'
      ? { resumeFile: '', resumeChars: 0 }
      : { jobDescriptionFile: '', jobDescriptionChars: 0, jobDescriptionText: '' }),
  };
  renderDocuments();
  statusEl.className = 'status';
  statusEl.textContent = `${kind === 'resume' ? 'CV' : 'Job description'} removed.`;
}

resumePickEl.addEventListener('click', () => pickDocument('resume'));
resumeClearEl.addEventListener('click', () => clearDocument('resume'));
jdPickEl.addEventListener('click', () => pickDocument('job-description'));
jdClearEl.addEventListener('click', () => clearDocument('job-description'));

function pretty(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((part) => {
      const hit = MOD_SYMBOLS.find(([name]) => name.toLowerCase() === part.toLowerCase());
      return hit ? hit[1] : part.replace('Enter', '↵');
    })
    .join(IS_MAC ? '' : '+');
}

function renderShortcuts() {
  shortcutsEl.innerHTML = '';
  for (const [action, label] of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';

    const name = document.createElement('span');
    name.textContent = label;

    const keys = document.createElement('button');
    keys.className = `keys${state.hotkeys[action] ? '' : ' empty'}`;
    keys.textContent = recording === action ? 'press keys…' : pretty(state.hotkeys[action]) || 'unset';
    if (recording === action) keys.classList.add('recording');

    keys.addEventListener('click', () => {
      recording = action;
      renderShortcuts();
    });

    row.append(name, keys);
    shortcutsEl.append(row);
  }
}

// Turn a keydown into an Electron accelerator. Requires a real modifier so a
// plain letter cannot be registered globally and swallow normal typing.
function acceleratorFromEvent(event) {
  const mods = [];
  if (event.metaKey) mods.push('CommandOrControl');
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (!mods.length) return null;

  const k = event.key;
  let key = null;
  if (/^[a-z]$/i.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F\d{1,2}$/.test(k)) key = k.toUpperCase();
  else if (k === 'Enter') key = 'Enter';
  else if (k === ' ') key = 'Space';
  else if (k === 'Tab') key = 'Tab';
  else if (k === 'Backspace') key = 'Backspace';
  else if (k === 'Escape') key = 'Escape';
  else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) key = k.replace('Arrow', '');
  else if (['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`'].includes(k)) key = k;

  if (!key) return null;
  return [...mods, key].join('+');
}

window.addEventListener('keydown', (event) => {
  if (!recording) return;
  event.preventDefault();

  if (event.key === 'Escape') {
    recording = null;
    renderShortcuts();
    return;
  }

  const accelerator = acceleratorFromEvent(event);
  if (!accelerator) {
    statusEl.className = 'status error';
    statusEl.textContent = IS_MAC
      ? 'Use at least one modifier (⌘, ⌃, ⌥).'
      : 'Use at least one modifier (Ctrl, Alt, Shift).';
    return;
  }

  state.hotkeys[recording] = accelerator;
  recording = null;
  statusEl.className = 'status';
  statusEl.textContent = '';
  renderShortcuts();
});

function currentModel() {
  if (state.provider === 'opencode-go') return state.models.opencodeGo || '';
  if (state.provider === 'commandcode-api') return state.models.commandCodeApi || '';
  if (state.provider === 'deepseek') return state.models.deepseek || '';
  return '';
}

function syncKeyField() {
  const hasStored = Boolean(state.hasKey?.[state.provider]);
  const fromEnv = Boolean(state.keysFromEnv?.[state.provider]);
  apiKeyEl.value = '';
  apiKeyEl.disabled = state.provider === 'opencode' || state.provider === 'commandcode';

  if (apiKeyEl.disabled) {
    apiKeyEl.placeholder = 'not used by CLI providers';
    keyHintEl.textContent = 'opencode and commandcode use the credentials stored by their own CLI (opencode auth login).';
    return;
  }
  if (fromEnv) {
    apiKeyEl.placeholder = 'set by environment (.env)';
    keyHintEl.textContent =
      'The key comes from OPENCODE_API_KEY / COMMANDCODE_API_KEY / DEEPSEEK_API_KEY in .env; that wins over anything saved here.';
  } else if (hasStored) {
    apiKeyEl.placeholder = '•••••••• stored (leave blank to keep)';
    keyHintEl.textContent = 'A key is stored. Type a new one to replace it.';
  } else if (state.provider === 'commandcode-api') {
    apiKeyEl.placeholder = 'paste Command Code API key';
    keyHintEl.textContent =
      'Create it at commandcode.ai/settings/keys (or in Studio). This is the Provider API key, not the commandcode CLI login.';
  } else {
    apiKeyEl.placeholder = 'paste key';
    keyHintEl.textContent = 'Paste your key — it is saved to config.json with owner-only permissions.';
  }
}

/** The model list for the active provider, shared by both pickers. */
function providerModelList() {
  const value = currentModel();
  if (state.provider === 'deepseek') {
    return [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ];
  }
  if (state.provider === 'commandcode-api') {
    return state.commandCodeModels?.length ? state.commandCodeModels : [{ id: value, name: value || 'no models found' }];
  }
  if (state.answerModels?.length) return state.answerModels;
  return [{ id: value, name: value || 'no models found' }];
}

// Kept in sync with VISION_MODELS in src/main/llm/index.js, for the label.
const AUTO_VISION = {
  'commandcode-api': 'google/gemini-3.8-flash',
  'opencode-go': 'gemini-4-argon',
};

function syncVisionField() {
  const cli = state.provider === 'opencode' || state.provider === 'commandcode';
  visionModelEl.disabled = cli;

  if (cli) {
    visionModelEl.innerHTML = '<option value="">not available for CLI providers</option>';
    visionHintEl.textContent =
      'The CLI providers cannot receive images. Switch to opencode-go or commandcode API to use the screenshot button.';
    return;
  }

  const list = providerModelList();
  const auto = AUTO_VISION[state.provider];
  const autoLabel = auto ? `Auto (${auto})` : 'Auto (none — pick a vision model)';
  visionModelEl.innerHTML = [
    `<option value="">${autoLabel}</option>`,
    ...list.map((m) => `<option value="${m.id}">${m.name}</option>`),
  ].join('');

  const chosen = String(state.visionModel || '');
  if (chosen && !list.some((m) => m.id === chosen)) {
    const opt = document.createElement('option');
    opt.value = chosen;
    opt.textContent = `${chosen} (current)`;
    visionModelEl.append(opt);
  }
  visionModelEl.value = chosen;

  visionHintEl.textContent = auto
    ? 'Screenshots are sent to this model. Auto uses the provider vision model; a text-only model would invent what is on screen.'
    : 'This provider has no vision model. Screenshots will ask you to switch provider or set one here.';
}

function syncModelField() {
  const value = currentModel();
  modelEl.disabled = state.provider === 'opencode' || state.provider === 'commandcode';

  // CLI providers take the model in config.json, not here.
  if (modelEl.disabled) {
    modelEl.innerHTML = '<option>set in config.json</option>';
    return;
  }

  const list = providerModelList();

  modelEl.innerHTML = list.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');

  // Keep an unknown current value selectable instead of silently changing it.
  if (value && !list.some((m) => m.id === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value} (current)`;
    modelEl.prepend(opt);
  }
  if (value) modelEl.value = value;
}

providerEl.addEventListener('change', () => {
  state.provider = providerEl.value;
  syncModelField();
  syncVisionField();
  syncKeyField();
});

document.getElementById('reset').addEventListener('click', () => {
  state.hotkeys = { ...state.defaults };
  renderShortcuts();
  statusEl.className = 'status';
  statusEl.textContent = 'Shortcuts reset to defaults — press Save to apply.';
});

document.getElementById('config').addEventListener('click', () => window.tanaySettings.openConfig());
document.getElementById('close').addEventListener('click', () => window.tanaySettings.close());

document.getElementById('save').addEventListener('click', async () => {
  const models = { ...state.models };
  if (state.provider === 'opencode-go') models.opencodeGo = modelEl.value.trim();
  if (state.provider === 'commandcode-api') models.commandCodeApi = modelEl.value.trim();
  if (state.provider === 'deepseek') models.deepseek = modelEl.value.trim();

  const payload = {
    hotkeys: state.hotkeys,
    provider: state.provider,
    models,
    visionModel: visionModelEl.value,
    transcription: {
      engine: sttEngineEl.value,
      captureSystem: captureSystemEl.checked,
      captureMic: captureMicEl.checked,
      modelPath: sttModelEl.value,
    },
    sessionPrompt: sessionPromptEl.value,
    jobDescriptionText: jdTextEl.value,
    // An attached file is never overwritten by the (hidden) paste box.
    keepJobDescriptionFile: Boolean(state.session?.jobDescriptionFile),
  };
  if (apiKeyEl.value.trim()) payload.apiKey = apiKeyEl.value.trim();

  const result = await window.tanaySettings.save(payload);

  if (result.failures && result.failures.length) {
    statusEl.className = 'status error';
    statusEl.textContent = result.failures.map((f) => `${f.action} (${pretty(f.accelerator)}) — ${f.reason}`).join('\n');
  } else {
    statusEl.className = 'status';
    statusEl.textContent = 'Saved. Shortcuts are live.';
  }
  if (result.models) state.models = { ...state.models, ...result.models };
  if (result.hasKey) state.hasKey = result.hasKey;
  state.visionModel = visionModelEl.value;
  // A newly saved key can unlock the live model list, and the session summary
  // reflects the job description that was just saved.
  try {
    const refreshed = await window.tanaySettings.get();
    if (refreshed.commandCodeModels) state.commandCodeModels = refreshed.commandCodeModels;
    if (refreshed.answerModels) state.answerModels = refreshed.answerModels;
    if (refreshed.session) state.session = refreshed.session;
  } catch {
    /* keep the list we already have */
  }
  syncModelField();
  syncVisionField();
  syncKeyField();
  renderDocuments();
});

(async () => {
  const loaded = await window.tanaySettings.get();
  state = { ...state, ...loaded, hotkeys: { ...loaded.hotkeys } };
  providerEl.value = loaded.provider;
  sessionPromptEl.value = loaded.session?.prompt || '';
  renderDocuments();

  // Populate the recogniser list from the models actually present on disk.
  // Parakeet is a macOS/Neural Engine helper, so it is not offered elsewhere.
  if (!IS_MAC) {
    sttEngineEl.querySelector('option[value="parakeet"]')?.remove();
    sttEngineEl.value = 'whisper';
  } else {
    sttEngineEl.value = loaded.transcription?.engine === 'whisper' ? 'whisper' : 'parakeet';
  }
  captureSystemEl.checked = loaded.transcription?.captureSystem !== false;
  captureMicEl.checked = loaded.transcription?.captureMic !== false;
  const models = loaded.transcription?.available || [];
  sttModelEl.innerHTML = models
    .map((m) => `<option value="${m.file}">${m.name.replace(/^ggml-|\.bin$/g, '')}</option>`)
    .join('');
  if (loaded.transcription?.modelPath) {
    sttModelEl.value = loaded.transcription.modelPath;
    if (!sttModelEl.value) {
      // Current model lives outside the scanned folders; show it explicitly.
      const opt = document.createElement('option');
      opt.value = loaded.transcription.modelPath;
      opt.textContent = loaded.transcription.modelPath.split('/').pop();
      sttModelEl.append(opt);
      sttModelEl.value = loaded.transcription.modelPath;
    }
  }

  renderShortcuts();
  syncModelField();
  syncVisionField();
  syncKeyField();
})();
