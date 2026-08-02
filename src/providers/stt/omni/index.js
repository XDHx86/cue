// OmniRoute STT provider — batch transcription via the local OmniRoute AI gateway.
// OmniRoute exposes a Whisper-compatible /v1/audio/transcriptions endpoint at its local URL
// (default http://localhost:20128/v1), so we reuse the `openai` npm package with a custom
// baseURL (same pattern as Groq STT).
//
// readiness: reflects ACTUAL OmniRoute gateway availability via local-health.js, not just
// whether an API key is configured.
//
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine returns { provider, ready, transcribe(wav) }.
// Lazy-requires the 'openai' SDK INSIDE transcribe so requiring this folder at load time
// (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');
const localHealth = require('../../local-health');

const DEFAULT_BASE_URL = 'http://localhost:20128/v1';

defineProvider({
  id: 'omni',
  displayName: 'OmniRoute STT (local)',
  description: 'Local OmniRoute STT — Whisper-compatible batch transcription via the gateway.',
  providerType: 'stt',
  order: 35, // after gemini (30), before external-ws (40)
  capabilities: { batch: true, streaming: false },
  modelSettingsPath: 'stt.omniModel',
  supportedModels: () => [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3' },
  ],
  configurableSettings: [
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-large-v3-turbo' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL },
  ],
  defaultSettings: {
    stt: { omniModel: 'whisper-large-v3-turbo' },
    omniroute: { baseURL: '' },
  },
  createEngine({ settings }) {
    const apiKey = 'omniroute'; // sentinel — OmniRoute ignores it for free tier
    const baseURL = (settings.omniroute && settings.omniroute.baseURL) || DEFAULT_BASE_URL;
    const model = (settings.stt && settings.stt.omniModel) || 'whisper-large-v3-turbo';
    return {
      provider: 'omni',
      ready: localHealth.isReady('omni') && !!apiKey,
      async transcribe(wav) {
        if (!localHealth.isReady('omni')) throw new Error('OmniRoute gateway not reachable');
        const OpenAI = require('openai');
        const toFile = OpenAI.toFile || require('openai/uploads').toFile;
        const client = new OpenAI({ apiKey, baseURL });
        const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
        const res = await client.audio.transcriptions.create({ file, model });
        return (res.text || '').trim();
      },
    };
  },
});
