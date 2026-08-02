const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../src/registry');
const loader = require('../src/registry-loader');
loader.loadProviders({ _require: require });

const groq = registry.getProvider('llm', 'groq');

test('groq LLM provider is registered with correct metadata', () => {
  assert.ok(groq, 'groq provider exists');
  assert.equal(groq.id, 'groq');
  assert.equal(groq.providerType, 'llm');
  assert.equal(groq.displayName, 'Groq');
  assert.deepEqual(groq.capabilities.streaming, { state: 'supported', source: 'declared' });
  assert.deepEqual(groq.capabilities.vision, { state: 'unsupported', source: 'declared' });
  assert.ok(groq.supportedModels.length > 0, 'has supported models');
});

test('groq LLM engine is ready with valid key and model', () => {
  const settings = {
    smart: false,
    apiKeys: { groq: 'gsk_test123' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } },
  };
  const eng = groq.createEngine({ settings });
  assert.equal(eng.ready, true);
  assert.equal(eng.provider, 'groq');
  assert.equal(eng.model, 'llama-3.1-8b-instant');
  assert.equal(typeof eng.stream, 'function');
});

test('groq LLM engine is not ready without API key', () => {
  const settings = {
    smart: false,
    apiKeys: {},
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } },
  };
  const eng = groq.createEngine({ settings });
  assert.equal(eng.ready, false);
});

test('groq LLM engine is not ready without model', () => {
  const settings = {
    smart: false,
    apiKeys: { groq: 'gsk_test123' },
    models: {},
  };
  const eng = groq.createEngine({ settings });
  assert.equal(eng.ready, false);
});

test('groq LLM engine picks smart tier when settings.smart is true', () => {
  const settings = {
    smart: true,
    apiKeys: { groq: 'gsk_test123' },
    models: { groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' } },
  };
  const eng = groq.createEngine({ settings });
  assert.equal(eng.model, 'llama-3.3-70b-versatile');
});

test('groq configurableSettings include apiKey, fast model, smart model', () => {
  const fieldIds = groq.configurableSettings.map((f) => f.id);
  assert.ok(fieldIds.includes('apiKey'), 'has apiKey field');
  assert.ok(fieldIds.includes('fast'), 'has fast model field');
  assert.ok(fieldIds.includes('smart'), 'has smart model field');
});
