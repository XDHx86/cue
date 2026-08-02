// OpenAI LLM provider — GPT-4o family, chat completions + streaming, vision via image_url.
// Plugin descriptor: self-describes capabilities, model discovery, health checks, and
// configuration. Lazy-requires the 'openai' SDK INSIDE createEngine so loading the
// plugin at registry discovery time pulls no network SDK.
//
// R3 migration: defineProvider → definePlugin with rich capabilities, settingsPath,
// discoverModels(), and healthCheck().

const { definePlugin } = require('../../core');
const { makeOpenAICompatEngine } = require('../openai-compat');

definePlugin({
  id: 'openai',
  displayName: 'OpenAI',
  description: 'GPT-4o family — chat completions, streaming, and image input.',
  providerType: 'llm',
  order: 1,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  discoverModels: async ({ apiKey, signal }) => {
    if (!apiKey) return null;
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey });
      const res = await client.models.list({ limit: 100, signal });
      return (res.data || []).filter(m => m.id && m.id.startsWith('gpt'));
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/openai').normalizeModels(raw, 'openai'),
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey });
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
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...', settingsPath: 'apiKeys.openai', group: 'config' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'gpt-4o-mini', settingsPath: 'models.openai.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'gpt-4o', settingsPath: 'models.openai.smart', group: 'models' },
  ],
  defaultSettings: {
    apiKeys: { openai: '' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'openai',
      settings,
      apiKey: (settings.apiKeys || {}).openai,
      baseURL: undefined,
    });
  },
});
