// Groq LLM provider — Groq-hosted Llama models via the OpenAI-compatible chat completions API.
// Groq exposes a fast inference endpoint at https://api.groq.com/openai/v1, so we reuse the
// `openai` npm package with a custom baseURL via the shared openai-compat engine factory.
//
// The same API key (gsk_...) powers Groq's STT provider (src/providers/stt/groq/).
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine threads settings into makeOpenAICompatEngine.
// Lazy-requires the 'openai' SDK INSIDE createEngine so requiring this folder at load time
// (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');
const { makeOpenAICompatEngine } = require('../openai-compat');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

defineProvider({
  id: 'groq',
  displayName: 'Groq',
  description: 'Groq-hosted Llama models — ultra-fast inference via OpenAI-compatible API.',
  providerType: 'llm',
  order: 4,
  capabilities: { streaming: true, vision: false },
  supportedModels: [
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' },
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'gsk_...' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'llama-3.1-8b-instant' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'llama-3.3-70b-versatile' },
  ],
  defaultSettings: {
    apiKeys: { groq: '' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'groq',
      settings,
      apiKey: (settings.apiKeys || {}).groq,
      baseURL: GROQ_BASE_URL,
    });
  },
});
