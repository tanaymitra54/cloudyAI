'use strict';

// OpenAI-compatible chat-completions client with SSE streaming.
// Shared by DeepSeek and the OpenCode Go plan endpoint, which differ only in
// base URL, model names, and a couple of required headers.

// If the provider goes quiet for this long mid-answer, stop waiting: a frozen
// half-answer is worse than a stated failure.
const IDLE_TIMEOUT_MS = 20000;

function endpoint(cfg) {
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

/** One request. Returns { text, finish } where finish is the provider's reason. */
async function once({ cfg, messages, signal, onDelta, maxTokens }) {
  if (!cfg.apiKey) {
    throw new Error(`No API key for ${cfg.label || 'this provider'}. Set ${cfg.envName || 'the key'} in .env.`);
  }

  const internal = new AbortController();
  const combined = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;

  let idleFired = false;
  let idleTimer = setTimeout(() => {
    idleFired = true;
    internal.abort();
  }, IDLE_TIMEOUT_MS);
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      internal.abort();
    }, IDLE_TIMEOUT_MS);
  };

  let text = '';
  let finish = null;

  try {
    const res = await fetch(endpoint(cfg), {
      method: 'POST',
      signal: combined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(cfg.headers || {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`${cfg.label || 'API'} ${res.status}: ${body.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of res.body) {
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }
          if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason;
        } catch {
          // keep-alive or partial frame
        }
      }
    }
  } catch (err) {
    if (idleFired && !signal?.aborted) {
      return { text, finish: 'stalled' };
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }

  return { text, finish };
}

/**
 * @param {object} args
 * @param {{apiKey:string, baseUrl:string, model:string, headers?:object}} args.cfg
 * @param {number} [args.maxTokens]
 * @param {number} [args.maxContinuations] how many times to resume a truncated answer
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function complete({ cfg, system, user, signal, onDelta, maxTokens = 2000, maxContinuations = 2 }) {
  let messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let full = '';
  let truncated = false;

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    const result = await once({ cfg, messages, signal, onDelta, maxTokens });

    if (result.finish === 'stalled') {
      // Keep what arrived, then say why it stopped instead of freezing.
      const note = '\n\n_(response stalled — press the hotkey again)_';
      onDelta?.(note);
      return { text: full + result.text + note, truncated: true };
    }

    full += result.text;

    if (result.finish !== 'length') {
      truncated = false;
      break;
    }

    // Hit the token cap mid-sentence: resume from exactly where it stopped
    // rather than showing the user half an answer.
    truncated = true;
    if (attempt === maxContinuations) break;

    messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: full },
      { role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything already written.' },
    ];
  }

  return { text: full, truncated };
}

module.exports = { complete };
