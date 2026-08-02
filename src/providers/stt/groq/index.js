// Groq STT provider — batch transcription via OpenAI-compatible audio.transcriptions API.
// Plugin descriptor with rich capabilities, settingsPath. R3 migration: definePlugin.
// Lazy-requires the 'openai' SDK INSIDE transcribe.

const { definePlugin } = require('../../core');

definePlugin({
  id: 'groq',
  displayName: 'Groq Whisper',
  description: 'Groq — fast batch speech-to-text via OpenAI-compatible audio.transcriptions API.',
  providerType: 'stt',
  order: 25,
  capabilities: {
    batch: { state: 'supported', source: 'declared' },
    streaming: { state: 'unsupported', source: 'declared' },
  },
  modelSettingsPath: 'stt.groqModel',
  supportedModels: () => [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3' },
    { id: 'distil-whisper-large-v3-en', label: 'Distil Whisper v3 (EN)' },
  ],
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'gsk_...', settingsPath: 'apiKeys.groq', group: 'config' },
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-large-v3-turbo', settingsPath: 'stt.groqModel', group: 'config' },
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
        const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
        const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
        const res = await client.audio.transcriptions.create({ file, model });
        return (res.text || '').trim();
      },
    };
  },
});
