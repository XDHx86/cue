// OpenAI Whisper STT provider — batch transcription via audio.transcriptions API.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine returns { provider, ready, transcribe(wav) }.
// Lazy-requires the 'openai' SDK INSIDE transcribe so requiring this folder at load time
// (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'openai',
  displayName: 'OpenAI Whisper',
  description: 'OpenAI Whisper — batch speech-to-text via audio.transcriptions API.',
  providerType: 'stt',
  order: 20,
  capabilities: { batch: true, streaming: false },
  modelSettingsPath: 'stt.model',
  supportedModels: () => [
    { id: 'whisper-1', label: 'Whisper v1' },
    { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
    { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...' },
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-1' },
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
