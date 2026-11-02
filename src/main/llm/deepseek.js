'use strict';

const compat = require('./openai-compat');

// DeepSeek's platform API. Kept as its own module so the config shape and the
// error text stay provider-specific.
function complete({ cfg, system, user, signal, onDelta, maxTokens }) {
  return compat.complete({
    cfg: {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl || 'https://api.deepseek.com',
      model: cfg.model || 'deepseek-chat',
      label: 'DeepSeek',
      envName: 'DEEPSEEK_API_KEY',
    },
    system,
    user,
    signal,
    onDelta,
    maxTokens: maxTokens ?? 2000,
  });
}

module.exports = { complete };
