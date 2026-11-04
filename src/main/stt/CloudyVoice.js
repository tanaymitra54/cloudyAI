'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWav, concatInt16, tail } = require('./wav');
const { CloudyEar } = require('./CloudyEar');

const SAMPLE_RATE = 16000; // the renderer resamples to this before sending
const MS_PER_SAMPLE = 1000 / SAMPLE_RATE;

// Whisper hallucinates on silence and on clipped audio. These are the usual
// artifacts; treat them as "nothing was said".
const NOISE = /^(\[?\(?(blank_?audio|silence|music|inaudible|no speech)\)?\]?|thank you\.?|thanks for watching!?\.?|you\.?)$/i;

function rms(chunk) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < chunk.length; i += 4) {
    const v = chunk[i] / 32768;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function cleanup(text) {
  let t = (text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^)]*(?:silence|music|inaudible|applause)[^)]*)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || NOISE.test(t)) return '';
  return t;
}

/**
 * CloudyVoice — on-device streaming transcription.
 *
 * Audio arrives as 16 kHz Int16 chunks. An adaptive energy VAD segments speech
 * into utterances; each utterance is transcribed with whisper.cpp on Metal.
 * While someone is still talking, the tail of the utterance is transcribed
 * periodically so the overlay can show a live caption.
 *
 * Events: 'partial' (text, isFinal:false), 'final' (text), 'status', 'error'
 */
class CloudyVoice extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.seg = [];
    this.segMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.floor = 0.004;
    this.lastPartialAt = 0;
    this.running = false;
    this.busy = false;
    this.queuedFinal = null;
    this.tmpDir = path.join(os.tmpdir(), 'cloudyvoice');
    this.lastFinal = { text: '', at: 0 };
    this.partialText = '';
    // The text of the utterance that just closed. It stays readable while the
    // final decode runs, so ⌘J cannot fall back to an older question.
    this.pendingText = '';
    this.pendingAt = 0;
    this.utteranceId = 0;
    this.segStartAt = 0;
    this.finalizing = false;
    this._seq = 0;
    // Bumped whenever an utterance closes or the session resets; a caption that
    // resolves afterwards is stale and must be dropped.
    this._epoch = 0;
    // Pre-roll: keep the last few chunks of "silence" so the first syllable of a
    // question is not clipped when the VAD fires late.
    this.pre = [];
    this.preMsAdded = 0;

    // engine: 'parakeet' (FluidAudio, Neural Engine) or 'whisper' (whisper.cpp).
    this.ear = null;
    if (cfg.engine === 'parakeet') {
      this.ear = new CloudyEar({ bin: cfg.parakeetBin, modelsDir: cfg.parakeetModelsDir });
      this.ear.on('loading', () => this.emit('loading'));
      this.ear.on('ready', () => this.emit('ready'));
      this.ear.on('progress', (percent) => this.emit('progress', percent));
      this.ear.on('error', (message) => this.emit('error', `CloudyEar: ${message}`));
    }
  }

  get modelPath() {
    return this.cfg.modelPath;
  }

  /** Captions can run the smaller model; finals get the accurate one. */
  modelFor(kind) {
    if (kind === 'partial' && this.cfg.partialModelPath) return this.cfg.partialModelPath;
    return this.modelPath;
  }

  check() {
    if (this.ear) return this.ear.check();
    if (!fs.existsSync(this.cfg.bin)) {
      return `whisper.cpp CLI not found at "${this.cfg.bin}". Run: brew install whisper-cpp`;
    }
    if (!fs.existsSync(this.modelPath)) {
      return `CloudyVoice model missing: ${this.modelPath}\nRun: npm run get-model (or download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp)`;
    }
    if (this.cfg.partialModelPath && !fs.existsSync(this.cfg.partialModelPath)) {
      return `CloudyVoice caption model missing: ${this.cfg.partialModelPath}`;
    }
    return null;
  }

  start() {
    const problem = this.check();
    if (problem) {
      this.emit('error', problem);
      return false;
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.running = true;
    this.reset();
    // Parakeet loads its model once; start that now rather than on the first question.
    this.ear?.warm();
    this.emit('status', 'listening');
    return true;
  }

  stop() {
    this.running = false;
    this.reset();
    this.emit('status', 'idle');
  }

  /** Release the helper process (app quit). */
  shutdown() {
    this.stop();
    this.ear?.shutdown();
  }

  reset() {
    this._epoch += 1;
    this.seg = [];
    this.segMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.partialText = '';
    this.pendingText = '';
    this.pendingAt = 0;
    this.queuedFinal = null;
    this.lastPartialAt = 0;
    this.segStartAt = 0;
    this.finalizing = false;
    this.pre = [];
    this.preMsAdded = 0;
    this.lastFinal = { text: '', at: 0 };
  }

  /** Clear the session without stopping the recogniser (⌘⇧R). */
  clear() {
    this.reset();
    this.emit('cleared');
  }

  /** Feed one chunk of 16 kHz mono Int16 PCM. */
  push(chunk) {
    if (!this.running) return;
    const ms = chunk.length * MS_PER_SAMPLE;
    const level = rms(chunk);

    if (!this.speaking) {
      // Track the room noise floor only while nobody is talking.
      this.floor = Math.min(0.05, Math.max(0.001, this.floor * 0.98 + level * 0.02));
    }
    const threshold = Math.max(0.01, this.floor * 2.2);
    const voiced = level > threshold;

    if (voiced) {
      if (!this.speaking) {
        // Start the utterance with the buffered pre-roll.
        const preRollChunks = Math.round((this.cfg.preRollMs ?? 200) / ms);
        const pre = this.pre.slice(-preRollChunks);
        this.seg = pre.slice();
        this.preMsAdded = pre.length * ms;
        this.segMs = this.preMsAdded;
        this.speaking = true;
        this.segStartAt = Date.now() - this.preMsAdded;
        // A new utterance makes the previous pending text stale.
        this.pendingText = '';
        this.pendingAt = 0;
      }
      this.silenceMs = 0;
      this.seg.push(chunk);
      this.segMs += ms;
    } else if (this.speaking) {
      this.silenceMs += ms;
      this.seg.push(chunk); // keep the trailing pause; it helps whisper finish words
    } else {
      this.pre.push(chunk);
      const keep = Math.round(((this.cfg.preRollMs ?? 200) / ms) || 1) + 2;
      if (this.pre.length > keep) this.pre.shift();
    }

    if (this.speaking) {
      const now = Date.now();
      if (this.silenceMs >= this.cfg.silenceMs) {
        this.finalize();
      } else if (this.segMs >= this.cfg.maxSegmentMs) {
        this.finalize();
      } else if (
        !this.busy &&
        !this.queuedFinal &&
        // Do not start a caption once the utterance is clearly ending: it would
        // sit in front of the final and delay it by its whole decode time.
        this.silenceMs < 120 &&
        now - this.lastPartialAt >= this.cfg.partialEveryMs
      ) {
        this.lastPartialAt = now;
        this.emitPartial();
      }
    }
  }

  emitPartial() {
    const epoch = this._epoch;
    const audio = tail(this.seg, Math.round((this.cfg.partialTailMs / 1000) * SAMPLE_RATE));
    if (audio.length < SAMPLE_RATE * 0.3) return;
    this.transcribe(audio, 'partial').then((text) => {
      // The utterance may have closed while this decode was running.
      if (epoch !== this._epoch || !text || !this.running) return;
      // Ignore a caption that only repeats the previous one.
      if (text === this.partialText) return;
      this.partialText = text;
      this.emit('partial', text);
    });
  }

  finalize() {
    const wasSpeaking = this.speaking;
    const speechMs = this.segMs - this.silenceMs - this.preMsAdded;
    const speechEndAt = Date.now() - Math.max(0, this.silenceMs);
    const speechStartAt = this.segStartAt || speechEndAt - speechMs;
    const utteranceId = this.utteranceId + 1;

    // Keep the caption text available through the decode window. ⌘J is pressed
    // exactly here, and an empty picker used to send it back to the last turn.
    this.pendingText = this.partialText;
    this.pendingAt = Date.now();
    this.utteranceId = utteranceId;

    // Trim most of the trailing pause. Parakeet needs a short tail to finish
    // the last word; decoding 500 ms of silence only costs time.
    let trimMs = Math.max(0, this.silenceMs - 150);
    while (trimMs > 0 && this.seg.length > 1) {
      const last = this.seg[this.seg.length - 1];
      const lastMs = last.length * MS_PER_SAMPLE;
      if (lastMs > trimMs + 60) break; // this chunk still contains speech
      this.seg.pop();
      trimMs -= lastMs;
    }

    const audio = concatInt16(this.seg);
    this._epoch += 1;
    this.seg = [];
    this.segMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.partialText = '';
    this.preMsAdded = 0;
    this.segStartAt = 0;

    if (!wasSpeaking) return;

    // A very short blip is usually a door or a chair, but do not drop a real
    // one-word question: the old 400 ms floor swallowed "Why?" completely.
    if (speechMs < 250) {
      this.emit('dropped', { reason: 'too-short', text: this.pendingText, utteranceId });
      return;
    }

    this.finalizing = true;
    this.enqueueFinal(audio, { utteranceId, speechStartAt, speechEndAt });
  }

  enqueueFinal(audio, meta = {}) {
    // One final at a time; if a job is running, merge instead of dropping audio.
    if (this.busy) {
      this.queuedFinal = this.queuedFinal
        ? { audio: concatInt16([this.queuedFinal.audio, audio]), meta }
        : { audio, meta };
      return;
    }
    this.runFinal(audio, meta);
  }

  runFinal(audio, meta = {}) {
    const startedAt = Date.now();
    this.transcribe(audio, 'final').then((text) => {
      const now = Date.now();
      const decodeMs = now - startedAt;
      // Only a genuine duplicate decode is dropped. The old code compared
      // against every previous final for the whole session, so a repeated
      // question (or one after ⌘⇧R) disappeared.
      const duplicate = text && this.lastFinal.text === text && now - this.lastFinal.at < 1500;
      if (this.running && text && !duplicate) {
        this.lastFinal = { text, at: now };
        this.pendingText = '';
        this.emit('final', text, { ...meta, decodeMs });
      }
      this.finalizing = false;
      this.drain();
    });
  }

  /** A queued final must start even when the job that was holding the lock was a partial. */
  drain() {
    if (this.busy || !this.queuedFinal) return;
    const next = this.queuedFinal;
    this.queuedFinal = null;
    this.finalizing = true;
    this.runFinal(next.audio, next.meta);
  }

  transcribe(int16, kind) {
    const seq = ++this._seq;
    const id = `${kind}-${Date.now()}-${seq}`;
    const wav = path.join(this.tmpDir, `${id}.wav`);
    const outBase = path.join(this.tmpDir, id);

    try {
      writeWav(wav, int16, SAMPLE_RATE);
    } catch (err) {
      this.emit('error', `CloudyVoice could not write audio: ${err.message}`);
      return Promise.resolve('');
    }

    this.busy = true;

    const finish = (text) => {
      this.busy = false;
      fs.rm(wav, { force: true }, () => {});
      this.drain();
      return text;
    };

    // Parakeet keeps the model loaded, so this is one request over stdin.
    if (this.ear) {
      return this.ear
        .transcribe(wav)
        .then((text) => finish(cleanup(text)))
        .catch((err) => {
          if (kind === 'final') this.emit('error', `CloudyEar failed: ${err.message}`);
          return finish('');
        });
    }

    const model = this.modelFor(kind);
    const args = [
      '-m', model,
      '-f', wav,
      '-l', this.cfg.language || 'en',
      '-t', String(this.cfg.threads || 4),
      '-nt',   // no timestamps
      '-np',   // no prints except results
      '-sns',  // suppress non-speech tokens like [music], (applause)
      '-otxt', // write <outBase>.txt
      '-of', outBase,
    ];

    // A domain prompt biases decoding toward the words interviews actually use.
    if (this.cfg.initialPrompt) args.push('--prompt', this.cfg.initialPrompt);

    // Finals get the full beam; live captions stay greedy so they never queue
    // behind a slower decode than the speech itself.
    if (kind === 'final') args.push('-bs', String(this.cfg.beamSize || 5));

    return new Promise((resolve) => {
      let stderr = '';
      let settled = false;
      const child = spawn(this.cfg.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      const done = (text) => {
        if (settled) return; // 'error' and 'close' can both fire
        settled = true;
        fs.rm(`${outBase}.txt`, { force: true }, () => {});
        resolve(finish(text));
      };

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        this.emit('error', `CloudyVoice could not start whisper-cli: ${err.message}`);
        done('');
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const hint = /metal|ggml|model/i.test(stderr) ? stderr.trim().slice(0, 300) : `exit ${code}`;
          if (kind === 'final') this.emit('error', `CloudyVoice failed (${hint})`);
          return done('');
        }
        fs.readFile(`${outBase}.txt`, 'utf8', (err, text) => {
          if (err) return done('');
          done(cleanup(text));
        });
      });
    });
  }
}

module.exports = { CloudyVoice, SAMPLE_RATE };
