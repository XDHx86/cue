// OmniRoute LLM provider — local AI gateway (https://github.com/diegosouzapw/OmniRoute).
// OmniRoute runs locally (default http://localhost:20128/v1), routes to 290+ cloud providers
// with auto-fallback, and supports free tiers out of the box — no API key needed.
// Uses OpenAI-compatible /v1/chat/completions, so we reuse the openai-compat engine factory
// with a sentinel apiKey (same pattern as Ollama).
//
// readiness: reflects ACTUAL OmniRoute gateway availability via local-health.js (a periodic
// HTTP GET to /v1/models), not just whether a model is configured. The gateway must be
// running for the provider to report ready.
//
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine threads settings into makeOpenAICompatEngine.
// Lazy-requires the 'openai' SDK INSIDE createEngine so requiring this folder at load time
// (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');
const { makeOpenAICompatEngine } = require('../openai-compat');
const localHealth = require('../../local-health');

const OMNI = 'omni';
const DEFAULT_BASE_URL = 'http://localhost:20128/v1';

defineProvider({
  id: OMNI,
  displayName: 'OmniRoute (local)',
  description: 'Local OmniRoute AI gateway — 290+ providers, free auto-routing. No API key.',
  providerType: 'llm',
  order: 7,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'auto', label: 'Auto (free routing)' },
    { id: 'openai/gpt-4o', label: 'GPT-4o (via OmniRoute)' },
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (via OmniRoute)' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (via OmniRoute)' },
  ],
  configurableSettings: [
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'auto' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'auto' },
    { id: 'baseURL', label: 'Base URL', type: 'text', placeholder: DEFAULT_BASE_URL },
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
      apiKey: OMNI, // sentinel — satisfies the SDK constructor; OmniRoute ignores it for free tier
      baseURL,
    });
    // Override ready: reflect actual OmniRoute gateway availability, not just configuration.
    return {
      ...engine,
      ready: localHealth.isReady(OMNI) && !!engine.model,
    };
  },
});
