// Deepgram STT provider — streaming (WebSocket) and batch (REST API).
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, streamingReady for the streaming resolver, and createStreamSession.
// Both streaming and batch are supported (the batch path falls through the createSTT chain
// in src/stt.js).
//
// No SDK dependency — hand-rolled WebSocket using WsClient from ../external-ws/session.js
// for streaming, and Node global fetch for batch (POST /v1/listen with raw WAV body).
// Deepgram API: https://api.deepgram.com/v1/listen
// Auth: Authorization: Token <key>
// Streaming: wss://api.deepgram.com/v1/listen — binary Int16 PCM → JSON text responses.

const { defineProvider } = require('../../../registry');

defineProvider({
  id: 'deepgram',
  displayName: 'Deepgram',
  description: 'Deepgram speech-to-text (streaming WebSocket + batch REST API).',
  providerType: 'stt',
  order: 17, // between assemblyai (15, streaming-only) and openai (20, batch-only)
  capabilities: { streaming: true, batch: true },
  modelSettingsPath: 'stt.deepgramModel',
  supportedModels: () => [
    { id: '', label: 'Default (Nova 3)' },
    { id: 'nova-3', label: 'Nova 3' },
    { id: 'nova-3-general', label: 'Nova 3 General' },
    { id: 'nova-3-medical', label: 'Nova 3 Medical' },
    { id: 'nova-2', label: 'Nova 2' },
    { id: 'nova-2-general', label: 'Nova 2 General' },
    { id: 'nova-2-meeting', label: 'Nova 2 Meeting' },
    { id: 'nova-2-conversationalai', label: 'Nova 2 Conversational AI' },
    { id: 'enhanced', label: 'Enhanced' },
    { id: 'base', label: 'Base' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'Deepgram API key' },
    { id: 'model', label: 'Model', type: 'select',
      options: [
        { id: '', label: 'Default (Nova 3)' },
        { id: 'nova-3', label: 'Nova 3' },
        { id: 'nova-3-general', label: 'Nova 3 General' },
        { id: 'nova-3-medical', label: 'Nova 3 Medical' },
        { id: 'nova-2', label: 'Nova 2' },
        { id: 'nova-2-general', label: 'Nova 2 General' },
        { id: 'nova-2-meeting', label: 'Nova 2 Meeting' },
        { id: 'enhanced', label: 'Enhanced' },
        { id: 'base', label: 'Base' },
      ] },
    { id: 'language', label: 'Language code', type: 'text', placeholder: 'en',
      hint: 'BCP-47 language code (e.g. en, es, fr) for primary spoken language.' },
    { id: 'smartFormat', label: 'Smart formatting', type: 'boolean',
      hint: 'Apply formatting to transcript output for improved readability.' },
    { id: 'punctuate', label: 'Punctuation', type: 'boolean',
      hint: 'Add punctuation and capitalization.' },
    { id: 'endpointingMs', label: 'Endpointing (ms)', type: 'number', placeholder: '300',
      hint: 'Silence duration (ms) to detect end of speech.' },
    { id: 'utteranceEndMs', label: 'Utterance end (ms)', type: 'number', placeholder: '1000',
      hint: 'Longer silence threshold (ms) for utterance boundary.' },
  ],
  defaultSettings: {
    apiKeys: { deepgram: '' },
    stt: {
      deepgramModel: '',
      deepgramLanguage: '',
      deepgramSmartFormat: true,
      deepgramPunctuate: true,
      deepgramEndpointingMs: 300,
      deepgramUtteranceEndMs: 1000,
      deepgramURL: 'wss://api.deepgram.com/v1/listen',
    },
  },

  // ---- batch engine (POST /v1/listen with raw WAV body) --------------------
  createEngine({ settings }) {
    const apiKey = (settings.apiKeys || {}).deepgram;
    if (!apiKey) return { provider: 'deepgram', ready: false };
    const stt = settings.stt || {};
    const model = stt.deepgramModel || 'nova-3';
    return {
      provider: 'deepgram',
      ready: true,
      async transcribe(wav) {
        const url = new URL('https://api.deepgram.com/v1/listen');
        url.searchParams.set('model', model);
        url.searchParams.set('encoding', 'linear16');
        url.searchParams.set('sample_rate', '16000');
        url.searchParams.set('channels', '1');
        if (stt.deepgramSmartFormat) url.searchParams.set('smart_format', 'true');
        if (stt.deepgramPunctuate) url.searchParams.set('punctuate', 'true');
        const lang = stt.deepgramLanguage;
        if (lang) url.searchParams.set('language', lang);
        const res = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Authorization': 'Token ' + apiKey,
            'Content-Type': 'audio/wav',
          },
          body: wav,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error('Deepgram batch error ' + res.status + ': ' + body);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        const ch = data.results && data.results.channels &&
                   data.results.channels[0];
        const alt = ch && ch.alternatives && ch.alternatives[0];
        return (alt && alt.transcript || '').trim();
      },
    };
  },

  // ---- streaming readiness -------------------------------------------------
  streamingReady(settings) {
    return !!(settings && settings.apiKeys && settings.apiKeys.deepgram);
  },

  // ---- streaming session factory -------------------------------------------
  createStreamSession({ settings, channel, language, onFinal, onPartial, onError, onStatus, log }) {
    const apiKey = settings && settings.apiKeys && settings.apiKeys.deepgram;
    if (!apiKey) return null;
    const { DeepgramStreamSession } = require('./session');
    return new DeepgramStreamSession({
      apiKey,
      url: (settings.stt && settings.stt.deepgramURL) || '',
      model: (settings.stt && settings.stt.deepgramModel) || '',
      language: language || (settings.stt && settings.stt.deepgramLanguage) || null,
      smartFormat: settings.stt && settings.stt.deepgramSmartFormat,
      punctuate: settings.stt && settings.stt.deepgramPunctuate,
      endpointingMs: settings.stt && settings.stt.deepgramEndpointingMs,
      utteranceEndMs: settings.stt && settings.stt.deepgramUtteranceEndMs,
      onFinal, onPartial, onError, onStatus, log,
      maxConnectFailures: settings.stt && settings.stt.streamMaxConnectFailures,
      maxBackoffMs: settings.stt && settings.stt.streamMaxBackoffMs,
    });
  },
});
