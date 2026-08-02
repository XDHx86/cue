// External faster-whisper WebSocket server STT provider — streaming only.
// Plugin descriptor with rich capabilities, settingsPath. R3 migration: definePlugin.

const { definePlugin } = require('../../core');

definePlugin({
  id: 'external-ws',
  displayName: 'External faster-whisper server',
  description: 'External faster-whisper WebSocket server (user-run, streaming only).',
  providerType: 'stt',
  order: 40,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    batch: { state: 'unsupported', source: 'declared' },
  },
  modelSettingsPath: null,
  supportedModels: () => null,
  healthCheck: async ({ url }) => {
    if (!url) return { state: 'invalid_config', reason: 'No URL configured' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'url', label: 'WebSocket URL', type: 'text', placeholder: 'ws://localhost:9080',
      settingsPath: 'stt.fasterWhisperURL', group: 'config' },
  ],
  defaultSettings: {
    stt: { fasterWhisperURL: '' },
  },
  createEngine() {
    return { provider: 'external-ws', ready: false };
  },
  streamingReady(settings) {
    return !!(settings && settings.stt && settings.stt.fasterWhisperURL);
  },
  createStreamSession({ settings, channel, language, onFinal, onPartial, onError, onStatus, log }) {
    const url = (settings && settings.stt && settings.stt.fasterWhisperURL) || '';
    if (!url) return null;
    const { FasterWhisperStreamSession } = require('./session');
    return new FasterWhisperStreamSession({
      url, language,
      onFinal, onPartial, onError, onStatus, log,
      maxConnectFailures: settings.stt && settings.stt.streamMaxConnectFailures,
      maxBackoffMs: settings.stt && settings.stt.streamMaxBackoffMs,
    });
  },
});
