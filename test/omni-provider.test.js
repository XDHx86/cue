const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../src/registry');
const loader = require('../src/registry-loader');
const localHealth = require('../src/providers/local-health');
loader.loadProviders({ _require: require });

test.afterEach(() => { localHealth._resetCache(); });

const omniLlm = registry.getProvider('llm', 'omni');
const omniStt = registry.getProvider('stt', 'omni');

// --- LLM ---

test('omni LLM provider is registered with correct metadata', () => {
  assert.ok(omniLlm, 'omni LLM provider exists');
  assert.equal(omniLlm.id, 'omni');
  assert.equal(omniLlm.providerType, 'llm');
  assert.equal(omniLlm.displayName, 'OmniRoute (local)');
  assert.deepEqual(omniLlm.capabilities.streaming, { state: 'supported', source: 'declared' });
  assert.deepEqual(omniLlm.capabilities.vision, { state: 'supported', source: 'declared' });
});

test('omni LLM engine is not ready without health check (cold cache)', () => {
  const settings = {
    smart: false,
    apiKeys: { omni: 'omniroute' },
    models: { omni: { fast: 'auto', smart: 'auto' } },
    omniroute: { baseURL: '' },
  };
  const eng = omniLlm.createEngine({ settings });
  assert.equal(eng.ready, false, 'not ready when health cache is cold');
  assert.equal(eng.provider, 'omni');
  assert.equal(eng.model, 'auto');
  assert.equal(typeof eng.stream, 'function');
});

test('omni LLM engine is ready after health check succeeds', async () => {
  const http = require('http');
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await localHealth.checkAll({ omniroute: { baseURL: `http://127.0.0.1:${port}/v1` } });
    const settings = {
      smart: false,
      apiKeys: { omni: 'omniroute' },
      models: { omni: { fast: 'auto', smart: 'auto' } },
      omniroute: { baseURL: `http://127.0.0.1:${port}/v1` },
    };
    const eng = omniLlm.createEngine({ settings });
    assert.equal(eng.ready, true, 'ready after health check');
  } finally { server.close(); }
});

test('omni LLM configurableSettings include fast, smart, baseURL', () => {
  const fieldIds = omniLlm.configurableSettings.map((f) => f.id);
  assert.ok(fieldIds.includes('fast'), 'has fast model field');
  assert.ok(fieldIds.includes('smart'), 'has smart model field');
  assert.ok(fieldIds.includes('baseURL'), 'has baseURL field');
  assert.ok(!fieldIds.includes('apiKey'), 'no apiKey field (sentinel, no key needed)');
});

// --- STT ---

test('omni STT provider is registered with correct metadata', () => {
  assert.ok(omniStt, 'omni STT provider exists');
  assert.equal(omniStt.id, 'omni');
  assert.equal(omniStt.providerType, 'stt');
  assert.equal(omniStt.displayName, 'OmniRoute STT (local)');
  assert.deepEqual(omniStt.capabilities.batch, { state: 'supported', source: 'declared' });
  assert.deepEqual(omniStt.capabilities.streaming, { state: 'unsupported', source: 'declared' });
});

test('omni STT engine is not ready without health check (cold cache)', () => {
  const settings = {
    apiKeys: { omni: 'omniroute' },
    stt: { omniModel: 'whisper-large-v3-turbo' },
    omniroute: { baseURL: '' },
  };
  const eng = omniStt.createEngine({ settings });
  assert.equal(eng.ready, false, 'not ready when health cache is cold');
  assert.equal(eng.provider, 'omni');
  assert.equal(typeof eng.transcribe, 'function');
});

test('omni STT engine is ready after health check succeeds', async () => {
  const http = require('http');
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await localHealth.checkAll({ omniroute: { baseURL: `http://127.0.0.1:${port}/v1` } });
    const settings = {
      stt: { omniModel: 'whisper-large-v3-turbo' },
      omniroute: { baseURL: `http://127.0.0.1:${port}/v1` },
    };
    const eng = omniStt.createEngine({ settings });
    assert.equal(eng.ready, true, 'ready after health check');
  } finally { server.close(); }
});

test('omni STT modelSettingsPath is stt.omniModel', () => {
  assert.equal(omniStt.modelSettingsPath, 'stt.omniModel');
});
