const assert = require('node:assert/strict');
const test = require('node:test');

const { createSTT, transcribeFasterWhisperHTTP } = require('../src/stt');

test('createSTT puts faster-whisper first when configured, before cloud providers', () => {
  const stt = createSTT({
    apiKeys: { openai: 'k', gemini: 'g', deepgram: '', nvidia: '', anthropic: '', ollama: 'ollama' },
    stt: { provider: 'auto', fasterWhisperURL: 'ws://localhost:9080', model: 'whisper-1' },
  });
  assert.equal(stt.available, true);
  assert.deepEqual(stt.providers, ['faster-whisper', 'openai', 'gemini']);
});

test('createSTT without any STT path is unavailable', () => {
  const stt = createSTT({ apiKeys: { openai: '', gemini: '', deepgram: '' }, stt: { provider: 'auto' } });
  assert.equal(stt.available, false);
});

test('transcribeFasterWhisperHTTP converts ws:// to http://, POSTs the WAV, and trims the text', async () => {
  const orig = global.fetch;
  let called = null;
  global.fetch = async (url, opts) => {
    called = { url, opts };
    return { ok: true, json: async () => ({ text: '  hello there  ' }) };
  };
  try {
    const out = await transcribeFasterWhisperHTTP('ws://localhost:9080', Buffer.from([0x52, 0x49, 0x46, 0x46]));
    assert.equal(out, 'hello there', 'returned text is trimmed');
    assert.equal(called.url, 'http://localhost:9080/transcribe', 'ws:// rewrote to http://');
    assert.equal(called.opts.method, 'POST', 'POSTed the audio');
    assert.equal(called.opts.headers['content-type'], 'audio/wav');
    assert.ok(Buffer.isBuffer(called.opts.body), 'body is a Buffer (raw WAV bytes)');
  } finally {
    global.fetch = orig;
  }
});

test('transcribeFasterWhisperHTTP rewrites wss:// to https:// and strips a trailing slash', async () => {
  const orig = global.fetch;
  let called = null;
  global.fetch = async (url) => { called = { url }; return { ok: true, json: async () => ({ text: 'x' }) }; };
  try {
    await transcribeFasterWhisperHTTP('wss://host.example/', Buffer.alloc(4));
    assert.equal(called.url, 'https://host.example/transcribe');
  } finally {
    global.fetch = orig;
  }
});

test('transcribeFasterWhisperHTTP throws on a non-ok HTTP status', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(
      () => transcribeFasterWhisperHTTP('ws://localhost:9080', Buffer.alloc(4)),
      /faster-whisper HTTP 500/,
    );
  } finally {
    global.fetch = orig;
  }
});
