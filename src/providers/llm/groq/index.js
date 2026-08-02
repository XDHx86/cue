// Groq LLM provider — Groq-hosted Llama models via the OpenAI-compatible chat completions API.
// Plugin descriptor with rich capabilities, settingsPath, model discovery, and health checks.
// Lazy-requires the 'openai' SDK INSIDE createEngine. R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const { makeOpenAICompatEngine } = require('../openai-compat');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

definePlugin({
  id: 'groq',
  displayName: 'Groq',
  description: 'Groq-hosted Llama models — ultra-fast inference via OpenAI-compatible API.',
  providerType: 'llm',
  order: 4,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'unsupported', source: 'declared' },
  },
  supportedModels: [
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
  ],
  discoverModels: async ({ apiKey, signal }) => {
    if (!apiKey) return null;
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
      const res = await client.models.list({ signal });
      return (res.data || []);
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/groq').normalizeModels(raw, 'groq'),
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
      await client.models.list({ limit: 1 });
      return { state: 'healthy' };
    } catch (e) {
      if (e.status === 429) return { state: 'rate_limited' };
      if (e.status === 401 || e.status === 403) return { state: 'invalid_config', reason: e.message };
      return { state: 'unavailable', reason: e.message };
    }
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'gsk_...', settingsPath: 'apiKeys.groq', group: 'config' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'llama-3.1-8b-instant', settingsPath: 'models.groq.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'llama-3.3-70b-versatile', settingsPath: 'models.groq.smart', group: 'models' },
  ],
  defaultSettings: {
    apiKeys: { groq: '' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'groq',
      settings,
      apiKey: (settings.apiKeys || {}).groq,
      baseURL: GROQ_BASE_URL,
    });
  },
});
