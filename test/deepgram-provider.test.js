// Deepgram streaming session + provider tests — WebSocket protocol.
// Exercises the session's state machine, reconnection, error handling, and protocol compliance.
// Pure Node (net + the framing helpers from external-ws). No electron import.
// Run: node --test test/deepgram-provider.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const {
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader,
  OP_TEXT, OP_BINARY,
} = require('../src/providers/stt/external-ws/session');
const { DeepgramStreamSession, DEEPGRAM_V1_URL } = require('../src/providers/stt/deepgram/session');
const { noopLogger } = require('../src/logger');

// ---------------------------------------------------------------------------
// Mock WS server: completes the handshake, optionally validates the Authorization
// header, then sends Deepgram protocol messages.
// ---------------------------------------------------------------------------
function mockDeepgramServer({ onAuth, messages, onClientFrame } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let rx = Buffer.alloc(0); let upgraded = false;
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        if (!upgraded) {
          const idx = rx.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const hs = rx.subarray(0, idx).toString('utf8');
          const key = extractHeader(hs, 'sec-websocket-key');
          const auth = extractHeader(hs, 'authorization');
          rx = Buffer.from(rx.subarray(idx + 4));
          if (onAuth) onAuth(auth);
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n'
          );
          upgraded = true;
          if (messages && messages.length) {
            for (const msg of messages) {
              socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(msg)), false));
            }
          }
        }
        let off = 0;
        while (true) {
          const f = decodeFrame(rx.subarray(off));
          if (!f.consumed) break;
          off += f.consumed;
          if (onClientFrame) onClientFrame(f);
        }
        rx = off < rx.length ? Buffer.from(rx.subarray(off)) : Buffer.alloc(0);
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function waitFor(condition, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(false), timeoutMs);
    const check = setInterval(() => {
      if (condition()) { clearTimeout(to); clearInterval(check); resolve(true); }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Protocol compliance
// ---------------------------------------------------------------------------
describe('Deepgram session — protocol compliance', () => {
  test('onStatus active fires immediately on connect (no Begin message needed)', async () => {
    const server = await mockDeepgramServer({ messages: [] });
    const port = server.address().port;
    const got = { status: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'test-key',
      url: 'ws://127.0.0.1:' + port + '/v1/listen',
      onStatus: (s) => got.status.push(s),
      log: noopLogger,
    });
    session.start();
    const ok = await waitFor(() => got.status.some((s) => s.active));
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(ok, 'onStatus active=true should fire on connect');
    assert.equal(got.status[0].active, true);
    assert.equal(got.status[0].provider, 'deepgram');
  });

  test('Authorization header is sent as Token <key>', async () => {
    let receivedAuth = null;
    const server = await mockDeepgramServer({
      onAuth: (auth) => { receivedAuth = auth; },
    });
    const port = server.address().port;
    const session = new DeepgramStreamSession({
      apiKey: 'dg_test-key-12345',
      url: 'ws://127.0.0.1:' + port,
      onStatus: () => {},
      log: noopLogger,
    });
    session.start();
    await waitFor(() => receivedAuth !== null);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(receivedAuth, 'Token dg_test-key-12345');
  });

  test('Results with is_final: true + transcript triggers onFinal', async () => {
    const server = await mockDeepgramServer({
      messages: [
        { type: 'Results', channel: { alternatives: [{ transcript: 'hello world', confidence: 0.98 }] }, is_final: true, speech_final: true },
      ],
    });
    const port = server.address().port;
    const got = { final: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.final[0].text, 'hello world');
  });

  test('Results with is_final: false triggers onPartial', async () => {
    const server = await mockDeepgramServer({
      messages: [
        { type: 'Results', channel: { alternatives: [{ transcript: 'hel' }] }, is_final: false },
      ],
    });
    const port = server.address().port;
    const got = { partial: [], final: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onPartial: (r) => got.partial.push(r), onFinal: (r) => got.final.push(r),
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.partial.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.partial[0].text, 'hel');
    assert.equal(got.final.length, 0);
  });

  test('Empty transcript is dropped', async () => {
    const server = await mockDeepgramServer({
      messages: [
        { type: 'Results', channel: { alternatives: [{ transcript: '' }] }, is_final: false },
        { type: 'Results', channel: { alternatives: [{ transcript: '' }] }, is_final: true },
      ],
    });
    const port = server.address().port;
    const got = { partial: [], final: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onPartial: (r) => got.partial.push(r), onFinal: (r) => got.final.push(r),
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await new Promise((r) => setTimeout(r, 200));
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.partial.length, 0, 'empty partial should be dropped');
    assert.equal(got.final.length, 0, 'empty final should be dropped');
  });

  test('KeepAlive is silently ignored', async () => {
    const server = await mockDeepgramServer({
      messages: [
        { type: 'KeepAlive' },
        { type: 'Results', channel: { alternatives: [{ transcript: 'after keepalive' }] }, is_final: true },
      ],
    });
    const port = server.address().port;
    const got = { final: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.final[0].text, 'after keepalive');
  });

  test('binary audio frames are sent as binary', async () => {
    const received = [];
    const server = await mockDeepgramServer({
      messages: [],
      onClientFrame: (f) => { if (f.op === OP_BINARY) received.push(f.payload); },
    });
    const port = server.address().port;
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => session.ws && session.ws.connected);
    const audio = Buffer.alloc(320); // 10ms at 16kHz
    audio.fill(42);
    session.sendAudio(audio);
    await waitFor(() => received.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(received.length > 0, 'should receive binary audio frame');
    assert.deepEqual(received[0], audio, 'binary frame content should match');
  });

  test('URL query params include encoding, sample_rate, interim_results, keepalive', async () => {
    let receivedUrl = '';
    const server = net.createServer((socket) => {
      let rx = Buffer.alloc(0);
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        const idx = rx.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const hs = rx.subarray(0, idx).toString('utf8');
        // Extract the GET path (first line)
        const firstLine = hs.split('\r\n')[0];
        receivedUrl = firstLine;
        const key = extractHeader(hs, 'sec-websocket-key');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n'
        );
      });
      socket.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port + '/v1/listen',
      model: 'nova-3', language: 'en', endpointingMs: 200, utteranceEndMs: 800,
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => receivedUrl.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(receivedUrl.includes('encoding=linear16'), 'should include encoding');
    assert.ok(receivedUrl.includes('sample_rate=16000'), 'should include sample_rate');
    assert.ok(receivedUrl.includes('interim_results=true'), 'should include interim_results');
    assert.ok(receivedUrl.includes('keepalive=true'), 'should include keepalive');
    assert.ok(receivedUrl.includes('model=nova-3'), 'should include model');
    assert.ok(receivedUrl.includes('language=en'), 'should include language');
    assert.ok(receivedUrl.includes('endpointing=200'), 'should include endpointing');
    assert.ok(receivedUrl.includes('utterance_end_ms=800'), 'should include utterance_end_ms');
  });
});

// ---------------------------------------------------------------------------
// Reconnect behavior
// ---------------------------------------------------------------------------
describe('Deepgram session — reconnect', () => {
  test('reconnects on unexpected close', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      let rx = Buffer.alloc(0);
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        const idx = rx.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const key = extractHeader(rx.subarray(0, idx).toString('utf8'), 'sec-websocket-key');
        rx = Buffer.from(rx.subarray(idx + 4));
        socket.write('HTTP/1.1 101\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n');
        setTimeout(() => { try { socket.destroy(); } catch {} }, 50);
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const got = { status: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      maxConnectFailures: 5, maxBackoffMs: 80,
      onStatus: (s) => got.status.push(s), log: noopLogger,
    });
    session.start();
    await waitFor(() => connections >= 2, 3000);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(connections >= 2, 'should reconnect after unexpected close, got ' + connections);
  });

  test('latches after maxConnectFailures', async () => {
    const badServer = net.createServer((socket) => { socket.destroy(); });
    await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
    const port = badServer.address().port;

    const got = { status: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      maxConnectFailures: 2, maxBackoffMs: 50,
      onStatus: (s) => got.status.push(s), log: noopLogger,
    });
    session.start();
    await waitFor(() => got.status.some((s) => !s.active && s.reason));
    session.close();
    badServer.close();
    await new Promise((r) => badServer.once('close', r));

    const latchStatus = got.status.find((s) => !s.active && s.reason);
    assert.ok(latchStatus, 'should fire onStatus with reason after latch');
    assert.ok(latchStatus.reason.includes('unreachable'), 'reason should mention unreachable');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe('Deepgram session — error handling', () => {
  test('malformed JSON is ignored (no crash, no reconnect)', async () => {
    const server = net.createServer((socket) => {
      let rx = Buffer.alloc(0);
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        const idx = rx.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const key = extractHeader(rx.subarray(0, idx).toString('utf8'), 'sec-websocket-key');
        rx = Buffer.from(rx.subarray(idx + 4));
        socket.write('HTTP/1.1 101\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n');
        socket.write(encodeFrame(OP_TEXT, Buffer.from('{broken json'), false));
        socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'fixed' }] }, is_final: true })), false));
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const got = { final: [], errors: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onError: (e) => got.errors.push(e),
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));

    assert.equal(got.errors.length, 0, 'malformed JSON should not trigger onError');
    assert.equal(got.final[0].text, 'fixed', 'valid message after malformed should work');
  });

  test('unknown message types are ignored', async () => {
    const server = await mockDeepgramServer({
      messages: [
        { type: 'FutureFeature', data: 'ignored' },
        { type: 'Results', channel: { alternatives: [{ transcript: 'works' }] }, is_final: true },
      ],
    });
    const port = server.address().port;
    const got = { final: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.final[0].text, 'works');
  });

  test('Error message triggers reconnect', async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      let rx = Buffer.alloc(0);
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        const idx = rx.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const key = extractHeader(rx.subarray(0, idx).toString('utf8'), 'sec-websocket-key');
        rx = Buffer.from(rx.subarray(idx + 4));
        socket.write('HTTP/1.1 101\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n');
        if (connections === 1) {
          // Send an error then close to trigger reconnect
          socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Error', description: 'temporary failure' })), false));
          setTimeout(() => { try { socket.destroy(); } catch {} }, 50);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const got = { errors: [] };
    const session = new DeepgramStreamSession({
      apiKey: 'k', url: 'ws://127.0.0.1:' + port,
      maxConnectFailures: 5, maxBackoffMs: 50,
      onError: (e) => got.errors.push(e), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => connections >= 2, 3000);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(got.errors.length > 0, 'should receive error');
    assert.ok(connections >= 2, 'should reconnect after error, got ' + connections);
  });
});

// ---------------------------------------------------------------------------
// Provider descriptor
// ---------------------------------------------------------------------------
describe('Deepgram provider — registration', () => {
  test('provider is registered with correct metadata', () => {
    const { getProvider } = require('../src/registry');
    require('../src/registry-loader').loadProviders({ _require: require });
    const desc = getProvider('stt', 'deepgram');
    assert.ok(desc, 'deepgram provider should be registered');
    assert.equal(desc.id, 'deepgram');
    assert.equal(desc.displayName, 'Deepgram');
    assert.equal(desc.providerType, 'stt');
    assert.equal(desc.order, 17);
    assert.deepEqual(desc.capabilities, { streaming: true, batch: true });
    assert.equal(typeof desc.createEngine, 'function');
    assert.equal(typeof desc.createStreamSession, 'function');
    assert.equal(typeof desc.streamingReady, 'function');
  });

  test('streamingReady requires apiKeys.deepgram', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'deepgram');
    assert.equal(desc.streamingReady({}), false, 'no settings → not ready');
    assert.equal(desc.streamingReady({ apiKeys: {} }), false, 'no deepgram key → not ready');
    assert.equal(desc.streamingReady({ apiKeys: { deepgram: '' } }), false, 'empty key → not ready');
    assert.equal(desc.streamingReady({ apiKeys: { deepgram: 'dg_abc' } }), true, 'key present → ready');
  });

  test('createEngine returns not-ready without API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'deepgram');
    const engine = desc.createEngine({ settings: {} });
    assert.equal(engine.provider, 'deepgram');
    assert.equal(engine.ready, false);
  });

  test('createEngine returns ready with API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'deepgram');
    const engine = desc.createEngine({ settings: { apiKeys: { deepgram: 'dg_test' }, stt: {} } });
    assert.equal(engine.provider, 'deepgram');
    assert.equal(engine.ready, true);
    assert.equal(typeof engine.transcribe, 'function');
  });

  test('createStreamSession returns null without API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'deepgram');
    const session = desc.createStreamSession({
      settings: { apiKeys: {} }, channel: 'you',
      onFinal: () => {}, onPartial: () => {}, onError: () => {}, onStatus: () => {},
      log: noopLogger,
    });
    assert.equal(session, null, 'should return null without API key');
  });

  test('createStreamSession returns a session with API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'deepgram');
    const session = desc.createStreamSession({
      settings: { apiKeys: { deepgram: 'test-key' }, stt: {} },
      channel: 'you',
      onFinal: () => {}, onPartial: () => {}, onError: () => {}, onStatus: () => {},
      log: noopLogger,
    });
    assert.ok(session, 'should return a session');
    assert.equal(typeof session.start, 'function');
    assert.equal(typeof session.sendAudio, 'function');
    assert.equal(typeof session.close, 'function');
  });

  test('Deepgram is in the streaming provider list in correct order', () => {
    const { listProviders } = require('../src/registry');
    const streaming = listProviders('stt').filter((p) => p.capabilities && p.capabilities.streaming);
    const ids = streaming.map((d) => d.id);
    // deepgram (17) should be after assemblyai (15) and before external-ws (40)
    const dgIdx = ids.indexOf('deepgram');
    const asmIdx = ids.indexOf('assemblyai');
    const extIdx = ids.indexOf('external-ws');
    assert.ok(dgIdx > asmIdx, 'deepgram should come after assemblyai');
    assert.ok(dgIdx < extIdx, 'deepgram should come before external-ws');
  });

  test('Deepgram is in the batch provider list in correct order', () => {
    const { listProviders } = require('../src/registry');
    const batch = listProviders('stt').filter((p) => p.capabilities && p.capabilities.batch);
    const ids = batch.map((d) => d.id);
    const dgIdx = ids.indexOf('deepgram');
    const oaiIdx = ids.indexOf('openai');
    assert.ok(dgIdx < oaiIdx, 'deepgram batch should come before openai batch');
  });
});
