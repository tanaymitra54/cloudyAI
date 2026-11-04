'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

/**
 * CloudyAudio — long-lived ScreenCaptureKit helper that captures ONLY system
 * audio (the other side of the call), never the microphone.
 *
 * The helper writes length-prefixed PCM frames on stdout:
 *   [uint32 LE byteLength][Int16 LE samples @ 16 kHz mono]
 *
 * Events: 'audio' (Int16Array), 'error' (message), 'started', 'stopped'
 */
class CloudyAudio extends EventEmitter {
  constructor({ bin } = {}) {
    super();
    this.bin = bin || '';
    this.child = null;
    this.active = false;
    this.stopping = false;
    this.restartTimer = null;
    this.stderrTail = '';
    this.frames = 0;
  }

  check() {
    if (!this.bin || !fs.existsSync(this.bin)) {
      return 'System audio helper not found. Run: npm run build:audio (then restart CloudyAI).';
    }
    return null;
  }

  start() {
    if (this.active) return true;
    const problem = this.check();
    if (problem) {
      this.emit('error', problem);
      return false;
    }

    this.active = true;
    this.stopping = false;
    this.spawnChild();
    return true;
  }

  spawnChild() {
    if (!this.active) return;

    const child = spawn(this.bin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.stderrTail = '';
    this.frames = 0;

    let buffer = Buffer.alloc(0);
    let started = false;

    child.stdout.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length === 0 || length > 1024 * 1024 || length % 2 !== 0) {
          // Desynchronised stream: restart rather than feed garbage to the VAD.
          this.emit('error', 'System audio stream desynchronised — restarting capture.');
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          return;
        }
        if (buffer.length < 4 + length) break;

        const payload = buffer.subarray(4, 4 + length);
        const aligned = new Uint8Array(length);
        aligned.set(payload);
        buffer = buffer.subarray(4 + length);

        if (!started) {
          started = true;
          this.emit('started');
        }
        this.frames += 1;
        this.emit('audio', new Int16Array(aligned.buffer));
      }
    });

    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });

    child.on('error', (err) => {
      this.emit('error', `System audio helper could not start: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopping || !this.active) {
        this.active = false;
        this.emit('stopped');
        return;
      }

      // The helper exits 2 when Screen & System Audio Recording is denied;
      // restarting would just loop on the same failure.
      const fatal = code === 2;
      if (fatal) this.active = false;

      const detail = this.stderrTail.trim().split('\n').slice(-2).join(' ');
      this.emit(
        'error',
        `System audio capture stopped (${signal || code})${detail ? `: ${detail}` : ''}`,
        { fatal }
      );

      if (fatal) return;

      // Transient failures (display change, output device switch) recover by
      // themselves; a permission failure will keep failing and surface again.
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnChild();
      }, 1200);
    });
  }

  stop() {
    this.stopping = true;
    this.active = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { CloudyAudio };
