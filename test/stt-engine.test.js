const assert = require('node:assert/strict');
const test = require('node:test');

const {
  registerEngine, listEngines, hasEngine, createEngineSession, engineMeta,
  LocalFasterWhisperSession,
} = require('../src/stt-engine');

// ---- registry ----

test('faster-whisper is registered by default and listed', () => {
  assert.ok(hasEngine('faster-whisper'), 'the default engine self-registers on require');
  assert.ok(listEngines().includes('faster-whisper'));
  const meta = engineMeta();
  assert.ok(meta.find((m) => m.id === 'faster-whisper'));
});

test('registerEngine adds an engine and unregisterEngine removes it', () => {
  const off = registerEngine('test-engine', () => ({ ok: true }));
  assert.ok(hasEngine('test-engine'));
  assert.ok(listEngines().includes('test-engine'));
  off();
  assert.ok(!hasEngine('test-engine'));
  assert.ok(!listEngines().includes('test-engine'));
});

test('createEngineSession returns null for an unknown engine', () => {
  assert.equal(createEngineSession('nope', {}), null);
});

test("createEngineSession('faster-whisper') returns null when no manager is wired", () => {
  // No manager => the factory returns null so stt-stream degrades to batch — the
  // engine is unavailable, not an exception.
  assert.equal(createEngineSession('faster-whisper', {}), null);
});

test('registerEngine rejects a non-function factory', () => {
  assert.throws(() => registerEngine('bad', {}), /must be a function/);
});

// ---- LocalFasterWhisperSession lifecycle over a fake manager ------------
// Exercises the start→load→stream_start→audio→close flow without spawning Python.
// The fake manager answers JSON-RPC calls with canned results and records notify()
// audio writes so we can assert the audio path goes fire-and-forget.

function fakeManager({ loadResult, startResult, calls = [] }) {
  const cbs = {};
  return {
    calls,
    cbs, // tests fire these to simulate events from the process (partial/final/status)
    isVenvReady: () => true,
    ensureRunning: async () => true,
    getModelsDir: () => '/models',
    getLastLoad: () => null,
    setLastLoad: (p) => { calls.push(['setLastLoad', p]); },
    call: async (method, params) => {
      calls.push(['call', method, params]);
      if (method === 'load') return loadResult || { model: params.name };
      if (method === 'stream_start') return startResult || { sid: '7' };
      if (method === 'stream_stop') return {};
      throw new Error('unexpected call ' + method);
    },
    notify: (method, params) => { calls.push(['notify', method, params]); },
    on: (ev, cb) => { calls.push(['on', ev]); cbs[ev] = cb; return () => {}; },
  };
}

test('start() loads the model, opens a stream, subscribes, and emits active status', async () => {
  const calls = [];
  const m = fakeManager({ calls });
  const statuses = [];
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: (st) => statuses.push(st),
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  await s.start();
  // call order: load(+setLastLoad) → stream_start → 3× on(partial/final/status). setLastLoad
  // is interleaved between load and stream_start, so filter to the meaningful calls.
  const rpc = calls.filter((c) => c[0] === 'call').map((c) => c[1]);
  const subs = calls.filter((c) => c[0] === 'on').map((c) => c[1]);
  assert.deepEqual(rpc, ['load', 'stream_start']);
  assert.deepEqual(subs, ['partial', 'final', 'status']);
  assert.equal(s.sid, '7');
  assert.ok(statuses.some((st) => st.active && st.provider === 'faster-whisper'), 'emitted active=true');
  // setLastLoad stored the load params so a re-start reuses them (no re-download)
  assert.equal(calls.find((c) => c[0] === 'setLastLoad')[1].name, 'small');
});

test('start() skips load when params match the last load (no re-download on every session)', async () => {
  const calls = [];
  const m = fakeManager({ calls });
  m.getLastLoad = () => ({ name: 'small', device: 'auto', compute_type: 'auto', language: null, vad: true, download_root: '/models' });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: () => {},
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  await s.start();
  const seq = calls.map((c) => c[1]);
  assert.ok(!seq.includes('load'), 'load skipped because params matched lastLoad');
  assert.equal(seq[0], 'stream_start');
});

test('sendAudio notifies stream_audio fire-and-forget (no pending request)', () => {
  const calls = [];
  const m = fakeManager({ calls });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you',
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  s.sid = '7';
  s.sendAudio(Buffer.from([0, 1, 2, 3]));
  const n = calls.find((c) => c[0] === 'notify');
  assert.equal(n[1], 'stream_audio');
  assert.equal(n[2].sid, '7');
  assert.match(n[2].pcm_b64, /^[A-Za-z0-9+/]+={0,2}$/);
});

test('partial/final events demux by sid onto the session callbacks', async () => {
  const cbs = {};
  const calls = [];
  const m = {
    isVenvReady: () => true,
    ensureRunning: async () => true,
    getModelsDir: () => '/models', getLastLoad: () => null, setLastLoad: () => {},
    call: async (method) => (method === 'load' ? { model: 'small' } : { sid: '7' }),
    notify: () => {},
    on: (ev, cb) => { cbs[ev] = cb; return () => {}; },
  };
  const parts = [], fins = [], statuses = [];
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you',
    onPartial: (r) => parts.push(r), onFinal: (r) => fins.push(r), onStatus: (r) => statuses.push(r),
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  await s.start();
  // a partial for THIS session → fired; a partial for another sid → ignored
  cbs.partial({ sid: '7', text: 'hel' });
  cbs.partial({ sid: '99', text: 'other' });
  cbs.final({ sid: '7', text: 'hello' });
  assert.equal(parts.length, 1); assert.equal(parts[0].text, 'hel');
  assert.equal(fins.length, 1); assert.equal(fins[0].text, 'hello');
});

test('start() reports inactive when ensureRunning returns false', async () => {
  const m = {
    isVenvReady: () => true, ensureRunning: async () => false,
    getModelsDir: () => '/models', getLastLoad: () => null, setLastLoad: () => {},
    call: async () => { throw new Error('should not reach'); }, notify: () => {}, on: () => () => {},
  };
  const statuses = [];
  const s = new LocalFasterWhisperSession({ manager: m, channel: 'you', onStatus: (st) => statuses.push(st),
    settings: { stt: { local: { model: 'small', vad: true } } } });
  await s.start();
  assert.ok(statuses.some((st) => st.active === false));
});
