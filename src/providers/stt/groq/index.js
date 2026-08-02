// Groq STT provider — batch transcription via OpenAI-compatible audio.transcriptions API.
// Groq exposes a Whisper-compatible endpoint at https://api.groq.com/openai/v1, so we reuse
// the `openai` npm package (already a project dependency) with a custom baseURL.
//
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine returns { provider, ready, transcribe(wav) }.
// Lazy-requires the 'openai' SDK INSIDE transcribe so requiring this folder at load time
// (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'groq',
  displayName: 'Groq Whisper',
  description: 'Groq — fast batch speech-to-text via OpenAI-compatible audio.transcriptions API.',
  providerType: 'stt',
  order: 25, // between OpenAI Whisper (20) and Gemini (30)
  capabilities: { batch: true, streaming: false },
  modelSettingsPath: 'stt.groqModel',
  supportedModels: () => [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3' },
    { id: 'distil-whisper-large-v3-en', label: 'Distil Whisper v3 (EN)' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'gsk_...' },
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-large-v3-turbo' },
  ],
  defaultSettings: {
    apiKeys: { groq: '' },
    stt: { groqModel: '' },
  },
  createEngine({ settings }) {
    const apiKey = (settings.apiKeys || {}).groq;
    const model = (settings.stt && settings.stt.groqModel) || 'whisper-large-v3-turbo';
    return {
      provider: 'groq',
      ready: !!apiKey,
      async transcribe(wav) {
        if (!apiKey) throw new Error('no groq api key');
        const OpenAI = require('openai');
        const toFile = OpenAI.toFile || require('openai/uploads').toFile;
        const client = new OpenAI({
          apiKey,
          baseURL: 'https://api.groq.com/openai/v1',
        });
        const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
        const res = await client.audio.transcriptions.create({ file, model });
        return (res.text || '').trim();
      },
    };
  },
});
