'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

/**
 * CloudyEar — long-lived child process running NVIDIA Parakeet TDT 0.6B v2
 * on the Neural Engine (FluidAudio / CoreML).
 *
 * The model loads once, then each utterance is decoded in well under a second.
 * One JSON line in, one JSON line out; see native/CloudyEar/Sources/CloudyEar.
 *
 * Events: 'loading', 'progress' (percent), 'ready', 'error' (message)
 */
class CloudyEar extends EventEmitter {
  constructor({ bin, modelsDir } = {}) {
    super();
    this.bin = bin || '';
    this.modelsDir = modelsDir || '';
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = '';
    // The first launch downloads ~600 MB, so the ceiling is generous.
    this.startTimeoutMs = 15 * 60 * 1000;
    this.transcribeTimeoutMs = 30000;
  }

  check() {
    if (!this.bin || !fs.existsSync(this.bin)) {
      return 'Parakeet helper not found. Run: npm run build:ear (then restart CloudyAI).';
    }
    return null;
  }

  /** Spawn the helper and resolve once the model is in memory. */
  start() {
    if (this.ready && this.child) return Promise.resolve();
    if (this.starting) return this.starting;

    const problem = this.check();
    if (problem) return Promise.reject(new Error(problem));

    this.starting = new Promise((resolve, reject) => {
      const args = [];
      if (this.modelsDir) args.push('--models-dir', this.modelsDir);

      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;

      let settled = false;
      let buffer = '';
      let timer = setTimeout(() => fail(new Error('Parakeet model did not load in 15 minutes')), this.startTimeoutMs);

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = null;
        this.ready = false;
        reject(error);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.starting = null;
        this.ready = true;
        resolve();
      };

      child.on('error', (err) => {
        this.emit('error', `Parakeet helper could not start: ${err.message}`);
        fail(err);
      });

      // A write after the child exited must not crash the app.
      child.stdin.on('error', () => {});

      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-3000);
      });

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith('{')) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          this.onMessage(message, { succeed, fail });
        }
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        this.ready = false;
        this.starting = null;

        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Parakeet helper stopped'));
        }
        this.pending.clear();

        const reason = `${signal || code}${this.stderrTail ? `: ${this.stderrTail.slice(-400)}` : ''}`;
        if (!settled) fail(new Error(`Parakeet helper exited (${reason})`));
        else this.emit('error', `Parakeet helper exited (${reason})`);
      });
    });

    return this.starting;
  }

  onMessage(message, { succeed, fail }) {
    if (message.event === 'loading') {
      this.emit('loading');
      return;
    }
    if (message.event === 'progress') {
      this.emit('progress', Number(message.percent) || 0);
      return;
    }
    if (message.event === 'ready') {
      this.emit('ready');
      succeed();
      return;
    }
    if (message.event === 'error') {
      const text = message.error || 'Parakeet model failed to load';
      this.emit('error', text);
      fail(new Error(text));
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(String(message.text || ''));
  }

  async transcribe(wavPath) {
    await this.start();
    if (!this.child) throw new Error('Parakeet helper is not running');

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Parakeet timed out'));
      }, this.transcribeTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, path: wavPath })}\n`);
    });
  }

  /** Load in the background so the first real question is not the first load. */
  warm() {
    this.start().catch(() => {});
  }

  shutdown() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.child = null;
    this.ready = false;
  }
}

module.exports = { CloudyEar };
