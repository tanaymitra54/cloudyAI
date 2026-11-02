'use strict';

const crypto = require('crypto');
const compat = require('./openai-compat');

// OpenCode's "Go" plan exposes an OpenAI-compatible endpoint. It routes on a
// session header, so one stable id per process keeps requests coherent and
// lets the upstream reuse connection state across answers.
const SESSION_ID = crypto.randomUUID();

function complete({ cfg, system, user, signal, onDelta, maxTokens }) {
  return compat.complete({
    cfg: {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl || 'https://opencode.ai/zen/go/v1',
      model: cfg.model || 'gpt-5.6-luna',
      label: 'OpenCode Go',
      envName: 'OPENCODE_API_KEY',
      headers: { 'x-opencode-session': SESSION_ID },
    },
    system,
    user,
    signal,
    onDelta,
    maxTokens: maxTokens ?? 2000,
  });
}

// Used by the settings dropdown. The endpoint reports capabilities, so models
// that reason internally (and can therefore return an empty answer) can be
// labelled instead of silently disappointing the user.
const FALLBACK_MODELS = [
  'beam-free', 'claude-haiku-5-5', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
  'gemini-4-argon', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'gpt-5.6-luna',
  'gpt-6-luna', 'grok-4.7', 'hy3', 'hy4-preview', 'iceman-contributor-free',
  'kimi-k2.7-code', 'kimi-k3', 'kimi-k3.1-pro', 'longcat-2.0', 'mimo-v2.6-flash',
  'mimo-v2.6-pro', 'minimax-m3', 'minimax-m3.1-flash', 'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max',
  'step-5-preview',
];

let modelCache = { at: 0, models: [] };

async function listModels(cfg) {
  if (modelCache.models.length && Date.now() - modelCache.at < 10 * 60 * 1000) {
    return modelCache.models;
  }

  const fallback = () => FALLBACK_MODELS.map((id) => ({ id, name: id, reasoning: false }));

  if (!cfg?.apiKey) return fallback();

  try {
    const base = (cfg.baseUrl || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'x-opencode-session': SESSION_ID },
    });
    if (!res.ok) return fallback();
    const json = await res.json();
    const models = (json.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: Boolean(m.capabilities?.reasoning?.supported),
    }));
    if (!models.length) return fallback();
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return fallback();
  }
}

module.exports = { complete, listModels, SESSION_ID };
