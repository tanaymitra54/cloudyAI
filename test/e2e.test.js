'use strict';

// End-to-end latency + accuracy check through the REAL pipeline:
//   WAV -> TanayVoice (VAD, whisper) -> detection -> opencode-go -> first token
//
//   node test/e2e.test.js /path/to/16k-mono.wav
//
// Audio is fed at real time so the numbers mean what they say. A negative
// "speech end -> first token" means the answer had already begun before the
// speaker stopped talking, which is the whole point of speculative answering.

const fs = require('fs');
const path = require('path');
const { TanayVoice } = require('../src/main/stt/TanayVoice');
const { scoreQuestion, similarity, wordCount } = require('../src/main/detection');
const opencodego = require('../src/main/llm/opencodego');
const { systemPrompt, buildUserPrompt } = require('../src/main/prompts');

const wavPath = process.argv[2];
if (!wavPath) {
  console.error('usage: node test/e2e.test.js <16k-mono.wav>');
  process.exit(2);
}

function readEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const env = readEnv();
const pcm = readWav(wavPath);

// Mirror the app: base.en for both, which matched small.en on clean and noisy
// interview audio at roughly half the decode time.
const modelDir = path.join(process.env.HOME, '.cache', 'tanayvoice');
const finalModel = path.join(modelDir, 'ggml-base.en.bin');

const voice = new TanayVoice({
  bin: '/opt/homebrew/bin/whisper-cli',
  modelPath: finalModel,
  partialModelPath: finalModel,
  language: 'en',
  threads: 4,
  beamSize: 5,
  preRollMs: 200,
  silenceMs: 700,
  minSpeechMs: 400,
  maxSegmentMs: 15000,
  partialEveryMs: 1500,
  partialTailMs: 8000,
  initialPrompt:
    'Job interview conversation. Technical vocabulary: JavaScript, Python, SQL, API, Kubernetes, microservices, latency, throughput, caching, hash map, recursion, complexity, system design.',
});

let feedEndAt = 0; // when the last real audio chunk was pushed
let fired = null; // { text, at, label }
let pending = 0;
let speculated = false; // mirrors the app: one speculative answer per utterance

function answer(text, label, { partial = false } = {}) {
  if (fired) {
    const sim = similarity(text, fired.text);
    // Partials never re-speculate on the same utterance; only a final may
    // supersede an earlier speculative answer, and only if it actually grew.
    if (partial) {
      if (sim > 0.5) return;
    } else {
      const grew = wordCount(text) > wordCount(fired.text) * 1.15;
      if (sim > 0.5 && !grew) return;
    }
  }

  const mine = { text, at: Date.now(), label };
  fired = mine;
  let firstTokenAt = 0;
  pending++;

  opencodego
    .complete({
      cfg: { apiKey: env.OPENCODE_API_KEY, model: 'deepseek-v4.1-flash' },
      system: systemPrompt('interview'),
      user: buildUserPrompt({ transcript: text, profile: 'interview' }),
      onDelta: () => {
        if (!firstTokenAt) firstTokenAt = Date.now();
      },
    })
    .then((r) => {
      pending--;
      const speechEnd = feedEndAt || mine.at;
      console.log(`\n[${label}] ${r.text.length} chars`);
      console.log(`  transcript            : ${text}`);
      console.log(`  caption -> first token: ${firstTokenAt - mine.at} ms`);
      console.log(`  speech end -> first tok: ${firstTokenAt - speechEnd} ms  (negative = before speaker stopped)`);
      console.log(`  speech end -> complete : ${Date.now() - speechEnd} ms`);
      console.log(`\n${r.text.slice(0, 200)}`);
      if (!pending && feedEndAt) process.exit(0);
    })
    .catch((err) => {
      pending--;
      console.error('FAIL', err.message);
      process.exit(1);
    });
}

voice.on('partial', (t) => {
  if (speculated) return;
  const v = scoreQuestion(t);
  if (v.speculativeSafe) {
    speculated = true;
    answer(t, 'speculative/partial', { partial: true });
  }
});

voice.on('final', (t) => {
  speculated = false;
  const v = scoreQuestion(t);
  const after = lastSpeechAt ? Date.now() - lastSpeechAt : 0;
  console.log(`final @+${after}ms after last audio: score=${v.score} [${v.reason}] :: ${t}`);
  if (v.isQuestion) answer(t, 'final');
});

if (!voice.start()) process.exit(1);

let i = 0;
const CHUNK = 1600; // 100 ms
let lastSpeechAt = 0;
const timer = setInterval(() => {
  if (i >= pcm.length) {
    clearInterval(timer);
    feedEndAt = Date.now();
    for (let s = 0; s < 6; s++) voice.push(new Int16Array(CHUNK));
    setTimeout(() => {
      if (!fired) {
        console.log('\nNo question detected.');
        process.exit(1);
      }
    }, 15000);
    return;
  }
  voice.push(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
  i += CHUNK;
  lastSpeechAt = Date.now();
}, 100);
