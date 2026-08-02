// FunASR — local Paraformer STT provider.
// Plugin descriptor with rich capabilities (including local), settingsPath.
// R3 migration: definePlugin.

const { definePlugin } = require('../../core');
const { getLocalManager, localManagerReady } = require('../../../stt-managers');
const { LocalFunasrSession, funasrLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('../../../stt-funasr-engine');
const { FUNASR_MODEL_IDS } = require('../../../stt-funasr-models');

definePlugin({
  id: 'funasr',
  displayName: 'FunASR Paraformer',
  description: 'Local offline FunASR speech-to-text (batch + streaming)',
  providerType: 'stt',
  order: 5,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    batch: { state: 'supported', source: 'declared' },
    local: { state: 'supported', source: 'declared' },
  },

  supportedModels: FUNASR_MODEL_IDS.map((id) => ({ id, label: id })),
  modelSettingsPath: 'stt.funasr.model',

  healthCheck: async () => {
    if (!localManagerReady('funasr')) return { state: 'offline', reason: 'FunASR venv not ready' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },

  configurableSettings: [
    { id: 'model', label: 'Model', type: 'select',
      options: FUNASR_MODEL_IDS.map((id) => ({ id, label: id })),
      placeholder: 'paraformer-large-zh',
      settingsPath: 'stt.funasr.model', group: 'config' },
    { id: 'device', label: 'Device', type: 'select',
      options: [{ id: 'auto', label: 'auto' }, { id: 'cpu', label: 'cpu' }, { id: 'cuda', label: 'cuda' }],
      placeholder: 'cpu',
      settingsPath: 'stt.funasr.device', group: 'config' },
    { id: 'language', label: 'Language', type: 'select',
      options: [
        { id: '', label: 'Auto-detect' },
        { id: 'en', label: 'English' },
        { id: 'zh', label: '中文' },
      ],
      placeholder: 'Auto-detect',
      settingsPath: 'stt.funasr.language', group: 'config' },
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
