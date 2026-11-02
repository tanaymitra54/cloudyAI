'use strict';

// Headless test for TanayVoice: feed a 16 kHz mono WAV through the real VAD +
// whisper.cpp path in 100 ms chunks, exactly like the renderer does.
//
//   node test/tanayvoice.test.js /path/to/audio.wav

const fs = require('fs');
const path = require('path');
const { TanayVoice } = require('../src/main/stt/TanayVoice');

const wavPath = process.argv[2];
if (!wavPath) {
  console.error('usage: node test/tanayvoice.test.js <16k-mono.wav>');
  process.exit(2);
}

const buf = fs.readFileSync(wavPath);
// find the data chunk
let off = 12;
let dataOff = -1;
let dataLen = 0;
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === 'data') {
    dataOff = off + 8;
    dataLen = size;
    break;
  }
  off += 8 + size + (size % 2);
}
if (dataOff < 0) {
  console.error('not a wav');
  process.exit(2);
}

const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + dataOff, buf.byteOffset + dataOff + dataLen));

const model = path.join(process.env.HOME, '.cache', 'tanayvoice', 'ggml-base.en.bin');
const voice = new TanayVoice({
  bin: '/opt/homebrew/bin/whisper-cli',
  modelPath: model,
  language: 'en',
  threads: 4,
  silenceMs: 380,
  minSpeechMs: 400,
  maxSegmentMs: 8000,
  partialEveryMs: 1200,
  partialTailMs: 5000,
});

let finals = 0;
const started = Date.now();

voice.on('partial', (t) => console.log(`[partial ${String(Date.now() - started).padStart(5)}ms] ${t}`));
voice.on('final', (t) => {
  finals++;
  console.log(`[FINAL   ${String(Date.now() - started).padStart(5)}ms] ${t}`);
});
voice.on('error', (e) => console.error('[error]', e));

if (!voice.start()) process.exit(1);

// 1600 samples = 100 ms
const CHUNK = 1600;
let i = 0;
const timer = setInterval(() => {
  if (i >= pcm.length) {
    clearInterval(timer);
    // trailing silence so the last utterance closes
    for (let s = 0; s < 8; s++) voice.push(new Int16Array(CHUNK));
    setTimeout(() => {
      voice.stop();
      console.log(`\n${finals} final segment(s), model=${path.basename(model)}`);
      process.exit(finals > 0 ? 0 : 1);
    }, 4000);
    return;
  }
  voice.push(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
  i += CHUNK;
}, 20); // faster than real time
