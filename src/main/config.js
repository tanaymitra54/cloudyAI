'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  provider: 'opencode-go', // opencode-go | deepseek | opencode | commandcode
  opencodeGo: {
    // Prefer OPENCODE_API_KEY in .env over storing it here.
    apiKey: '',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    // gpt-5.6-luna: fastest model that returns visible text reliably.
    // deepseek-v4.1-flash is a reasoning model and sometimes spends the whole
    // budget thinking, returning an empty answer.
    model: 'gpt-5.6-luna',
  },
  deepseek: {
    // Prefer the DEEPSEEK_API_KEY env var / .env over storing it here.
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  opencode: {
    bin: 'opencode',
    model: '', // e.g. deepseek/deepseek-chat
    timeoutMs: 90000,
  },
  commandcode: {
    bin: 'commandcode',
    // {prompt} is replaced with the prompt; keep the prompt as ONE argv entry.
    args: ['-p', '{prompt}'],
    timeoutMs: 90000,
  },
  tanayvoice: {
    bin: 'whisper-cli',
    modelPath: '', // empty = <userData>/models/ggml-base.en.bin
    language: 'en',
    threads: 4,
    beamSize: 5, // beam search on finals only
    preRollMs: 200, // audio kept before speech onset so the first word is not clipped
    // A 260 ms pause is not an utterance boundary — people breathe mid-sentence.
    // Cutting there split questions into fragments, which is what made
    // transcription look wrong. 700 ms keeps whole sentences together.
    silenceMs: 700,
    minSpeechMs: 400, // ignore utterances shorter than this
    maxSegmentMs: 15000, // long interviewer questions must not be chopped
    partialEveryMs: 1500, // live-caption cadence while speaking
    partialTailMs: 8000, // how much audio a live caption sees
    // Biases decoding toward the vocabulary of technical interviews.
    initialPrompt:
      'Job interview conversation. Technical vocabulary: JavaScript, TypeScript, Python, SQL, API, REST, GraphQL, Kubernetes, Docker, microservices, latency, throughput, caching, Redis, Postgres, index, hash map, recursion, dynamic programming, time complexity, Big O, system design, load balancer, CI/CD, AWS.',
  },
  overlay: {
    width: 720,
    height: 620,
    opacity: 0.96,
  },
  profile: 'interview',
  resumePath: '',
  contextTurns: 3,
  // Manual by default: the app transcribes continuously but only answers when
  // you press the hotkey. Turn this on to have it answer questions by itself.
  autoAnswer: false,
  // Every shortcut lives here and can be edited while the app runs.
  hotkeys: {
    answer: 'CommandOrControl+J', // answer the last question
    answerLastUtterance: 'CommandOrControl+Shift+Enter', // answer whatever was said last
    toggleOverlay: 'CommandOrControl+Shift+A',
    toggleListening: 'CommandOrControl+Shift+L',
    clear: 'CommandOrControl+Shift+R',
  },
  hedge: {
    // Race a second model when the first is slow to produce a token. Cuts tail
    // latency (provider queues swing 1.4-9 s) at the cost of a second request
    // whenever the primary takes longer than delayMs. Off by default: it spends
    // your plan's budget to buy speed.
    enabled: false,
    delayMs: 700,
    model: 'claude-haiku-5-5',
  },
};

let cache = null;
let rawDisk = {};
let configPath = null;

function deepMerge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function file() {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json');
  return configPath;
}

// Provider API keys can come from the environment; env always wins and is
// never written back to disk.
const KEY_SOURCES = [
  ['opencodeGo', 'OPENCODE_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
];

function applyEnv(cfg) {
  for (const [section, envName] of KEY_SOURCES) {
    const value = process.env[envName];
    if (value) cfg[section].apiKey = value;
  }
  return cfg;
}

function load() {
  if (cache) return cache;
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    onDisk = {};
  }

  // Migrate shortcuts from the old overlay.* location so an existing config
  // keeps working after the hotkeys map was introduced.
  if (onDisk.overlay?.hotkeyToggle || onDisk.overlay?.hotkeyClear) {
    onDisk.hotkeys = {
      toggleOverlay: onDisk.overlay.hotkeyToggle,
      clear: onDisk.overlay.hotkeyClear,
      ...(onDisk.hotkeys || {}),
    };
  }

  rawDisk = onDisk;
  cache = applyEnv(deepMerge(DEFAULTS, onDisk));
  return cache;
}

/** Drop the cache so the next load() re-reads the file (used by the watcher). */
function reload() {
  cache = null;
  return load();
}

function save(patch) {
  cache = applyEnv(deepMerge(load(), patch || {}));

  const toWrite = JSON.parse(JSON.stringify(cache));

  // A key that came from the environment is not persisted, but a key already
  // stored on disk must not be erased just because env happened to override it
  // for this session (that would break the next launch from Finder).
  for (const [section, envName] of KEY_SOURCES) {
    if (!process.env[envName]) continue;
    const stored = rawDisk?.[section]?.apiKey;
    toWrite[section].apiKey = stored || '';
  }

  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(toWrite, null, 2), { encoding: 'utf8', mode: 0o600 });
  rawDisk = toWrite;
  return cache;
}

function get(keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? o : o[k]), load());
}

function findModel(fileName) {
  const local = path.join(app.getPath('userData'), 'models', fileName);
  const cache = path.join(app.getPath('home'), '.cache', 'tanayvoice', fileName);
  if (fs.existsSync(local)) return local;
  if (fs.existsSync(cache)) return cache;
  return local;
}

/**
 * Finals default to base.en: with the domain prompt it matched small.en on
 * clean and noisy interview audio, and it is ~2x faster. Point `modelPath` at
 * ggml-small.en.bin (or medium) if your recording conditions are worse.
 */
function resolveModelPath() {
  const cfg = load().tanayvoice;
  if (cfg.modelPath) return cfg.modelPath;
  return findModel('ggml-base.en.bin');
}

/** Live captions can run the faster model; they only need to keep up with speech. */
function resolvePartialModelPath() {
  const cfg = load().tanayvoice;
  if (cfg.partialModelPath) return cfg.partialModelPath;
  return findModel('ggml-base.en.bin');
}

/** Every GGML model available on this machine, newest locations first. */
function listModels() {
  const dirs = [
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getPath('home'), '.cache', 'tanayvoice'),
  ];
  const seen = new Map();
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/^ggml-.*\.bin$/.test(name)) continue;
        if (!seen.has(name)) seen.set(name, path.join(dir, name));
      }
    } catch {
      /* directory may not exist */
    }
  }
  return [...seen.entries()].map(([name, file]) => ({ name, file }));
}

module.exports = {
  DEFAULTS,
  load,
  reload,
  save,
  get,
  file,
  resolveModelPath,
  resolvePartialModelPath,
  findModel,
  listModels,
};
