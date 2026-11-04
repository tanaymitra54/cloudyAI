'use strict';

// Lifecycle invariants that make ⌘J reliable:
//   - the closing utterance stays readable (`pendingText`) while it decodes;
//   - a caption that resolves after the utterance closed is dropped;
//   - duplicate-final dedupe is short-lived and disappears on reset.

const assert = require('assert');
const { CloudyVoice } = require('../src/main/stt/CloudyVoice');

const baseCfg = {
  engine: 'whisper',
  bin: '/bin/true',
  modelPath: '/tmp/does-not-matter',
  language: 'en',
  threads: 1,
  preRollMs: 100,
  silenceMs: 500,
  minSpeechMs: 250,
  maxSegmentMs: 15000,
  partialEveryMs: 900,
  partialTailMs: 4500,
  beamSize: 1,
};

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function testPendingTextSurvivesFinalize() {
  const voice = new CloudyVoice({ ...baseCfg });
  voice.running = true;
  voice.speaking = true;
  voice.seg = [new Int16Array(1600 * 10)];
  voice.segMs = 1000;
  voice.silenceMs = 500;
  voice.partialText = 'Can you explain database indexes?';
  voice.transcribe = () => new Promise(() => {}); // decode stays in flight

  voice.finalize();

  assert.strictEqual(voice.pendingText, 'Can you explain database indexes?');
  assert.strictEqual(voice.partialText, '');
  assert.strictEqual(voice.finalizing, true);
  console.log('ok   closing utterance stays readable during the decode');
}

async function testStaleCaptionIsDropped() {
  const voice = new CloudyVoice({ ...baseCfg });
  voice.running = true;
  voice.speaking = true;
  voice.seg = [new Int16Array(16000)];
  voice.segMs = 1000;
  voice.partialTailMs = 1000;

  let resolvePartial;
  voice.transcribe = (_audio, kind) => {
    if (kind === 'partial') return new Promise((resolve) => (resolvePartial = resolve));
    return Promise.resolve('');
  };

  let partials = 0;
  voice.on('partial', () => (partials += 1));

  voice.emitPartial();
  voice.finalize(); // bumps the epoch and clears the segment
  resolvePartial('This caption arrived too late');
  await tick();

  assert.strictEqual(partials, 0, 'late caption must not repopulate partialText');
  console.log('ok   stale caption after finalize is dropped');
}

async function testDuplicateDedupeIsShortLived() {
  const voice = new CloudyVoice({ ...baseCfg });
  voice.running = true;
  voice.transcribe = () => Promise.resolve('Why?');

  let finals = 0;
  voice.on('final', () => (finals += 1));

  voice.runFinal(new Int16Array(3200), {});
  await tick();
  voice.runFinal(new Int16Array(3200), {});
  await tick();
  assert.strictEqual(finals, 1, 'a duplicate decode of the same text within 1.5 s is dropped');

  voice.reset();
  voice.running = true;
  voice.runFinal(new Int16Array(3200), {});
  await tick();
  assert.strictEqual(finals, 2, 'a repeated question after clear must still land');
  console.log('ok   duplicate-final dedupe is short-lived and reset clears it');
}

(async () => {
  await testPendingTextSurvivesFinalize();
  await testStaleCaptionIsDropped();
  await testDuplicateDedupeIsShortLived();
  console.log('\nall cloudyvoice lifecycle cases passed');
})().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
