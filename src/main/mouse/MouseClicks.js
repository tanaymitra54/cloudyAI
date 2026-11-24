'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

/**
 * CloudyMouse — a long-lived child process holding a low-level mouse hook.
 *
 * Why a helper: Electron can read the pointer position but not the mouse
 * button, so "three clicks anywhere" needs a global hook. A hook in this
 * process would be blocked from seeing clicks aimed at an elevated window;
 * that limitation is Windows', not something this class can work around.
 *
 * Protocol (one line each, see native/CloudyMouse/main.cpp):
 *   ready
 *   L 1043 512      L/R/M/X = left/right/middle/extra, then screen coordinates
 *
 * Events: 'ready', 'click' ({ button, x, y }), 'error' (message)
 */
class MouseClicks extends EventEmitter {
  constructor({ bin } = {}) {
    super();
    this.bin = bin || '';
    this.child = null;
    this.active = false;
    this.stopping = false;
    this.restartTimer = null;
    this.stderrTail = '';
  }

  check() {
    if (!this.bin || !fs.existsSync(this.bin)) {
      return 'Mouse helper not found. Run the Windows build (vendor/mouse/CloudyMouse.exe).';
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

    const child = spawn(this.bin, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // No console window may flash: this is a background listener.
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = '';

    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        if (line === 'ready') {
          this.emit('ready');
          continue;
        }
        const [button, x, y] = line.split(/\s+/);
        if (!/^[LRMX]$/.test(button || '')) continue;
        this.emit('click', { button, x: Number(x) || 0, y: Number(y) || 0 });
      }
    });

    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-1000);
    });

    child.on('error', (err) => {
      this.emit('error', `Mouse helper could not start: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopping || !this.active) {
        this.active = false;
        return;
      }
      const detail = this.stderrTail.trim().split('\n').slice(-1)[0];
      this.emit('error', `Mouse helper stopped (${signal || code})${detail ? `: ${detail}` : ''}`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnChild();
      }, 1500);
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
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { MouseClicks };
