// AssemblyAI real-time streaming STT provider — streaming only, v3 WebSocket protocol.
// Plugin descriptor with rich capabilities, settingsPath. R3 migration: definePlugin.
// No SDK dependency — hand-rolled WebSocket using WsClient from ../external-ws/session.js.

const { definePlugin } = require('../../core');

definePlugin({
  id: 'assemblyai',
  displayName: 'AssemblyAI',
  description: 'AssemblyAI real-time streaming speech-to-text (v3 API).',
  providerType: 'stt',
  order: 15,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    batch: { state: 'unsupported', source: 'declared' },
  },
  modelSettingsPath: 'stt.assemblyaiSpeechModel',
  supportedModels: () => [
    { id: '', label: 'Default' },
    { id: 'universal-3-5-pro', label: 'Universal 3.5 Pro' },
    { id: 'universal-streaming-english', label: 'Universal Streaming English' },
    { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual' },
  ],
  healthCheck: async ({ apiKey }) => {
    if (!apiKey) return { state: 'invalid_config', reason: 'No API key' };
    return { state: 'healthy' };
  },
  healthConfig: { intervalMs: 600000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AssemblyAI API key',
      settingsPath: 'apiKeys.assemblyai', group: 'config' },
    { id: 'language', label: 'Language code', type: 'text', placeholder: 'auto-detect',
      hint: 'ISO 639-1 code (e.g. en, es, fr) or empty for auto-detect.',
      settingsPath: 'stt.assemblyaiLanguage', group: 'config' },
    { id: 'wordBoost', label: 'Custom vocabulary', type: 'text', placeholder: 'comma-separated words',
      hint: 'Boost recognition of specific terms.',
      settingsPath: 'stt.assemblyaiWordBoost', group: 'config' },
    { id: 'speechModel', label: 'Speech model', type: 'select',
      options: [
        { id: '', label: 'Default' },
        { id: 'universal-3-5-pro', label: 'Universal 3.5 Pro' },
        { id: 'universal-streaming-english', label: 'Universal Streaming English' },
        { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual' },
      ],
      settingsPath: 'stt.assemblyaiSpeechModel', group: 'config' },
  ],
  defaultSettings: {
    apiKeys: { assemblyai: '' },
    stt: { assemblyaiLanguage: '', assemblyaiWordBoost: '', assemblyaiSpeechModel: '' },
  },
  createEngine() {
    return { provider: 'assemblyai', ready: false };
  },
  streamingReady(settings) {
    return !!(settings && settings.apiKeys && settings.apiKeys.assemblyai);
  },
  createStreamSession({ settings, channel, language, onFinal, onPartial, onError, onStatus, log }) {
    const apiKey = settings && settings.apiKeys && settings.apiKeys.assemblyai;
    if (!apiKey) return null;
    const { AssemblyAIStreamSession } = require('./session');
    return new AssemblyAIStreamSession({
      apiKey,
      realtimeUrl: (settings.stt && settings.stt.assemblyaiRealtimeUrl) || '',
      language: language || (settings.stt && settings.stt.assemblyaiLanguage) || null,
      wordBoost: (settings.stt && settings.stt.assemblyaiWordBoost) || '',
      speechModel: (settings.stt && settings.stt.assemblyaiSpeechModel) || '',
      onFinal, onPartial, onError, onStatus, log,
      maxConnectFailures: settings.stt && settings.stt.streamMaxConnectFailures,
      maxBackoffMs: settings.stt && settings.stt.streamMaxBackoffMs,
    });
  },
});
