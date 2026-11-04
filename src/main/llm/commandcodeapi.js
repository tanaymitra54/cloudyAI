'use strict';

const compat = require('./openai-compat');

// Command Code's Provider API is OpenAI-compatible for every model except
// Claude, which only answers on the Anthropic /messages endpoint. We stay on
// /chat/completions and list only the models that support it, so the picker
// never offers a model this client cannot call.
const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1';

function complete({ cfg, system, user, images, signal, onDelta, maxTokens }) {
  return compat.complete({
    cfg: {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
      model: cfg.model || 'deepseek/deepseek-v4-flash',
      label: 'Command Code',
      envName: 'COMMANDCODE_API_KEY',
    },
    system,
    user,
    images,
    signal,
    onDelta,
    maxTokens: maxTokens ?? 2000,
  });
}

// Used only when /models cannot be reached (no key yet, offline, non-2xx).
const FALLBACK_MODELS = [
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'xai/grok-4.7', name: 'Grok 4.7' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash' },
  { id: 'moonshotai/Kimi-K3', name: 'Kimi K3' },
];

let modelCache = { at: 0, key: '', models: [] };

/** The API reports which routes serve each model; keep the chat-capable ones. */
function supportsChat(model) {
  const id = String(model.id || model.name || '');
  const endpoints = model.supported_endpoints || model.supportedEndpoints || model.endpoints;
  if (Array.isArray(endpoints) && endpoints.length) {
    return endpoints.some((e) => /chat[^a-z]*completions/i.test(String(e)));
  }
  // Older/partial responses carry no route list: Claude is the only family
  // that cannot answer on /chat/completions, so exclude it by name.
  return !/^claude[-/]/i.test(id);
}

function toOption(model) {
  const id = String(model.id || model.name || '');
  const name = String(model.name || model.display_name || id);
  return { id, name };
}

async function listModels(cfg) {
  cfg = cfg || {};
  if (modelCache.models.length && modelCache.key === (cfg.apiKey || '') && Date.now() - modelCache.at < 10 * 60 * 1000) {
    return modelCache.models;
  }

  const fallback = () => FALLBACK_MODELS.map((m) => ({ ...m }));

  try {
    const base = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // /models is public, so it works before a key is entered too.
    const res = await fetch(`${base}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    });
    if (!res.ok) return fallback();
    const json = await res.json();
    const raw = Array.isArray(json) ? json : json.data || json.models || [];
    const models = raw
      .filter((m) => m && (m.id || m.name) && supportsChat(m))
      .map(toOption)
      .filter((m) => m.id);
    if (!models.length) return fallback();
    models.sort((a, b) => a.id.localeCompare(b.id));
    modelCache = { at: Date.now(), key: cfg.apiKey || '', models };
    return models;
  } catch {
    return fallback();
  }
}

module.exports = { complete, listModels, supportsChat };
