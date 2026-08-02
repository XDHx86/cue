// Nvidia LLM provider — Nvidia's integrate API is OpenAI-compatible.
// Plugin descriptor with rich capabilities, settingsPath, model discovery, and health checks.
// Lazy-requires the 'openai' SDK INSIDE createEngine. R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const { makeOpenAICompatEngine } = require('../openai-compat');

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

definePlugin({
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  description: 'Nvidia-hosted models via the integrate API (OpenAI-compatible).',
  providerType: 'llm',
  order: 5,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision' },
    { id: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision' },
  ],
  discoverModels: async ({ apiKey, signal }) => {
    if (!apiKey) return null;
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL });
      const res = await client.models.list({ signal });
      return (res.data || []);
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/nvidia').normalizeModels(raw, 'nvidia'),
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL });
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
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'nvapi-...', settingsPath: 'apiKeys.nvidia', group: 'config' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'meta/llama-3.2-11b-vision-instruct', settingsPath: 'models.nvidia.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'meta/llama-3.2-90b-vision-instruct', settingsPath: 'models.nvidia.smart', group: 'models' },
  ],
  defaultSettings: {
    apiKeys: { nvidia: '' },
    models: { nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'nvidia',
      settings,
      apiKey: (settings.apiKeys || {}).nvidia,
      baseURL: NVIDIA_BASE_URL,
    });
  },
});
