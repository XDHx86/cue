// OpenAI Whisper STT provider — batch transcription via audio.transcriptions API.
// Plugin descriptor with rich capabilities, settingsPath. R3 migration: definePlugin.
// Lazy-requires the 'openai' SDK INSIDE transcribe.

const { definePlugin } = require('../../core');

definePlugin({
  id: 'openai',
  displayName: 'OpenAI Whisper',
  description: 'OpenAI Whisper — batch speech-to-text via audio.transcriptions API.',
  providerType: 'stt',
  order: 20,
  capabilities: {
    batch: { state: 'supported', source: 'declared' },
    streaming: { state: 'unsupported', source: 'declared' },
  },
  modelSettingsPath: 'stt.model',
  supportedModels: () => [
    { id: 'whisper-1', label: 'Whisper v1' },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  ],
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...', settingsPath: 'apiKeys.openai', group: 'config' },
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-1', settingsPath: 'stt.model', group: 'config' },
  ],
  defaultSettings: {
    apiKeys: { openai: '' },
    stt: { model: '' },
  },
  createEngine({ settings }) {
    const apiKey = (settings.apiKeys || {}).openai;
    const model = ((settings.stt || {}).model) || 'whisper-1';
    return {
      provider: 'openai',
      ready: !!apiKey,
      async transcribe(wav) {
        if (!apiKey) throw new Error('no openai api key');
        const OpenAI = require('openai');
        const toFile = OpenAI.toFile || require('openai/uploads').toFile;
        const client = new OpenAI({ apiKey });
        const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
        const res = await client.audio.transcriptions.create({ file, model });
        return (res.text || '').trim();
      },
    };
  },
});
