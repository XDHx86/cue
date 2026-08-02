// Ollama LLM provider — local `ollama serve` exposes an OpenAI-compatible /v1 endpoint.
// Plugin descriptor with rich capabilities (including local), settingsPath, model discovery
// from the local /api/tags endpoint, and health checks. R3 migration: definePlugin.
//
// readiness: ollama needs only a model (no real key), but `ready` reflects ACTUAL `ollama serve`
// availability via local-health.js (a periodic HTTP GET to /v1/models), not just configuration —
// a model without a running server reports not-ready. skipAutoSwitch: true (no real API key).

const { definePlugin } = require('../../core');
const { makeOpenAICompatEngine } = require('../openai-compat');
const localHealth = require('../../local-health');

const OLLAMA = 'ollama';
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

definePlugin({
  id: OLLAMA,
  displayName: 'Ollama (local)',
  description: 'Local models via your own `ollama serve` (OpenAI-compatible /v1 endpoint). No API key.',
  providerType: 'llm',
  order: 6,
  skipAutoSwitch: true,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
    local: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'llama3.2', label: 'Llama 3.2' },
    { id: 'llama3.3', label: 'Llama 3.3' },
  ],
  discoverModels: async ({ baseURL }) => {
    const url = (baseURL || 'http://localhost:11434') + '/api/tags';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.models || []).map(m => ({ id: m.name || m.model, name: m.name || m.model }));
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/ollama').normalizeModels(raw, 'ollama'),
  healthCheck: async ({ baseURL }) => {
    const url = (baseURL || 'http://localhost:11434') + '/v1/models';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { state: 'offline', reason: 'Server responded ' + res.status };
      return { state: 'healthy' };
    } catch {
      return { state: 'offline', reason: 'Cannot reach ollama serve' };
    }
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'llama3.2', settingsPath: 'models.ollama.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'llama3.3', settingsPath: 'models.ollama.smart', group: 'models' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL, settingsPath: 'ollama.baseURL', group: 'config' },
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
      apiKey: OLLAMA,
      baseURL,
    });
    return {
      ...engine,
      ready: localHealth.isReady(OLLAMA) && !!engine.model,
    };
  },
});
