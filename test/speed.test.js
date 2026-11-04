'use strict';

// Ranks opencode-go models by time to first token, using the app's real prompt
// shape, and flags models that return no visible text (reasoning models can
// spend the whole budget thinking).
//
//   OC_KEY=... node test/speed.test.js [runs]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNS = Number(process.argv[2] || 3);
const BASE = 'https://opencode.ai/zen/go/v1';

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const MODELS = [
  'gpt-5.6-luna',
  'gpt-6-luna',
  'claude-haiku-5-5',
  'deepseek-v4.1-flash',
  'gemini-4-argon',
  'grok-4.7',
  'step-5-preview',
  'minimax-m3.1-flash',
  'glm-5.3-flash',
  'qwen3.8-flash',
];

const SYSTEM = `You are a live interview assistant. Start with one bold line: **Q: <paraphrase>**. Then answer in bullets. Under 120 words.`;
const USER = 'Question asked: What is the difference between a process and a thread, and when would you use a message queue?';

async function once(model) {
  const t0 = Date.now();
  let first = 0;
  let text = '';
  let finish = null;

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      'Content-Type': 'application/json',
      'x-opencode-session': crypto.randomUUID(),
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
    }),
  });

  if (!res.ok) return { error: res.status };

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
          if (!first) first = Date.now() - t0;
          text += d;
        }
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      } catch {
        /* ignore */
      }
    }
  }

  return { first, total: Date.now() - t0, chars: text.length, finish };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

(async () => {
  const rows = [];

  for (const model of MODELS) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await once(model));

    const ok = runs.filter((r) => !r.error && r.chars > 0);
    rows.push({
      model,
      medianTTFT: ok.length ? median(ok.map((r) => r.first)) : null,
      medianTotal: ok.length ? median(ok.map((r) => r.total)) : null,
      empty: runs.filter((r) => !r.error && r.chars === 0).length,
      errors: runs.filter((r) => r.error).length,
      runs: runs.length,
      chars: ok.length ? Math.round(ok.reduce((a, r) => a + r.chars, 0) / ok.length) : 0,
    });
  }

  rows.sort((a, b) => (a.medianTTFT ?? 1e9) - (b.medianTTFT ?? 1e9));

  console.log(`\n${'model'.padEnd(24)} ttft   total  chars  empty/err  (${RUNS} runs)`);
  for (const r of rows) {
    const ttft = r.medianTTFT === null ? '  n/a' : `${String(r.medianTTFT).padStart(5)}`;
    const total = r.medianTotal === null ? '  n/a' : `${String(r.medianTotal).padStart(5)}`;
    console.log(
      `${r.model.padEnd(24)} ${ttft}  ${total}  ${String(r.chars).padStart(5)}   ${r.empty}/${r.errors}`
    );
  }
})();
