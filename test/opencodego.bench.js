'use strict';

// Benchmarks every opencode-go model for time-to-first-token and completeness.
//
//   OC_KEY=... node test/opencodego.bench.js            # all opencode-go models
//   OC_KEY=... node test/opencodego.bench.js --list     # print the model list
//   OC_KEY=... node test/opencodego.bench.js a b c      # named models
//
// Ranking only counts models that returned real content. A model that streams
// nothing cannot answer a live question no matter how fast it fails.

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KEY = process.env.OC_KEY;
const BASE = 'https://opencode.ai/zen/go/v1';
const session = crypto.randomUUID();
const TIMEOUT_MS = 25000;
// Reasoning models can spend the whole budget on hidden reasoning and return no
// visible content. Re-run those with a larger budget before calling them broken.
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 160);

function allModels() {
  const out = execFileSync('opencode', ['models'], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('opencode-go/'))
    .map((l) => l.slice('opencode-go/'.length));
}

async function bench(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  let ttft = 0;
  let text = '';
  let finish = '';

  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'x-opencode-session': session,
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: 'Answer in exactly two short bullets. No preamble.' },
          { role: 'user', content: 'What is a hash map?' },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      clearTimeout(timer);
      return { model, error: `${res.status} ${body.replace(/\s+/g, ' ').slice(0, 90)}`, ms: Date.now() - t0 };
    }

    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (p === '[DONE]') continue;
        try {
          const j = JSON.parse(p);
          const d = j.choices?.[0]?.delta?.content;
          if (d) {
            if (!ttft) ttft = Date.now() - t0;
            text += d;
          }
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        } catch {
          /* ignore */
        }
      }
    }
    clearTimeout(timer);
    return { model, ttft, total: Date.now() - t0, chars: text.length, finish, text };
  } catch (err) {
    clearTimeout(timer);
    return {
      model,
      error: err.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : err.message.slice(0, 90),
      ms: Date.now() - t0,
    };
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    console.log(allModels().join('\n'));
    return;
  }
  const models = args.length ? args : allModels();
  const results = [];

  for (const m of models) {
    const r = await bench(m);
    results.push(r);
    if (r.error) {
      console.log(`  FAIL ${m.padEnd(30)} ${String(r.ms).padStart(5)}ms  ${r.error}`);
    } else {
      console.log(
        `  ok   ${m.padEnd(30)} ttft ${String(r.ttft).padStart(5)}ms  total ${String(r.total).padStart(5)}ms  ${String(r.chars).padStart(3)}ch  ${r.finish}`
      );
    }
  }

  const usable = results
    .filter((r) => !r.error && r.chars > 0 && r.ttft > 0)
    .sort((a, b) => a.ttft - b.ttft || a.total - b.total);

  console.log('\n=== fastest usable (by time to first token) ===');
  for (const r of usable.slice(0, 10)) {
    console.log(`${String(r.ttft).padStart(5)}ms ttft  ${String(r.total).padStart(5)}ms total  ${r.model}`);
  }
  const dead = results.filter((r) => r.error || r.chars === 0);
  if (dead.length) {
    console.log(`\n=== unusable (${dead.length}) ===`);
    for (const r of dead) console.log(`${r.model} — ${r.error || 'empty stream'}`);
  }
})();
