// Ollama STT provider — delegates to the managed local faster-whisper engine.
// Users who run Ollama (local LLM) typically want local STT too. This provider
// exposes the same faster-whisper engine under the 'ollama' id so the STT dropdown
// offers an explicit "Ollama STT (local)" option that matches the LLM provider.
//
// Implementation: reuses the SAME orchestrator-passed manager as faster-whisper (the shared
// createSttProcessManager singleton in main.js) for both batch and streaming — no new Python
// process, just the existing engine under a different id. Order 50 ensures this provider
// never interferes with the 'auto' cascade (it only activates when the user explicitly
// selects 'ollama' in the STT dropdown).
//
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine/createStreamSession delegate to the faster-whisper
// engine infrastructure.

const { defineProvider } = require('../../../registry');
const { LocalFasterWhisperSession, localLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('../../../stt-engine');

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;

defineProvider({
  id: 'ollama',
  displayName: 'Ollama STT (local)',
  description: 'Local STT via faster-whisper — for users running Ollama locally.',
  providerType: 'stt',
  order: 50, // last in both chains — only activates when explicitly selected
  capabilities: { streaming: true, batch: true, local: true },
  supportedModels: null, // uses the same stt.local.model as faster-whisper
  modelSettingsPath: null,
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
