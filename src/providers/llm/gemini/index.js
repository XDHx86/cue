// Gemini LLM provider — Google AI Studio (@google/genai). Streaming uses generateContentStream;
// image input via inlineData { mimeType, data } which needs the mime split (stripDataUrl). The
// role remap (assistant → model) and the config.systemInstruction seam are preserved verbatim
// from the pre-refactor streamGemini.
//
// Note: Gemini's SDK does not take a max_tokens in generateContentStream — maxTokens is computed
// for engine-shape parity and unused in the request, matching the original behavior.

const { defineProvider } = require('../../../registry');
const { log, stripDataUrl } = require('../shared');
const { normalizeSDKError } = require('../../../errors');

defineProvider({
  id: 'gemini',
  displayName: 'Gemini',
  description: 'Google Gemini models — streaming chat with image input.',
  providerType: 'llm',
  order: 3,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AIza...' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'gemini-2.5-flash' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'gemini-2.5-pro' },
  ],
  defaultSettings: {
    apiKeys: { gemini: '' },
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' } },
  },
  createEngine({ settings }) {
    const id = 'gemini';
    const apiKey = (settings.apiKeys || {})[id];
    const model = ((settings.models || {})[id] || {})[settings.smart ? 'smart' : 'fast'];
    const maxTokens = 4096;
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
