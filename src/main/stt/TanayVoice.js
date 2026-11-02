'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeWav, concatInt16, tail } = require('./wav');

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
 * TanayVoice — on-device streaming transcription.
 *
 * Audio arrives as 16 kHz Int16 chunks. An adaptive energy VAD segments speech
 * into utterances; each utterance is transcribed with whisper.cpp on Metal.
 * While someone is still talking, the tail of the utterance is transcribed
 * periodically so the overlay can show a live caption.
 *
 * Events: 'partial' (text, isFinal:false), 'final' (text), 'status', 'error'
 */
class TanayVoice extends EventEmitter {
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
    this.tmpDir = path.join(os.tmpdir(), 'tanayvoice');
    this.lastFinal = '';
    this.partialText = '';
    this._seq = 0;
    // Pre-roll: keep the last few chunks of "silence" so the first syllable of a
    // question is not clipped when the VAD fires late.
    this.pre = [];
    this.preMsAdded = 0;
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
    if (!fs.existsSync(this.cfg.bin)) {
      return `whisper.cpp CLI not found at "${this.cfg.bin}". Run: brew install whisper-cpp`;
    }
    if (!fs.existsSync(this.modelPath)) {
      return `TanayVoice model missing: ${this.modelPath}\nRun: npm run get-model (or download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp)`;
    }
    if (this.cfg.partialModelPath && !fs.existsSync(this.cfg.partialModelPath)) {
      return `TanayVoice caption model missing: ${this.cfg.partialModelPath}`;
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
    this.emit('status', 'listening');
    return true;
  }

  stop() {
    this.running = false;
    this.reset();
    this.emit('status', 'idle');
  }

  reset() {
    this.seg = [];
    this.segMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.partialText = '';
    this.queuedFinal = null;
    this.pre = [];
    this.preMsAdded = 0;
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
        const preRollChunks = Math.round((this.cfg.preRollMs ?? 300) / ms);
        const pre = this.pre.slice(-preRollChunks);
        this.seg = pre.slice();
        this.preMsAdded = pre.length * ms;
        this.segMs = this.preMsAdded;
        this.speaking = true;
      }
      this.silenceMs = 0;
      this.seg.push(chunk);
      this.segMs += ms;
    } else if (this.speaking) {
      this.silenceMs += ms;
      this.seg.push(chunk); // keep the trailing pause; it helps whisper finish words
    } else {
      this.pre.push(chunk);
      const keep = Math.round(((this.cfg.preRollMs ?? 300) / ms) || 1) + 2;
      if (this.pre.length > keep) this.pre.shift();
    }

    if (this.speaking) {
      const now = Date.now();
      if (this.silenceMs >= this.cfg.silenceMs) {
        this.finalize();
      } else if (this.segMs >= this.cfg.maxSegmentMs) {
        this.finalize();
      } else if (!this.busy && !this.queuedFinal && now - this.lastPartialAt >= this.cfg.partialEveryMs) {
        this.lastPartialAt = now;
        this.emitPartial();
      }
    }
  }

  emitPartial() {
    const audio = tail(this.seg, Math.round((this.cfg.partialTailMs / 1000) * SAMPLE_RATE));
    if (audio.length < SAMPLE_RATE * 0.4) return;
    this.transcribe(audio, 'partial').then((text) => {
      if (!text || !this.running) return;
      // Ignore a caption that only repeats the previous one.
      if (text === this.partialText) return;
      this.partialText = text;
      this.emit('partial', text);
    });
  }

  finalize() {
    const audio = concatInt16(this.seg);
    const speechMs = this.segMs - this.silenceMs - this.preMsAdded;
    const wasSpeaking = this.speaking;

    this.seg = [];
    this.segMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
    this.partialText = '';
    this.preMsAdded = 0;

    if (!wasSpeaking || speechMs < this.cfg.minSpeechMs) return;
    this.enqueueFinal(audio);
  }

  enqueueFinal(audio) {
    // One final at a time; if a job is running, merge instead of dropping audio.
    if (this.busy) {
      this.queuedFinal = this.queuedFinal ? concatInt16([this.queuedFinal, audio]) : audio;
      return;
    }
    this.runFinal(audio);
  }

  runFinal(audio) {
    this.transcribe(audio, 'final').then((text) => {
      if (this.running && text && text !== this.lastFinal) {
        this.lastFinal = text;
        this.emit('final', text);
      }
      this.drain();
    });
  }

  /** A queued final must start even when the job that was holding the lock was a partial. */
  drain() {
    if (this.busy || !this.queuedFinal) return;
    const next = this.queuedFinal;
    this.queuedFinal = null;
    this.runFinal(next);
  }

  transcribe(int16, kind) {
    const seq = ++this._seq;
    const id = `${kind}-${Date.now()}-${seq}`;
    const wav = path.join(this.tmpDir, `${id}.wav`);
    const outBase = path.join(this.tmpDir, id);

    try {
      writeWav(wav, int16, SAMPLE_RATE);
    } catch (err) {
      this.emit('error', `TanayVoice could not write audio: ${err.message}`);
      return Promise.resolve('');
    }

    this.busy = true;
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
        this.busy = false;
        fs.rm(wav, { force: true }, () => {});
        fs.rm(`${outBase}.txt`, { force: true }, () => {});
        this.drain();
        resolve(text);
      };

      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        this.emit('error', `TanayVoice could not start whisper-cli: ${err.message}`);
        done('');
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const hint = /metal|ggml|model/i.test(stderr) ? stderr.trim().slice(0, 300) : `exit ${code}`;
          if (kind === 'final') this.emit('error', `TanayVoice failed (${hint})`);
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

module.exports = { TanayVoice, SAMPLE_RATE };
