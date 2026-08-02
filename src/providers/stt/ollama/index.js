// Ollama STT provider — delegates to the managed local faster-whisper engine.
// Plugin descriptor with rich capabilities (including local). R3 migration: definePlugin.
// Order 50 — only activates when explicitly selected.

const { definePlugin } = require('../../core');
const { LocalFasterWhisperSession, localLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('../../../stt-engine');

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;

definePlugin({
  id: 'ollama',
  displayName: 'Ollama STT (local)',
  description: 'Local STT via faster-whisper — for users running Ollama locally.',
  providerType: 'stt',
  order: 50,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    batch: { state: 'supported', source: 'declared' },
    local: { state: 'supported', source: 'declared' },
  },
  supportedModels: null,
  modelSettingsPath: null,
  healthCheck: async () => {
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },
  configurableSettings: [],
  defaultSettings: {},

  createEngine({ settings, manager }) {
    const ready = !!(manager && manager.isVenvReady && manager.isVenvReady());
    return {
      provider: 'ollama',
      ready,
      async transcribe(wav) {
        if (!manager) throw new Error('no manager');
        if (!(await manager.ensureRunning())) throw new Error('STT service not running');
        const params = localLoadParams(settings, manager, null);
        const sttCfg = (settings && settings.stt) || {};
        const loadTimeout = sttCfg.modelLoadTimeoutMs || MODEL_LOAD_TIMEOUT_MS;
        const transcribeTimeout = sttCfg.transcribeTimeoutMs || LOCAL_TRANSCRIBE_TIMEOUT_MS;
        const last = manager.getLastLoad();
        if (!last || JSON.stringify(last) !== JSON.stringify(params)) {
          await manager.call('load', params, { timeout: loadTimeout });
          manager.setLastLoad(params);
        }
        const res = await manager.call('transcribe',
          { wav_b64: wav.toString('base64'), language: params.language },
          { timeout: transcribeTimeout });
        return ((res && typeof res.text === 'string') ? res.text : '').trim();
      },
    };
  },

  streamingReady(settings, ctx) {
    return !!(ctx && ctx.localReady);
  },

  createStreamSession({ settings, manager, channel, language, onFinal, onPartial, onError, onStatus }) {
    if (!manager || !manager.isVenvReady || !manager.isVenvReady()) return null;
    return new LocalFasterWhisperSession({
      manager, channel, language, onFinal, onPartial, onError, onStatus, settings,
    });
  },
});
