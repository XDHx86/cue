// Gemini STT provider — batch transcription via generateContent.
// Plugin descriptor with rich capabilities, settingsPath. R3 migration: definePlugin.
// Lazy-requires the '@google/genai' SDK INSIDE transcribe.

const { definePlugin } = require('../../core');

definePlugin({
  id: 'gemini',
  displayName: 'Gemini',
  description: 'Google Gemini — batch speech-to-text via generateContent.',
  providerType: 'stt',
  order: 30,
  capabilities: {
    batch: { state: 'supported', source: 'declared' },
    streaming: { state: 'unsupported', source: 'declared' },
  },
  modelSettingsPath: null,
  supportedModels: () => [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AIza...', settingsPath: 'apiKeys.gemini', group: 'config' },
  ],
  defaultSettings: {
    apiKeys: { gemini: '' },
  },
  createEngine({ settings }) {
    const apiKey = (settings.apiKeys || {}).gemini;
    return {
      provider: 'gemini',
      ready: !!apiKey,
      async transcribe(wav) {
        if (!apiKey) throw new Error('no gemini api key');
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });
        const res = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{
            role: 'user', parts: [
              { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
              { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
            ],
          }],
        });
        return ((res && res.text) || '').trim();
      },
    };
  },
});
