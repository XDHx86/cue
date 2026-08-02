const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../src/registry');
const loader = require('../src/registry-loader');
loader.loadProviders({ _require: require });

const ollamaStt = registry.getProvider('stt', 'ollama');

// A manager stand-in matching the surface createEngine/createStreamSession touches.
function fakeManager({ venvReady = true, running = true } = {}) {
  const calls = [];
  return {
    calls,
    isVenvReady: () => venvReady,
    ensureRunning: async () => running,
    getModelsDir: () => '/models',
    getLastLoad: () => null,
    setLastLoad: (p) => { calls.push(['setLastLoad', p]); },
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'transcribe') return { text: 'hello' };
      if (method === 'load') return {};
      return {};
    },
  };
}

test('ollama STT provider is registered with correct metadata', () => {
  assert.ok(ollamaStt, 'ollama STT provider exists');
  assert.equal(ollamaStt.id, 'ollama');
  assert.equal(ollamaStt.providerType, 'stt');
  assert.equal(ollamaStt.displayName, 'Ollama STT (local)');
  assert.deepEqual(ollamaStt.capabilities.batch, { state: 'supported', source: 'declared' });
  assert.deepEqual(ollamaStt.capabilities.streaming, { state: 'supported', source: 'declared' });
  assert.deepEqual(ollamaStt.capabilities.local, { state: 'supported', source: 'declared' });
  assert.equal(ollamaStt.modelSettingsPath, null, 'no unique model slot — uses stt.local.*');
  assert.deepEqual(ollamaStt.configurableSettings, [], 'no unique settings');
});

test('createEngine is ready when manager is provided and venv is ready', () => {
  const mgr = fakeManager({ venvReady: true });
  const eng = ollamaStt.createEngine({ settings: { stt: { local: {} } }, manager: mgr });
  assert.equal(eng.ready, true);
  assert.equal(eng.provider, 'ollama');
  assert.equal(typeof eng.transcribe, 'function');
});

test('createEngine is not ready when manager is missing', () => {
  const eng = ollamaStt.createEngine({ settings: { stt: { local: {} } } });
  assert.equal(eng.ready, false);
});

test('createEngine is not ready when manager venv is not ready', () => {
  const mgr = fakeManager({ venvReady: false });
  const eng = ollamaStt.createEngine({ settings: { stt: { local: {} } }, manager: mgr });
  assert.equal(eng.ready, false);
});

test('transcribe delegates to the manager transcribe RPC', async () => {
  const mgr = fakeManager({ venvReady: true });
  const eng = ollamaStt.createEngine({ settings: { stt: { local: {} } }, manager: mgr });
  const result = await eng.transcribe(Buffer.alloc(4096));
  assert.equal(result, 'hello');
  assert.ok(mgr.calls.some((c) => c[0] === 'transcribe'), 'called transcribe RPC');
});

test('createStreamSession returns a session when manager is ready', () => {
  const mgr = fakeManager({ venvReady: true });
  const onFinal = () => {};
  const session = ollamaStt.createStreamSession({
    settings: { stt: { local: {} } }, manager: mgr, channel: 'you',
    language: null, onFinal, onPartial: () => {}, onError: () => {}, onStatus: () => {},
  });
  assert.ok(session, 'session created');
  assert.equal(typeof session.start, 'function');
  assert.equal(typeof session.close, 'function');
});

test('createStreamSession returns null when manager is missing', () => {
  const session = ollamaStt.createStreamSession({
    settings: { stt: { local: {} } }, channel: 'you',
    language: null, onFinal: () => {}, onPartial: () => {}, onError: () => {}, onStatus: () => {},
  });
  assert.equal(session, null);
});

test('streamingReady delegates to ctx.localReady', () => {
  assert.equal(ollamaStt.streamingReady({}, { localReady: true }), true);
  assert.equal(ollamaStt.streamingReady({}, { localReady: false }), false);
  assert.equal(ollamaStt.streamingReady({}, {}), false);
});
