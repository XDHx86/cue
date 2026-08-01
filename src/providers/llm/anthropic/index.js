// Anthropic LLM provider — Claude models via the @anthropic-ai/sdk. Streaming uses Anthropic's
// messages.create stream:true event loop; image input via { type:'image', source:{base64} } which
// needs the mime split (stripDataUrl). max_tokens is REQUIRED by the Anthropic API and pinned to
// 4096 — the pre-refactor streamAnthropic pins the same value; keep it or the SDK 400s.
//
// createEngine is a verbatim port of streamAnthropic (pre-refactor src/llm.js), preserved exactly
// (message construction, event filter, normalizeSDKError rethrow with provider:'anthropic').

const { defineProvider } = require('../../../registry');
const { log, stripDataUrl } = require('../shared');
const { normalizeSDKError } = require('../../../errors');

defineProvider({
  id: 'anthropic',
  displayName: 'Anthropic',
  description: 'Claude models — streaming chat with image input.',
  providerType: 'llm',
  order: 2,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-ant-...' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'claude-3-5-haiku-latest' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'claude-3-5-sonnet-latest' },
  ],
  defaultSettings: {
    apiKeys: { anthropic: '' },
    models: { anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' } },
  },
  createEngine({ settings }) {
    const id = 'anthropic';
    const apiKey = (settings.apiKeys || {})[id];
    const model = ((settings.models || {})[id] || {})[settings.smart ? 'smart' : 'fast'];
    // Anthropic requires max_tokens; configurable via settings.llm.maxTokens.
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
