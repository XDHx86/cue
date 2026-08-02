// Ollama LLM provider — local `ollama serve` exposes an OpenAI-compatible /v1 endpoint. Delegates
// to the shared OpenAI-compatible engine factory with two divergences from plain OpenAI:
//   1. apiKey is the constant sentinel 'ollama' — the OpenAI SDK constructor demands a non-empty
//      key, Ollama ignores it, and a runtime value pulled from settings could be blanked by the
//      user in Settings, so we pass the sentinel directly (never settings.apiKeys.ollama).
//   2. baseURL = settings.ollama.baseURL || 'http://localhost:11434/v1' (Ollama's default).
// readiness: ollama needs only a model (no real key), but `ready` reflects ACTUAL `ollama serve`
// availability via local-health.js (a periodic HTTP GET to /v1/models), not just configuration —
// a model without a running server reports not-ready. The 'ollama' sentinel in DEFAULTS apiKeys is
// non-empty to keep deepMerge from treating ollama as "no key configured".

const { defineProvider } = require('../../../registry');
const { makeOpenAICompatEngine } = require('../openai-compat');
const localHealth = require('../../local-health');

const OLLAMA = 'ollama';
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

defineProvider({
  id: OLLAMA,
  displayName: 'Ollama (local)',
  description: 'Local models via your own `ollama serve` (OpenAI-compatible /v1 endpoint). No API key.',
  providerType: 'llm',
  order: 6,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'llama3.2', label: 'Llama 3.2' },
    { id: 'llama3.3', label: 'Llama 3.3' },
  ],
  configurableSettings: [
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'llama3.2' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'llama3.3' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL },
  ],
  defaultSettings: {
    apiKeys: { ollama: 'ollama' },
    models: { ollama: { fast: 'llama3.2', smart: 'llama3.3' } },
    ollama: { baseURL: '' },
  },
  createEngine({ settings }) {
    const baseURL = (settings.ollama && settings.ollama.baseURL) || DEFAULT_BASE_URL;
    const engine = makeOpenAICompatEngine({
      id: OLLAMA,
      settings,
      apiKey: OLLAMA,        // sentinel — never the user setting (could be blank); Ollama ignores it
      baseURL,
    });
    // Override ready: reflect actual `ollama serve` availability, not just configuration.
    return {
      ...engine,
      ready: localHealth.isReady(OLLAMA) && !!engine.model,
    };
  },
});
