'use strict';

const ACTIONS = [
  ['answer', 'Answer last question'],
  ['answerLastUtterance', 'Answer without question check'],
  ['toggleListening', 'Start / stop listening'],
  ['toggleOverlay', 'Show / hide panel'],
  ['clear', 'Clear transcript'],
];

const MOD_SYMBOLS = [
  ['CommandOrControl', '⌘'],
  ['Command', '⌘'],
  ['Control', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
];

const shortcutsEl = document.getElementById('shortcuts');
const providerEl = document.getElementById('provider');
const modelEl = document.getElementById('model');
const apiKeyEl = document.getElementById('apiKey');
const keyHintEl = document.getElementById('keyHint');
const sttModelEl = document.getElementById('sttModel');
const sttEngineEl = document.getElementById('sttEngine');
const audioSourceEl = document.getElementById('audioSource');
const autoAnswerEl = document.getElementById('autoAnswer');
const statusEl = document.getElementById('status');

let state = { hotkeys: {}, defaults: {}, models: {}, provider: 'opencode-go' };
let recording = null; // action currently capturing keys

function pretty(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((part) => {
      const hit = MOD_SYMBOLS.find(([name]) => name.toLowerCase() === part.toLowerCase());
      return hit ? hit[1] : part.replace('Enter', '↵');
    })
    .join('');
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
    statusEl.textContent = 'Use at least one modifier (⌘, ⌃, ⌥).';
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

function syncModelField() {
  const value = currentModel();
  modelEl.disabled = state.provider === 'opencode' || state.provider === 'commandcode';

  // CLI providers take the model in config.json, not here.
  if (modelEl.disabled) {
    modelEl.innerHTML = '<option>set in config.json</option>';
    return;
  }

  let list;
  if (state.provider === 'deepseek') {
    list = [
      { id: 'deepseek-chat', name: 'deepseek-chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ];
  } else if (state.provider === 'commandcode-api') {
    list = state.commandCodeModels?.length ? state.commandCodeModels : [{ id: value, name: value || 'no models found' }];
  } else if (state.answerModels?.length) {
    list = state.answerModels;
  } else {
    list = [{ id: value, name: value || 'no models found' }];
  }

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
    autoAnswer: autoAnswerEl.checked,
    provider: state.provider,
    models,
    transcription: { engine: sttEngineEl.value, source: audioSourceEl.value, modelPath: sttModelEl.value },
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
  // A newly saved key can unlock the live model list.
  try {
    const refreshed = await window.tanaySettings.get();
    if (refreshed.commandCodeModels) state.commandCodeModels = refreshed.commandCodeModels;
    if (refreshed.answerModels) state.answerModels = refreshed.answerModels;
  } catch {
    /* keep the list we already have */
  }
  syncModelField();
  syncKeyField();
});

(async () => {
  const loaded = await window.tanaySettings.get();
  state = { ...state, ...loaded, hotkeys: { ...loaded.hotkeys } };
  autoAnswerEl.checked = Boolean(loaded.autoAnswer);
  providerEl.value = loaded.provider;

  // Populate the recogniser list from the models actually present on disk.
  sttEngineEl.value = loaded.transcription?.engine === 'whisper' ? 'whisper' : 'parakeet';
  audioSourceEl.value = loaded.transcription?.source === 'mic' ? 'mic' : 'system';
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
  syncKeyField();
})();
