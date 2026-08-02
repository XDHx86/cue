// OmniRoute LLM provider — local AI gateway (https://github.com/diegosouzapw/OmniRoute).
// Plugin descriptor with rich capabilities (including local), settingsPath, model discovery
// from the local /v1/models endpoint, and health checks. R3 migration: definePlugin.
//
// readiness: reflects ACTUAL OmniRoute gateway availability via local-health.js.
// skipAutoSwitch: true (no real API key; sentinel key satisfies SDK constructor).

const { definePlugin } = require('../../core');
const { makeOpenAICompatEngine } = require('../openai-compat');
const localHealth = require('../../local-health');

const OMNI = 'omni';
const DEFAULT_BASE_URL = 'http://localhost:20128/v1';

definePlugin({
  id: OMNI,
  displayName: 'OmniRoute (local)',
  description: 'Local OmniRoute AI gateway — 290+ providers, free auto-routing. No API key.',
  providerType: 'llm',
  order: 7,
  skipAutoSwitch: true,
  capabilities: {
    streaming: { state: 'supported', source: 'declared' },
    vision: { state: 'supported', source: 'declared' },
    local: { state: 'supported', source: 'declared' },
  },
  supportedModels: [
    { id: 'auto', label: 'Auto (free routing)' },
    { id: 'openai/gpt-4o', label: 'GPT-4o (via OmniRoute)' },
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (via OmniRoute)' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (via OmniRoute)' },
  ],
  discoverModels: async ({ baseURL }) => {
    const url = (baseURL || 'http://localhost:20128') + '/v1/models';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.data || data.models || []).map(m => ({ id: m.id || m.name, name: m.id || m.name }));
    } catch { return null; }
  },
  normalizeModels: (raw) => require('../../core/adapters/omni').normalizeModels(raw, 'omni'),
  healthCheck: async ({ baseURL }) => {
    const url = (baseURL || 'http://localhost:20128') + '/v1/models';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { state: 'offline', reason: 'Server responded ' + res.status };
      return { state: 'healthy' };
    } catch {
      return { state: 'offline', reason: 'Cannot reach OmniRoute gateway' };
    }
  },
  healthConfig: { intervalMs: 60000, timeoutMs: 5000 },
  configurableSettings: [
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'auto', settingsPath: 'models.omni.fast', group: 'models' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'auto', settingsPath: 'models.omni.smart', group: 'models' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL, settingsPath: 'omniroute.baseURL', group: 'config' },
  ],
  defaultSettings: {
    apiKeys: { omni: 'omniroute' },
    models: { omni: { fast: 'auto', smart: 'auto' } },
    omniroute: { baseURL: '' },
  },
  createEngine({ settings }) {
    const baseURL = (settings.omniroute && settings.omniroute.baseURL) || DEFAULT_BASE_URL;
    const engine = makeOpenAICompatEngine({
      id: OMNI,
      settings,
      apiKey: OMNI,
      baseURL,
    });
    return {
      ...engine,
      ready: localHealth.isReady(OMNI) && !!engine.model,
    };
  },
});
