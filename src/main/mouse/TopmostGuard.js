'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');

/**
 * TopmostGuard — keeps our own window in front from a separate process.
 *
 * Electron can call setAlwaysOnTop(), but against a fullscreen browser in kiosk
 * mode that call is not reliable: the WS_EX_TOPMOST flag can be cleared by the
 * shell, and the call can be skipped when Electron believes the window is
 * already topmost. This helper asks the window manager directly and reacts to
 * every foreground change, which is the moment a kiosk app brings itself to the
 * front.
 *
 * It never touches another process: the target is our own window handle, and
 * the only call is SetWindowPos on it.
 *
 * Protocol (native/CloudyMouse/main.cpp):
 *   ready
 *
 * Events: 'ready', 'error' (message)
 */
class TopmostGuard extends EventEmitter {
  constructor({ bin, intervalMs = 50 } = {}) {
    super();
    this.bin = bin || '';
    this.intervalMs = Math.max(20, Number(intervalMs) || 50);
    this.child = null;
    this.active = false;
    this.stopping = false;
    this.stderrTail = '';
  }

  check() {
    if (!this.bin || !fs.existsSync(this.bin)) {
      return 'Topmost helper not found (vendor/mouse/CloudyMouse.exe).';
    }
    return null;
  }

  start(windowHandle) {
    const problem = this.check();
    if (problem) {
      this.emit('error', problem);
      return false;
    }
    if (!windowHandle) {
      this.emit('error', 'No window handle for the topmost guard.');
      return false;
    }

    this.active = true;
    this.stopping = false;
    this.child = spawn(this.bin, ['--topmost', windowHandle, '--interval', String(this.intervalMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) this.emit('ready');
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-500);
    });
    this.child.on('error', (err) => {
      this.emit('error', `Topmost helper could not start: ${err.message}`);
    });
    this.child.on('close', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.active = false;
        return;
      }
      const detail = this.stderrTail.trim().split('\n').slice(-1)[0];
      this.emit('error', `Topmost helper stopped (${signal || code})${detail ? `: ${detail}` : ''}`);
      this.active = false;
    });

    return true;
  }

  stop() {
    this.stopping = true;
    this.active = false;
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

module.exports = { TopmostGuard };
