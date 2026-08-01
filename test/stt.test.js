const assert = require('node:assert/strict');
const test = require('node:test');

const { createSTT } = require('../src/stt');
const { localLoadParams } = require('../src/stt-engine');

// A manager stand-in exposing just the surface createSTT's faster-whisper provider
// touches: isVenvReady (registration gate), ensureRunning, getModelsDir,
// getLastLoad/setLastLoad (model-loaded tracking), and call (JSON-RPC). Records every
// call so tests assert method/params. No Electron, no spawn — the param-injection
// invariant (.claude/docs/conventions.md).
function fakeManager({ venvReady = true, running = true, lastLoad = null, transcribeText = ' hello there ' } = {}) {
  const calls = [];
  let _lastLoad = lastLoad;
  return {
    calls,
    isVenvReady: () => venvReady,
    ensureRunning: async () => running,
    getModelsDir: () => '/models',
    getLastLoad: () => _lastLoad,
    setLastLoad: (p) => { calls.push(['setLastLoad', p]); _lastLoad = p; },
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'transcribe') return { text: transcribeText };
      if (method === 'load') return { model: params.name, device: params.device, compute_type: params.compute_type };
      return {};
    },
  };
}

test('createSTT puts faster-whisper first when the manager is ready, before cloud providers', () => {
  const stt = createSTT(
    { apiKeys: { openai: 'k', gemini: 'g' }, stt: { local: {} } },
    { manager: fakeManager() },
  );
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['faster-whisper', 'openai', 'gemini']);
});

test('createSTT omits faster-whisper when no manager is wired (cloud-only)', () => {
  const stt = createSTT({ apiKeys: { openai: 'k', gemini: 'g' }, stt: {} });
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['openai', 'gemini']);
});

test('createSTT omits faster-whisper when the managed venv is not ready yet', () => {
  const stt = createSTT(
    { apiKeys: { openai: 'k' }, stt: { local: {} } },
    { manager: fakeManager({ venvReady: false }) },
  );
  assert.deepEqual(stt.providers, ['openai']);
});

test('createSTT without any STT path is unavailable', () => {
  const stt = createSTT({ apiKeys: { openai: '', gemini: '' }, stt: {} });
  assert.equal(stt.available, false);
});

test('transcribe goes straight to the RPC transcribe when the model is already loaded', async () => {
  // lastLoad == exactly what localLoadParams produces → no load, just transcribe.
  const lastLoad = localLoadParams({ stt: { local: { model: 'small' } } }, { getModelsDir: () => '/models' }, null);
  const m = fakeManager({ lastLoad });
  const stt = createSTT({ apiKeys: {}, stt: { local: { model: 'small' } } }, { manager: m });

  const res = await stt.transcribe(Buffer.alloc(4096));

  assert.equal(res.text, 'hello there'); // trimmed
  assert.equal(res.provider, 'faster-whisper');
  assert.ok(!m.calls.some((c) => c[0] === 'load'), 'did not re-load an already-loaded model');
  const t = m.calls.find((c) => c[0] === 'transcribe');
  assert.ok(t, 'called transcribe');
  // wav_b64 base64-decodes to a 44-byte-header RIFF WAV wrapping the 4096-byte PCM.
  const wav = Buffer.from(t[1].wav_b64, 'base64');
  assert.equal(wav.slice(0, 4).toString(), 'RIFF');
  assert.equal(wav.length, 44 + 4096);
  assert.equal(t[1].language, null, 'null language → Python auto-detect (matches streaming)');
});

test('transcribe loads the cache-only model first when getLastLoad is null, then transcribes', async () => {
  const m = fakeManager({ lastLoad: null });
  const stt = createSTT({ apiKeys: {}, stt: { local: { model: 'small' } } }, { manager: m });

  const res = await stt.transcribe(Buffer.alloc(4096));

  assert.equal(res.provider, 'faster-whisper');
  const load = m.calls.find((c) => c[0] === 'load');
  assert.ok(load, 'loaded the model');
  assert.equal(load[1].local_files_only, true, 'load is cache-only (no silent download in batch)');
  assert.equal(load[1].name, 'small');
  assert.ok(m.calls.some((c) => c[0] === 'setLastLoad'), 'remembered the load for next time');
  assert.ok(m.calls.some((c) => c[0] === 'transcribe'), 'then transcribed');
});

test('transcribe returns an error (no cloud fallback) when the local provider throws', async () => {
  const m = fakeManager();
  m.call = async () => { throw new Error('rpc boom'); };
  const stt = createSTT({ apiKeys: {}, stt: { local: {} } }, { manager: m });

  const res = await stt.transcribe(Buffer.alloc(4096));

  assert.equal(res.text, '');
  assert.equal(res.error.provider, 'faster-whisper');
  assert.match(res.error.message, /rpc boom/);
});

test('createSTT logs the registered providers at debug', () => {
  const recs = [];
  const logger = { child() { return logger; }, debug: (o, m) => recs.push([m, o]),
    trace() {}, info() {}, warn() {}, error() {}, fatal() {} };
  const stt = createSTT({ apiKeys: { openai: 'k' }, stt: {} }, { logger });
  assert.deepEqual(stt.providers, ['openai']);
  const reg = recs.find(([m]) => m === 'STT providers registered');
  assert.ok(reg, 'emitted a registration log line');
  assert.deepEqual(reg[1].providers, ['openai']);
});
