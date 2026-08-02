// Anthropic LLM provider — Claude models via the @anthropic-ai/sdk.
// Plugin descriptor with rich capabilities, settingsPath, model discovery, and health checks.
// Lazy-requires the SDK INSIDE createEngine. R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const { log, stripDataUrl } = require('../shared');
const { normalizeSDKError } = require('../../../errors');

definePlugin({
  id: 'anthropic',
  displayName: 'Anthropic',
  description: 'Claude models — streaming chat with image input.',
  providerType: 'llm',
  order: 2,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
  ],
  discoverModels: async ({ apiKey, signal }) => {
    if (!apiKey) return null;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const res = await client.models.list({ signal });
      return (res.data || []);
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/anthropic').normalizeModels(raw, 'anthropic'),
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
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
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-ant-...', settingsPath: 'apiKeys.anthropic', group: 'config' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'claude-3-5-haiku-latest', settingsPath: 'models.anthropic.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'claude-3-5-sonnet-latest', settingsPath: 'models.anthropic.smart', group: 'models' },
  ],
  defaultSettings: {
    apiKeys: { anthropic: '' },
    models: { anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' } },
  },
  createEngine({ settings }) {
    const id = 'anthropic';
    const apiKey = (settings.apiKeys || {})[id];
    const model = ((settings.models || {})[id] || {})[settings.smart ? 'smart' : 'fast'];
    const maxTokens = (settings.llm && settings.llm.maxTokens) || 4096;
    return {
      provider: id,
      model,
      apiKey,
      ready: !!apiKey && !!model,
      async stream({ system, turns, imageDataUrl, onToken }) {
        log().debug({ model, hasImage: !!imageDataUrl, maxTokens }, 'streamAnthropic called');
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        const messages = turns.map((t, i) => {
          const last = i === turns.length - 1;
          if (last && imageDataUrl && t.role === 'user') {
            const img = stripDataUrl(imageDataUrl);
            const content = [];
            if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
            content.push({ type: 'text', text: t.text });
            return { role: 'user', content };
          }
          return { role: t.role, content: t.text };
        });
        log().debug({ model, messages: messages.length }, 'streamAnthropic sending request');
        try {
          const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
          let full = '';
          for await (const ev of stream) {
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
              full += ev.delta.text;
              onToken(ev.delta.text);
            }
          }
          log().debug({ chars: full.length }, 'streamAnthropic finished');
          return full;
        } catch (err) {
          log().warn({ error: err && err.message }, 'streamAnthropic error');
          throw normalizeSDKError(err, id);
        }
      },
    };
  },
});
