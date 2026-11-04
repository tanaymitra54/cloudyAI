'use strict';

const { globalShortcut } = require('electron');

// Human-friendly accelerator aliases, so the config can say "cmd+j" or "⌘J"
// and still register the canonical Electron form.
const MODIFIERS = {
  cmd: 'CommandOrControl',
  command: 'CommandOrControl',
  meta: 'CommandOrControl',
  super: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  mod: 'CommandOrControl',
  ctrl: 'Control',
  control: 'Control',
  opt: 'Alt',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
};

const NAMED = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  plus: 'Plus',
};

const SYMBOLS = { '⌘': 'cmd+', '⇧': 'shift+', '⌥': 'opt+', '⌃': 'ctrl+', '↵': 'enter' };

function normalizeAccelerator(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim();
  for (const [sym, repl] of Object.entries(SYMBOLS)) s = s.split(sym).join(repl);

  const parts = s
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (MODIFIERS[lower]) return MODIFIERS[lower];
      if (NAMED[lower]) return NAMED[lower];
      if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
      if (part.length === 1) return part.toUpperCase();
      // Already canonical (e.g. "PageUp", "Num0").
      return part[0].toUpperCase() + part.slice(1);
    });

  return parts.join('+');
}

// What is actually registered right now, action -> accelerator. Re-registering
// everything on each save briefly leaves ⌘J unbound, and another app can grab
// it in that gap. Only changed bindings are touched.
let current = new Map();

/**
 * Register every binding in `bindings`.
 * @param {Record<string,string>} bindings action -> accelerator
 * @param {Record<string,Function>} handlers action -> callback
 * @returns {{registered: Array, failures: Array}}
 */
function apply(bindings, handlers) {
  const desired = new Map();
  const failures = [];
  const seen = new Map();

  for (const [action, raw] of Object.entries(bindings || {})) {
    const handler = handlers[action];
    if (!handler) continue; // binding for a feature this build does not have

    const accelerator = normalizeAccelerator(raw);
    if (!accelerator) {
      failures.push({ action, accelerator: '', reason: 'empty accelerator' });
      continue;
    }

    if (seen.has(accelerator)) {
      failures.push({ action, accelerator, reason: `duplicate of "${seen.get(accelerator)}"` });
      continue;
    }

    seen.set(accelerator, action);
    desired.set(action, accelerator);
  }

  // Drop only bindings that disappeared or changed.
  for (const [action, accelerator] of current) {
    if (desired.get(action) !== accelerator) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* already gone */
      }
    }
  }

  const registered = [];
  const active = new Map();

  for (const [action, accelerator] of desired) {
    if (current.get(action) === accelerator && globalShortcut.isRegistered(accelerator)) {
      active.set(action, accelerator);
      registered.push({ action, accelerator });
      continue;
    }

    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, handlers[action]);
    } catch (err) {
      failures.push({ action, accelerator, reason: err.message });
      continue;
    }

    if (ok) {
      active.set(action, accelerator);
      registered.push({ action, accelerator });
    } else {
      // Another app already owns this combination.
      failures.push({ action, accelerator, reason: 'already taken by another app' });
    }
  }

  current = active;
  return { registered, failures };
}

module.exports = { apply, normalizeAccelerator };
