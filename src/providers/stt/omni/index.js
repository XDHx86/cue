// OmniRoute STT provider — batch transcription via the local OmniRoute AI gateway.
// Plugin descriptor with rich capabilities (including local), settingsPath.
// R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const localHealth = require('../../local-health');

const DEFAULT_BASE_URL = 'http://localhost:20128/v1';

definePlugin({
  id: 'omni',
  displayName: 'OmniRoute STT (local)',
  description: 'Local OmniRoute STT — Whisper-compatible batch transcription via the gateway.',
  providerType: 'stt',
  order: 35,
  capabilities: {
    batch: { state: 'supported', source: 'declared' },
    streaming: { state: 'unsupported', source: 'declared' },
    local: { state: 'supported', source: 'declared' },
  },
  modelSettingsPath: 'stt.omniModel',
  supportedModels: () => [
    { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
    { id: 'whisper-large-v3', label: 'Whisper Large v3' },
  ],
  healthCheck: async ({ baseURL }) => {
    const url = (baseURL || 'http://localhost:20128') + '/v1/models';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { state: 'offline', reason: 'Server responded ' + res.status };
      return { state: 'healthy' };
    } catch {
      return { state: 'offline', reason: 'Cannot reach OmniRoute gateway' };
    }
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'model', label: 'Model', type: 'text', placeholder: 'whisper-large-v3-turbo', settingsPath: 'stt.omniModel', group: 'config' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL, settingsPath: 'omniroute.baseURL', group: 'config' },
  ],
  defaultSettings: {
    stt: { omniModel: 'whisper-large-v3-turbo' },
    omniroute: { baseURL: '' },
  },
  createEngine({ settings }) {
    const apiKey = 'omniroute';
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
