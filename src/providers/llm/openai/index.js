// OpenAI LLM provider — GPT-4o family, chat completions + streaming, vision via image_url.
// Self-describing descriptor: declare id/capabilities/supportedModels/configurableSettings/
// defaultSettings, then createEngine threads settings into the shared OpenAI-compatible engine
// (src/providers/llm/openai-compat.js). Lazy-requires the 'openai' SDK INSIDE createEngine so
// requiring this folder at load time (the registry discovery pass) pulls no network SDK.

const { defineProvider } = require('../../../registry');
const { makeOpenAICompatEngine } = require('../openai-compat');

defineProvider({
  id: 'openai',
  displayName: 'OpenAI',
  description: 'GPT-4o family — chat completions, streaming, and image input.',
  providerType: 'llm',
  order: 1,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'gpt-4o-mini' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'gpt-4o' },
  ],
  defaultSettings: {
    apiKeys: { openai: '' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'openai',
      settings,
      apiKey: (settings.apiKeys || {}).openai,
      baseURL: undefined,
    });
  },
});
