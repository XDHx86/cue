// AssemblyAI streaming session + provider tests — v3 protocol.
// Exercises the session's state machine, reconnection, error handling, and protocol compliance.
// Pure Node (net + the framing helpers from external-ws). No electron import.
// Run: node --test test/assemblyai-provider.test.js

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const {
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader,
  OP_TEXT, OP_BINARY,
} = require('../src/providers/stt/external-ws/session');
const { AssemblyAIStreamSession, ASSEMBLYAI_V3_URL } = require('../src/providers/stt/assemblyai/session');
const { noopLogger } = require('../src/logger');

// ---------------------------------------------------------------------------
// Mock WS server: completes the handshake, optionally validates the Authorization
// header, then sends AssemblyAI v3 protocol messages.
// ---------------------------------------------------------------------------
function mockAssemblyAIServer({ onAuth, messages, onClientFrame } = {}) {
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
          // Validate auth if callback provided
          if (onAuth) onAuth(auth);
          // Complete handshake
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n'
          );
          upgraded = true;
          // Send queued messages
          if (messages && messages.length) {
            for (const msg of messages) {
              socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(msg)), false));
            }
          }
        }
        // Decode client frames (binary audio or text control messages)
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
describe('AssemblyAI session — protocol compliance', () => {
  test('Begin message triggers onStatus active', async () => {
    const server = await mockAssemblyAIServer({
      messages: [{ type: 'Begin', id: 'sess-1', expires_at: '2099-01-01' }],
    });
    const port = server.address().port;
    const got = { status: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'test-key',
      realtimeUrl: 'ws://127.0.0.1:' + port + '/v3/ws',
      onStatus: (s) => got.status.push(s),
      log: noopLogger,
    });
    session.start();
    const ok = await waitFor(() => got.status.some((s) => s.active));
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(ok, 'onStatus active=true should fire');
    assert.equal(got.status[0].active, true);
    assert.equal(got.status[0].provider, 'assemblyai');
  });

  test('Authorization header is sent', async () => {
    let receivedAuth = null;
    const server = await mockAssemblyAIServer({
      onAuth: (auth) => { receivedAuth = auth; },
      messages: [{ type: 'Begin', id: 'sess-auth' }],
    });
    const port = server.address().port;
    const session = new AssemblyAIStreamSession({
      apiKey: 'my-secret-key',
      realtimeUrl: 'ws://127.0.0.1:' + port + '/v3/ws',
      onStatus: () => {},
      log: noopLogger,
    });
    session.start();
    await waitFor(() => receivedAuth !== null);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(receivedAuth, 'my-secret-key');
  });

  test('Turn partial (end_of_turn: false) triggers onPartial', async () => {
    const server = await mockAssemblyAIServer({
      messages: [
        { type: 'Begin', id: 's' },
        { type: 'Turn', end_of_turn: false, transcript: 'hel' },
      ],
    });
    const port = server.address().port;
    const got = { partial: [], final: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
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

  test('Turn final (end_of_turn: true) triggers onFinal', async () => {
    const server = await mockAssemblyAIServer({
      messages: [
        { type: 'Begin', id: 's' },
        { type: 'Turn', end_of_turn: true, transcript: 'hello world' },
      ],
    });
    const port = server.address().port;
    const got = { final: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.final[0].text, 'hello world');
  });

  test('Empty transcript is dropped', async () => {
    const server = await mockAssemblyAIServer({
      messages: [
        { type: 'Begin', id: 's' },
        { type: 'Turn', end_of_turn: false, transcript: '' },
        { type: 'Turn', end_of_turn: true, transcript: '' },
      ],
    });
    const port = server.address().port;
    const got = { partial: [], final: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
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

  test('close() sends Terminate', async () => {
    const received = [];
    const server = await mockAssemblyAIServer({
      messages: [{ type: 'Begin', id: 's' }],
      onClientFrame: (f) => { if (f.op === OP_TEXT) received.push(f.payload.toString('utf8')); },
    });
    const port = server.address().port;
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
      onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => received.length > 0 || session.ws?.connected);
    // Wait for ws to connect
    await waitFor(() => session.ws && session.ws.connected);
    session.close();
    await new Promise((r) => setTimeout(r, 200));
    server.close();
    await new Promise((r) => server.once('close', r));
    const terminateFrame = received.find((f) => f.includes('Terminate'));
    assert.ok(terminateFrame, 'should send Terminate frame');
  });

  test('binary audio frames are sent as binary', async () => {
    const received = [];
    const server = await mockAssemblyAIServer({
      messages: [{ type: 'Begin', id: 's' }],
      onClientFrame: (f) => { if (f.op === OP_BINARY) received.push(f.payload); },
    });
    const port = server.address().port;
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
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
});

// ---------------------------------------------------------------------------
// Reconnect behavior
// ---------------------------------------------------------------------------
describe('AssemblyAI session — reconnect', () => {
  test('reconnects on unexpected close', async () => {
    // Server that handles multiple connections (each gets Begin). We track how many
    // distinct connection handlers have been created.
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
        // Send Begin, then destroy the socket after a short delay to simulate unexpected close
        socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Begin', id: 's-' + connections })), false));
        setTimeout(() => { try { socket.destroy(); } catch {} }, 50);
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const got = { status: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
      maxConnectFailures: 5, maxBackoffMs: 80,
      onStatus: (s) => got.status.push(s), log: noopLogger,
    });
    session.start();
    // Wait for at least 2 connections (initial + reconnect)
    await waitFor(() => connections >= 2, 3000);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.ok(connections >= 2, 'should reconnect after unexpected close, got ' + connections + ' connections');
  });

  test('latches after maxConnectFailures', async () => {
    // Server that immediately destroys connections (simulates persistent failure)
    const badServer = net.createServer((socket) => { socket.destroy(); });
    await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
    const port = badServer.address().port;

    const got = { status: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
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
describe('AssemblyAI session — error handling', () => {
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
        // Send malformed JSON then a valid message
        socket.write(encodeFrame(OP_TEXT, Buffer.from('{broken json'), false));
        socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Turn', end_of_turn: true, transcript: 'fixed' })), false));
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const got = { final: [], errors: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
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
    const server = await mockAssemblyAIServer({
      messages: [
        { type: 'Begin', id: 's' },
        { type: 'FutureFeature', data: 'ignored' },
        { type: 'Turn', end_of_turn: true, transcript: 'works' },
      ],
    });
    const port = server.address().port;
    const got = { final: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
      onFinal: (r) => got.final.push(r), onStatus: () => {}, log: noopLogger,
    });
    session.start();
    await waitFor(() => got.final.length > 0);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    assert.equal(got.final[0].text, 'works');
  });

  test('server Termination triggers reconnect', async () => {
    // Multi-connection server: FIRST connection gets Begin + Termination (triggering reconnect),
    // subsequent connections only get Begin (stable session).
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
        socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Begin', id: 's' + connections })), false));
        // Only first connection sends Termination to trigger reconnect
        if (connections === 1) {
          setTimeout(() => {
            socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'Termination', audio_duration_seconds: 0.1 })), false));
          }, 30);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const got = { status: [] };
    const session = new AssemblyAIStreamSession({
      apiKey: 'k', realtimeUrl: 'ws://127.0.0.1:' + port,
      maxConnectFailures: 5, maxBackoffMs: 50,
      onStatus: (s) => got.status.push(s), log: noopLogger,
    });
    session.start();
    // Wait for multiple connections (initial + reconnect after Termination)
    await waitFor(() => connections >= 2, 3000);
    session.close();
    server.close();
    await new Promise((r) => server.once('close', r));
    const activeCount = got.status.filter((s) => s.active).length;
    assert.ok(activeCount >= 2, 'should reconnect after server Termination, got ' + activeCount + ' active events');
  });
});

// ---------------------------------------------------------------------------
// Provider descriptor
// ---------------------------------------------------------------------------
describe('AssemblyAI provider — registration', () => {
  test('provider is registered with correct metadata', () => {
    const { listProviders, getProvider } = require('../src/registry');
    require('../src/registry-loader').loadProviders({ _require: require });
    const desc = getProvider('stt', 'assemblyai');
    assert.ok(desc, 'assemblyai provider should be registered');
    assert.equal(desc.id, 'assemblyai');
    assert.equal(desc.displayName, 'AssemblyAI');
    assert.equal(desc.providerType, 'stt');
    assert.equal(desc.order, 15);
    assert.deepEqual(desc.capabilities, { streaming: true, batch: false });
    assert.equal(typeof desc.createEngine, 'function');
    assert.equal(typeof desc.createStreamSession, 'function');
    assert.equal(typeof desc.streamingReady, 'function');
  });

  test('streamingReady requires apiKeys.assemblyai', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'assemblyai');
    assert.equal(desc.streamingReady({}), false, 'no settings → not ready');
    assert.equal(desc.streamingReady({ apiKeys: {} }), false, 'no assemblyai key → not ready');
    assert.equal(desc.streamingReady({ apiKeys: { assemblyai: '' } }), false, 'empty key → not ready');
    assert.equal(desc.streamingReady({ apiKeys: { assemblyai: 'sk-abc' } }), true, 'key present → ready');
  });

  test('createEngine returns not-ready (batch not supported)', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'assemblyai');
    const engine = desc.createEngine({ settings: {} });
    assert.equal(engine.provider, 'assemblyai');
    assert.equal(engine.ready, false);
  });

  test('createStreamSession returns null without API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'assemblyai');
    const session = desc.createStreamSession({
      settings: { apiKeys: {} }, channel: 'you',
      onFinal: () => {}, onPartial: () => {}, onError: () => {}, onStatus: () => {},
      log: noopLogger,
    });
    assert.equal(session, null, 'should return null without API key');
  });

  test('createStreamSession returns a session with API key', () => {
    const { getProvider } = require('../src/registry');
    const desc = getProvider('stt', 'assemblyai');
    const session = desc.createStreamSession({
      settings: { apiKeys: { assemblyai: 'test-key' }, stt: {} },
      channel: 'you',
      onFinal: () => {}, onPartial: () => {}, onError: () => {}, onStatus: () => {},
      log: noopLogger,
    });
    assert.ok(session, 'should return a session');
    assert.equal(typeof session.start, 'function');
    assert.equal(typeof session.sendAudio, 'function');
    assert.equal(typeof session.close, 'function');
  });

  test('AssemblyAI is in the streaming provider list in correct order', () => {
    const { listProviders } = require('../src/registry');
    require('../src/registry-loader').loadProviders({ _require: require });
    const streaming = listProviders('stt').filter((p) => p.capabilities && p.capabilities.streaming);
    const ids = streaming.map((d) => d.id);
    // assemblyai (15) should be after faster-whisper (10) and before external-ws (40)
    const asmIdx = ids.indexOf('assemblyai');
    const fwIdx = ids.indexOf('faster-whisper');
    const extIdx = ids.indexOf('external-ws');
    assert.ok(asmIdx > fwIdx, 'assemblyai should come after faster-whisper');
    assert.ok(asmIdx < extIdx, 'assemblyai should come before external-ws');
  });
});
