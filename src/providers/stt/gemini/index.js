// Gemini STT provider — batch transcription via generateContent.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine returns { provider, ready, transcribe(wav) }.
// Lazy-requires the '@google/genai' SDK INSIDE transcribe so requiring this folder at load
// time (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'gemini',
  displayName: 'Gemini',
  description: 'Google Gemini — batch speech-to-text via generateContent.',
  providerType: 'stt',
  order: 30,
  capabilities: { batch: true, streaming: false },
  supportedModels: () => [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AIza...' },
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
