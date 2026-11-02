'use strict';

// Diagnoses why answers end mid-sentence: token cap, reasoning burn, or a
// stream that closes early. Prints finish_reason, usage and the visible tail.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const MAX = Number(process.argv[2] || 700);
const QUESTION = process.argv[3] || 'Design a rate limiter for a public API. Walk me through the components and tradeoffs.';

const system = `You are a live assistant. Formatting contract:
- Start with one bold line: **Q: <paraphrase, max 20 words>**
- Then the answer as bullets.
- Keep it under 180 words unless code is required.`;

(async () => {
  const t0 = Date.now();
  let first = 0;
  let text = '';
  let reasoning = '';
  let finish = null;
  let usage = null;

  const res = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      'Content-Type': 'application/json',
      'x-opencode-session': crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      max_tokens: MAX,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Question asked: ${QUESTION}` },
      ],
    }),
  });

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
        const d = j.choices?.[0]?.delta || {};
        if (d.content) {
          if (!first) first = Date.now() - t0;
          text += d.content;
        }
        if (d.reasoning_content) reasoning += d.reasoning_content;
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        if (j.usage) usage = j.usage;
      } catch {
        /* ignore */
      }
    }
  }

  console.log(JSON.stringify({ maxTokens: MAX, firstTokenMs: first, totalMs: Date.now() - t0, finish, usage }, null, 1));
  console.log('--- visible chars:', text.length, '| reasoning chars:', reasoning.length);
  console.log('--- TAIL:', JSON.stringify(text.slice(-160)));
})();
