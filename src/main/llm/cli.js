'use strict';

const { spawn } = require('child_process');

// Backends that shell out to a CLI agent. They are slower than a direct API call
// (a fresh process per answer), so they are opt-in rather than the default.

function runOnce({ bin, args, timeoutMs, signal, onDelta }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new Error(`Could not start "${bin}": ${err.message}`));
    }

    let out = '';
    let err = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      onDelta?.(s);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      finish(reject, new Error(`"${bin}" is not available: ${e.message}`));
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) return finish(resolve, { text: out.trim() });
      finish(reject, new Error(`${bin} exited ${code}: ${(err || out).trim().slice(0, 400)}`));
    });
  });
}

// `opencode run --format json` emits one JSON object per line; collect the text parts.
function parseOpencodeJson(raw) {
  const texts = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) {
      if (t) texts.push(t);
      continue;
    }
    try {
      const ev = JSON.parse(t);
      const part = ev.part || ev;
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    } catch {
      /* ignore non-JSON noise */
    }
  }
  return texts.join('').trim() || raw.trim();
}

async function complete({ provider, cfg, system, user, signal, onDelta }) {
  const prompt = `${system}\n\n---\n\n${user}`;

  if (provider === 'opencode') {
    const args = ['run', '--format', 'json'];
    if (cfg.model) args.push('--model', cfg.model);
    args.push(prompt);
    const { text } = await runOnce({
      bin: cfg.bin || 'opencode',
      args,
      timeoutMs: cfg.timeoutMs || 90000,
      signal,
      onDelta: () => {}, // JSON-lines: stream only after parsing
    });
    const clean = parseOpencodeJson(text);
    onDelta?.(clean);
    return { text: clean };
  }

  if (provider === 'commandcode') {
    const args = (cfg.args || ['-p', '{prompt}']).map((a) => (a === '{prompt}' ? prompt : a));
    const { text } = await runOnce({
      bin: cfg.bin || 'commandcode',
      args,
      timeoutMs: cfg.timeoutMs || 90000,
      signal,
      onDelta,
    });
    return { text };
  }

  throw new Error(`Unknown CLI provider: ${provider}`);
}

module.exports = { complete, parseOpencodeJson };
