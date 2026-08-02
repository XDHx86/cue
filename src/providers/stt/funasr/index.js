// FunASR — local Paraformer STT provider.
// Streaming feel via the Python service's VAD endpointing loop (webrtcvad).
// Batch goes through the same Python RPC (transcribe method).

const { defineProvider } = require('../../../registry');
const { getLocalManager, localManagerReady } = require('../../../stt-managers');
const { LocalFunasrSession, funasrLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('../../../stt-funasr-engine');
const { FUNASR_MODEL_IDS } = require('../../../stt-funasr-models');

defineProvider({
  id: 'funasr',
  displayName: 'FunASR Paraformer',
  description: 'Local offline FunASR speech-to-text (batch + streaming)',
  providerType: 'stt',
  order: 5, // before faster-whisper (10) in the fallback chain
  capabilities: { streaming: true, batch: true, local: true },

  supportedModels: FUNASR_MODEL_IDS.map((id) => ({ id, label: id })),
  modelSettingsPath: 'stt.funasr.model',

  configurableSettings: [
    {
      id: 'model', label: 'Model', type: 'select',
      options: FUNASR_MODEL_IDS.map((id) => ({ id, label: id })),
      placeholder: 'paraformer-large-zh',
    },
    { id: 'device', label: 'Device', type: 'select',
      options: [{ id: 'auto', label: 'auto' }, { id: 'cpu', label: 'cpu' }, { id: 'cuda', label: 'cuda' }],
      placeholder: 'cpu' },
    {
      id: 'language', label: 'Language', type: 'select',
      options: [
        { id: '', label: 'Auto-detect' },
        { id: 'en', label: 'English' },
        { id: 'zh', label: '中文' },
      ],
      placeholder: 'Auto-detect',
    },
  ],

  defaultSettings: {
    stt: {
      funasr: { model: 'paraformer-large-zh', device: 'cpu', language: '' },
    },
  },

  createEngine({ settings, manager, log }) {
    const mgr = getLocalManager('funasr');
    if (!mgr || typeof mgr.call !== 'function') {
      log && log.debug && log.debug('FunASR manager not available');
      return { provider: 'funasr', ready: false };
    }
    const ready = !!(mgr.isVenvReady && mgr.isVenvReady());
    return {
      provider: 'funasr',
      ready,
      transcribe: async (wav) => {
        if (!(await mgr.ensureRunning())) throw new Error('FunASR service not running');
        const params = funasrLoadParams(settings, mgr, null);
        const last = mgr.getLastLoad();
        const loadTimeout = (settings && settings.stt && settings.stt.modelLoadTimeoutMs) || MODEL_LOAD_TIMEOUT_MS;
        if (!last || JSON.stringify(last) !== JSON.stringify(params)) {
          await mgr.call('load', params, { timeout: loadTimeout });
          mgr.setLastLoad(params);
        }
        const wav_b64 = Buffer.from(wav).toString('base64');
        const res = await mgr.call('transcribe', { wav_b64 });
        return { text: (res && res.text) || '' };
      },
    };
  },

  streamingReady(settings, ctx) {
    // FunASR is local; ready iff its own (lazy) manager reports venv ready.
    // The ctx.localReady hint is the faster-whisper manager's state, not ours, so we
    // ignore it and check our own manager (which registers lazily on first use).
    return localManagerReady('funasr');
  },

  createStreamSession({ settings, manager, channel, language, onFinal, onPartial, onError, onStatus }) {
    const mgr = getLocalManager('funasr');
    if (!mgr || !mgr.isVenvReady || !mgr.isVenvReady()) return null;
    return new LocalFunasrSession({
      manager: mgr, channel, language,
      onFinal, onPartial, onError, onStatus, settings,
    });
  },
});