// External faster-whisper WebSocket server STT provider — streaming only.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, streamingReady for the streaming resolver, and createStreamSession.
// The batch engine is not supported (ready: false).

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'external-ws',
  displayName: 'External faster-whisper server',
  description: 'External faster-whisper WebSocket server (user-run, streaming only).',
  providerType: 'stt',
  order: 40,
  capabilities: { streaming: true, batch: false },
  supportedModels: () => null,
  configurableSettings: [
    { id: 'url', label: 'WebSocket URL', type: 'text', placeholder: 'ws://localhost:9080' },
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
      url,
      language,
      onFinal, onPartial, onError, onStatus,
      log,
      maxConnectFailures: settings.stt && settings.stt.streamMaxConnectFailures,
      maxBackoffMs: settings.stt && settings.stt.streamMaxBackoffMs,
    });
  },
});
