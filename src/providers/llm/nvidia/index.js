// Nvidia LLM provider — Nvidia's integrate API is OpenAI-compatible. Same SDK, same request
// shape, only a fixed baseURL (https://integrate.api.nvidia.com/v1). Delegates to the shared
// OpenAI-compatible engine factory, so the streaming path lives in exactly one place across
// openai / nvidia / ollama. Model defaults are Nvidia-hosted Llama vision-instruct checkpoints.

const { defineProvider } = require('../../../registry');
const { makeOpenAICompatEngine } = require('../openai-compat');

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

defineProvider({
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  description: 'Nvidia-hosted models via the integrate API (OpenAI-compatible).',
  providerType: 'llm',
  order: 4,
  capabilities: { streaming: true, vision: true },
  supportedModels: [
    { id: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision' },
    { id: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision' },
  ],
  configurableSettings: [
    { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'nvapi-...' },
    { id: 'fast', label: 'Fast model', type: 'text', placeholder: 'meta/llama-3.2-11b-vision-instruct' },
    { id: 'smart', label: 'Smart model', type: 'text', placeholder: 'meta/llama-3.2-90b-vision-instruct' },
  ],
  defaultSettings: {
    apiKeys: { nvidia: '' },
    models: { nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' } },
  },
  createEngine({ settings }) {
    return makeOpenAICompatEngine({
      id: 'nvidia',
      settings,
      apiKey: (settings.apiKeys || {}).nvidia,
      baseURL: NVIDIA_BASE_URL,
    });
  },
});
