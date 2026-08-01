// Local managed faster-whisper STT provider — batch + streaming via the managed Python service.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine returns { provider, ready, transcribe(wav) } and
// createStreamSession returns a LocalFasterWhisperSession.
//
// The batch transcribe path reuses the SAME process manager + JSON-RPC client (src/stt-process.js)
// as the streaming engine and calls the service's `transcribe` method directly over stdin/stdout.
// No HTTP server, no fasterWhisperURL — the obsolete HTTP batch path (POST WAV to /transcribe)
// is gone; the fasterWhisperURL field now only selects the EXTERNAL user-run WS server in the
// external-ws provider.
//
// supportedModels scans the HuggingFace hub cache (scanCachedModels) so Settings can show
// cached/downloaded flags before the Python service has even started.

const { defineProvider } = require('../../../registry');
const { LocalFasterWhisperSession, localLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('../../../stt-engine');
const { scanCachedModels, STT_MODEL_SIZES } = require('../../../stt-models');

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;

defineProvider({
  id: 'faster-whisper',
  displayName: 'faster-whisper (local)',
  description: 'Local faster-whisper engine via managed Python service (batch + streaming).',
  providerType: 'stt',
  order: 10,
  capabilities: { streaming: true, batch: true, local: true },
  supportedModels: (ctx) => scanCachedModels(ctx.modelsDir, ctx.fs),
  configurableSettings: [
    { id: 'model', label: 'Model', type: 'select',
      options: STT_MODEL_SIZES.map((s) => ({ id: s, label: s })), placeholder: 'small' },
    { id: 'device', label: 'Device', type: 'select',
      options: [{ id: 'auto', label: 'auto' }, { id: 'cpu', label: 'cpu' }, { id: 'cuda', label: 'cuda' }] },
    { id: 'computeType', label: 'Compute type', type: 'select',
      options: [{ id: 'int8', label: 'int8' }, { id: 'int8_float16', label: 'int8_float16' },
                { id: 'float16', label: 'float16' }, { id: 'float32', label: 'float32' },
                { id: 'auto', label: 'auto' }] },
    { id: 'language', label: 'Language', type: 'text', placeholder: 'auto-detect' },
    { id: 'vad', label: 'VAD filtering', type: 'boolean' },
  ],
  defaultSettings: {
    stt: {
      engine: 'faster-whisper',
      local: { model: 'small', device: 'auto', computeType: 'int8', language: 'auto', vad: true },
    },
  },
  createEngine({ settings, manager }) {
    const ready = !!(manager && manager.isVenvReady && manager.isVenvReady());
    return {
      provider: 'faster-whisper',
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
