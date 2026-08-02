// Gemini LLM provider — Google AI Studio (@google/genai).
// Plugin descriptor with rich capabilities, settingsPath, model discovery, and health checks.
// Lazy-requires the SDK INSIDE createEngine. R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const { log, stripDataUrl } = require('../shared');
const { normalizeSDKError } = require('../../../errors');

definePlugin({
  id: 'gemini',
  displayName: 'Gemini',
  description: 'Google Gemini models — streaming chat with image input.',
  providerType: 'llm',
  order: 3,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  discoverModels: async ({ apiKey, signal }) => {
    if (!apiKey) return null;
    try {
      const { GoogleGenAI } = require('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const res = await ai.models.list({ signal });
      return (res.models || res || []).filter(m => m.name && m.name.includes('gemini'));
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/gemini').normalizeModels(raw, 'gemini'),
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    return { state: 'healthy' }; // Gemini has no lightweight health endpoint
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AIza...', settingsPath: 'apiKeys.gemini', group: 'config' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'gemini-2.5-flash', settingsPath: 'models.gemini.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'gemini-2.5-pro', settingsPath: 'models.gemini.smart', group: 'models' },
  ],
  defaultSettings: {
    apiKeys: { gemini: '' },
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' } },
  },
  createEngine({ settings }) {
    const id = 'gemini';
    const apiKey = (settings.apiKeys || {})[id];
    const model = ((settings.models || {})[id] || {})[settings.smart ? 'smart' : 'fast'];
    const maxTokens = (settings.llm && settings.llm.maxTokens) || 4096;
    return {
      provider: id,
      model,
      apiKey,
      ready: !!apiKey && !!model,
      async stream({ system, turns, imageDataUrl, onToken }) {
        log().debug({ model, hasImage: !!imageDataUrl, maxTokens }, 'streamGemini called');
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });
        const contents = turns.map((t, i) => {
          const last = i === turns.length - 1;
          const parts = [{ text: t.text }];
          if (last && imageDataUrl && t.role === 'user') {
            const img = stripDataUrl(imageDataUrl);
            if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
          }
          return { role: t.role === 'assistant' ? 'model' : 'user', parts };
        });
        log().debug({ model, contents: contents.length }, 'streamGemini sending request');
        try {
          const stream = await ai.models.generateContentStream({ model, contents, config: { systemInstruction: system } });
          let full = '';
          let lastFinishReason = 'UNKNOWN';
          for await (const chunk of stream) {
            const t = chunk && chunk.text;
            if (t) { full += t; onToken(t); }
            if (chunk && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason) {
              lastFinishReason = chunk.candidates[0].finishReason;
            }
          }
          log().debug({ chars: full.length, finishReason: lastFinishReason }, 'streamGemini finished');
          return full;
        } catch (err) {
          log().warn({ error: err && err.message }, 'streamGemini error');
          throw normalizeSDKError(err, id);
        }
      },
    };
  },
});
