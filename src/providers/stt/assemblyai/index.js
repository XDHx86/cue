// AssemblyAI real-time streaming STT provider — streaming only, v3 WebSocket protocol.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, streamingReady for the streaming resolver, and createStreamSession.
// The batch engine is not supported (ready: false).
//
// No SDK dependency — hand-rolled WebSocket using WsClient from ../external-ws/session.js.
// AssemblyAI Streaming API v3: wss://streaming.assemblyai.com/v3/ws
// Auth: Authorization header with raw API key. Audio: Int16 PCM at 16kHz (binary frames).
// Protocol reference: assemblyai npm package v4.36.4 (researched, NOT used as dependency).

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'assemblyai',
  displayName: 'AssemblyAI',
  description: 'AssemblyAI real-time streaming speech-to-text (v3 API).',
  providerType: 'stt',
  order: 15, // between faster-whisper (local, 10) and openai (batch, 20)
  capabilities: { streaming: true, batch: false },
  modelSettingsPath: 'stt.assemblyaiSpeechModel',
  supportedModels: () => [
    { id: '', label: 'Default' },
    { id: 'universal-3-5-pro', label: 'Universal 3.5 Pro' },
    { id: 'universal-streaming-english', label: 'Universal Streaming English' },
    { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AssemblyAI API key' },
    { id: 'language', label: 'Language code', type: 'text', placeholder: 'auto-detect',
      hint: 'ISO 639-1 code (e.g. en, es, fr) or empty for auto-detect.' },
    { id: 'wordBoost', label: 'Custom vocabulary', type: 'text', placeholder: 'comma-separated words',
      hint: 'Boost recognition of specific terms.' },
    { id: 'speechModel', label: 'Speech model', type: 'select',
      options: [
        { id: '', label: 'Default' },
        { id: 'universal-3-5-pro', label: 'Universal 3.5 Pro' },
        { id: 'universal-streaming-english', label: 'Universal Streaming English' },
        { id: 'universal-streaming-multilingual', label: 'Universal Streaming Multilingual' },
      ] },
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
