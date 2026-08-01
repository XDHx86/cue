const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalFasterWhisperSession, localLoadParams, PRE_SID_BYTES,
} = require('../src/stt-engine');

// ---- LocalFasterWhisperSession lifecycle over a fake manager ------------
// Exercises the start->load->stream_start->audio->close flow without spawning Python.
// The fake manager answers JSON-RPC calls with canned results and records notify()
// audio writes so we can assert the audio path goes fire-and-forget.

function fakeManager({ loadResult, startResult, cached = true, calls = [] }) {
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
      if (method === 'models_list') return { models: [{ name: params?.name || (params && params.name) || 'small', cached }], active: null, download_root: params && params.download_root };
      if (method === 'model_download') return { model: params.name };
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
  // call order: models_list (cache check) -> load(+setLastLoad) -> stream_start -> 3x on(...).
  // The cache check reports the model cached so model_download is SKIPPED (download decoupled
  // from load — D1). setLastLoad is interleaved between load and stream_start, so filter to calls.
  const rpc = calls.filter((c) => c[0] === 'call').map((c) => c[1]);
  const subs = calls.filter((c) => c[0] === 'on').map((c) => c[1]);
  assert.deepEqual(rpc, ['models_list', 'load', 'stream_start']);
  assert.deepEqual(subs, ['partial', 'final', 'status']);
  assert.equal(s.sid, '7');
  assert.ok(statuses.some((st) => st.active && st.provider === 'faster-whisper'), 'emitted active=true');
  // setLastLoad stored the load params so a re-start reuses them (no re-download)
  assert.equal(calls.find((c) => c[0] === 'setLastLoad')[1].name, 'small');
});

test('start() skips load when params match the last load (no re-download on every session)', async () => {
  const calls = [];
  const m = fakeManager({ calls });
  m.getLastLoad = () => ({ name: 'small', device: 'auto', compute_type: 'auto', language: null, vad: true, download_root: '/models', local_files_only: true });
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
    call: async (method, params) => {
      if (method === 'models_list') return { models: [{ name: params?.name || 'small', cached: true }] };
      if (method === 'model_download') return { model: params.name };
      return method === 'load' ? { model: 'small' } : { sid: '7' };
    },
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
  // a partial for THIS session -> fired; a partial for another sid -> ignored
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

// D1 — download is decoupled from load: when the model is NOT cached, start() downloads first
// (emitting progress on the host side) and only THEN loads. A cached model skips the download.
test('start() downloads the model before load when it is not cached (D1)', async () => {
  const calls = [];
  const m = fakeManager({ calls, cached: false });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: () => {},
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  await s.start();
  const rpc = calls.filter((c) => c[0] === 'call').map((c) => c[1]);
  // models_list reports not-cached -> model_download -> load (cache-only) -> stream_start
  assert.deepEqual(rpc, ['models_list', 'model_download', 'load', 'stream_start']);
  // load is cache-only (local_files_only) so it can never block on a silent network fetch
  const load = calls.find((c) => c[0] === 'call' && c[1] === 'load');
  assert.equal(load[2].local_files_only, true, 'load uses local_files_only after pre-download');
});

// D1 — a cached model skips the download entirely (the common path after first run).
test('start() skips model_download when the model is already cached (D1)', async () => {
  const calls = [];
  const m = fakeManager({ calls, cached: true });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: () => {},
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  await s.start();
  const rpc = calls.filter((c) => c[0] === 'call').map((c) => c[1]);
  assert.deepEqual(rpc, ['models_list', 'load', 'stream_start']);
  assert.ok(!rpc.includes('model_download'), 'no download when the model is cached');
});

// D2 — audio captured while `sid` is null (warm-up) is buffered in a bounded ring and flushed
// into the first stream_audio once stream_start returns a sid, so speech during a fast cached
// load isn't silently dropped.
test('sendAudio buffers PCM before sid is set and flushes it once start() completes (D2)', async () => {
  const calls = [];
  const m = fakeManager({ calls, cached: true });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: () => {},
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  // Warm-up: sid is null -> audio is buffered (no notify yet).
  s.sendAudio(Buffer.from([1, 2, 3, 4]));
  s.sendAudio(Buffer.from([5, 6, 7, 8]));
  assert.ok(!calls.some((c) => c[0] === 'notify' && c[1] === 'stream_audio'),
    'no stream_audio notify while sid is null');
  await s.start();
  assert.equal(s.sid, '7');
  // After start, the buffered PCM was flushed as ONE merged stream_audio notify.
  const audio = calls.filter((c) => c[0] === 'notify' && c[1] === 'stream_audio');
  assert.equal(audio.length, 1, 'buffered audio flushed as a single notify');
  assert.equal(audio[0][2].sid, '7');
  // And audio post-sid goes straight through (not buffered).
  s.sendAudio(Buffer.from([9, 10, 11, 12]));
  assert.equal(calls.filter((c) => c[0] === 'notify' && c[1] === 'stream_audio').length, 2);
});

// D2 — the pre-sid ring is bounded so a long first-download doesn't accumulate unbounded memory.
// Exercise _bufferPreSid directly with sid held null (no async warm-up needed): pump far more
// than PRE_SID_BYTES and assert the ring never materially exceeds the bound.
test('the pre-sid buffer is bounded (D2)', () => {
  assert.ok(PRE_SID_BYTES > 0, 'PRE_SID_BYTES is a positive bound');
  const calls = [];
  const m = fakeManager({ calls, cached: false });
  const s = new LocalFasterWhisperSession({
    manager: m, channel: 'you', onStatus: () => {},
    settings: { stt: { local: { model: 'small', vad: true } } },
  });
  // sid is null by construction -> sendAudio buffers into the bounded ring (no notify).
  const big = Buffer.alloc(PRE_SID_BYTES * 3, 7);
  for (let i = 0; i < big.length; i += 1024) s.sendAudio(big.subarray(i, i + 1024));
  let total = 0; for (const b of s._preSid) total += b.length;
  assert.ok(!calls.some((c) => c[0] === 'notify'), 'no notify while sid is null');
  assert.ok(total <= PRE_SID_BYTES + 1024, 'pre-sid ring bounded ≈ PRE_SID_BYTES (got ' + total + ')');
  s.close();
  assert.equal(s._preSid.length, 0, 'close() clears the pre-sid ring');
});
