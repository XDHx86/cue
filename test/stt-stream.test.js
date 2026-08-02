const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');

const {
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader, parseWsUrl,
  resolveProvider, createStreamSTT, OP_TEXT,
} = require('../src/stt-stream');

// ---- pure framing ----------------------------------------------------------

test('encodeFrame/decodeFrame round-trip a small masked text frame', () => {
  const frame = encodeFrame(OP_TEXT, Buffer.from('hi', 'utf8'), true);
  const f = decodeFrame(frame);
  assert.equal(f.consumed, frame.length, 'consumed == whole frame');
  assert.equal(f.fin, true);
  assert.equal(f.op, OP_TEXT);
  assert.equal(f.payload.toString('utf8'), 'hi');
});

test('masked payload is actually XOR-masked on the wire (not plaintext)', () => {
  const frame = encodeFrame(OP_TEXT, Buffer.from('secret'), true);
  // the payload bytes start after the 2-byte head + 4-byte mask key
  assert.ok(frame.length > 6);
  const onWire = frame.subarray(6).toString('utf8');
  assert.notEqual(onWire, 'secret', 'wire bytes must be masked, not plaintext');
});

test('decodeFrame handles the 126 length boundary (126-byte payload via 2-byte length)', () => {
  const big = Buffer.alloc(126, 0x41); // 'A'
  const frame = encodeFrame(OP_TEXT, big, true);
  assert.equal(frame[1] & 0x7f, 126, 'length uses the 2-byte extended form');
  const f = decodeFrame(frame);
  assert.equal(f.payload.length, 126);
  assert.equal(f.payload.toString(), 'A'.repeat(126));
});

test('decodeFrame handles the 127 length boundary (>65535 via 8-byte length)', () => {
  const big = Buffer.alloc(70000, 0x42); // 'B'
  const frame = encodeFrame(OP_TEXT, big, false);
  assert.equal(frame[1] & 0x7f, 127, 'length uses the 8-byte extended form');
  const f = decodeFrame(frame);
  assert.equal(f.payload.length, 70000);
  assert.equal(f.payload[0], 0x42);
});

test('decodeFrame returns consumed:0 on a partial buffer', () => {
  const frame = encodeFrame(OP_TEXT, Buffer.from('hello'), true);
  assert.equal(decodeFrame(frame.subarray(0, 2)).consumed, 0);
  assert.equal(decodeFrame(frame.subarray(0, frame.length - 1)).consumed, 0);
});

test('decodeFrame unmask: a server (unmasked) frame decodes too', () => {
  const frame = encodeFrame(OP_TEXT, Buffer.from('plain'), false); // mask=false
  const f = decodeFrame(frame);
  assert.equal(f.payload.toString('utf8'), 'plain');
});

// ---- handshake -------------------------------------------------------------

test('makeHandshakeKey/expectedAccept match the RFC 6455 magic GUID', () => {
  // RFC 6455 section 4.2.2 worked example: key "dGhlIHNhbXBsZSBub25jZQ==" -> accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  assert.equal(
    expectedAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

test('extractHeader finds a case-insensitive header value', () => {
  const hs = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: xyz\r\n\r\n';
  assert.equal(extractHeader(hs, 'sec-websocket-accept'), 'xyz');
  assert.equal(extractHeader(hs, 'upgrade'), 'websocket');
  assert.equal(extractHeader(hs, 'missing'), null);
});

// ---- parseWsUrl -----------------------------------------------------------

test('parseWsUrl splits ws:// and wss:// URLs with path and query', () => {
  const a = parseWsUrl('ws://localhost:9080/stream');
  assert.equal(a.secure, false); assert.equal(a.host, 'localhost'); assert.equal(a.port, 9080); assert.equal(a.path, '/stream');
  const b = parseWsUrl('wss://host/v1?token=t'); // wss with default port 443
  assert.equal(b.secure, true); assert.equal(b.host, 'host'); assert.equal(b.port, 443); assert.equal(b.path, '/v1?token=t');
  const c = parseWsUrl('ws://127.0.0.1:9080'); // no path -> "/"
  assert.equal(c.path, '/');
});

// ---- resolveProvider / createStreamSTT ------------------------------------

test('auto with no URL -> unavailable (batch fallback), provider null', () => {
  assert.deepEqual(resolveProvider({ stt: { provider: 'auto' } }), { provider: null, available: false });
});

test('auto with a URL (no local ready) -> external-ws available', () => {
  assert.deepEqual(
    resolveProvider({ stt: { provider: 'auto', fasterWhisperURL: 'ws://x:9' } }),
    { provider: 'external-ws', available: true },
  );
});

test("faster-whisper setting (force external WS) with no URL -> unavailable", () => {
  // 'faster-whisper' setting skips local providers and tries external-ws, which needs a URL.
  assert.deepEqual(
    resolveProvider({ stt: { provider: 'faster-whisper' } }),
    { provider: null, available: false },
  );
});

test('batch -> unavailable', () => {
  assert.deepEqual(resolveProvider({ stt: { provider: 'batch' } }), { provider: 'batch', available: false });
});

test("createStreamSTT returns null session for a non-streaming provider", () => {
  const s = createStreamSTT({ stt: { provider: 'batch' } });
  assert.equal(s.available, false);
  assert.equal(s.createSession(), null);
});

// ---- the managed local transport (src/stt-engine.js via a fake manager) ----

test("resolveProvider 'local' -> available iff the manager reports the venv ready", () => {
  // readiness is a hint passed in (not read from disk) so the resolver stays pure.
  assert.deepEqual(
    resolveProvider({ stt: { provider: 'local' } }, { localReady: true }),
    { provider: 'faster-whisper', available: true },
  );
  assert.deepEqual(
    resolveProvider({ stt: { provider: 'local' } }, { localReady: false }),
    { provider: null, available: false },
  );
});

test("resolveProvider 'auto' prefers the managed local engine when ready, before the external WS URL", () => {
  // localReady wins over a configured external URL — the managed engine is local-first.
  const withBoth = resolveProvider({ stt: { provider: 'auto', fasterWhisperURL: 'ws://x:9' } }, { localReady: true });
  assert.deepEqual(withBoth, { provider: 'faster-whisper', available: true });
  // without readiness, auto falls back to the external WS server.
  const withUrl = resolveProvider({ stt: { provider: 'auto', fasterWhisperURL: 'ws://x:9' } }, { localReady: false });
  assert.deepEqual(withUrl, { provider: 'external-ws', available: true });
});

test("auto with no URL and no readiness still -> null/batch (today's default behavior)", () => {
  assert.deepEqual(resolveProvider({ stt: { provider: 'auto' } }, { localReady: false }), { provider: null, available: false });
});

test("createStreamSTT 'local' builds an engine session via the wired manager; null without one", () => {
  const s = createStreamSTT(
    { stt: { provider: 'local', engine: 'faster-whisper', local: { model: 'small', vad: true } } },
    { localEngineManager: { isVenvReady: () => true } },
  );
  assert.equal(s.available, true);
  assert.equal(s.provider, 'faster-whisper');
  const ses = s.createSession({ channel: 'you', onStatus: () => {}, onError: () => {} });
  assert.ok(ses && typeof ses.start === 'function' && typeof ses.sendAudio === 'function', 'a streaming session');
  // With no manager wired in, the local engine degrades to null (-> batch in main).
  const s2 = createStreamSTT(
    { stt: { provider: 'local', engine: 'faster-whisper', local: { model: 'small' } } },
    { localEngineManager: { isVenvReady: () => false } },
  );
  assert.equal(s2.available, false);
  assert.equal(s2.createSession({ channel: 'you' }), null);
});

// ---- integration: a real loopback WS server + a faster-whisper session ----

// A minimal WS server built on net + the exported framing helpers. It completes the handshake,
// then immediately streams a partial and a final text frame to the client (the protocol cue's
// session listens for). This exercises encodeFrame/decodeFrame + WsClient + the session's
// JSON-dispatch path end to end.
function loopbackServer() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let rx = Buffer.alloc(0); let upgraded = false;
      socket.on('data', (d) => {
        rx = Buffer.concat([rx, d]);
        if (!upgraded) {
          const idx = rx.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const hs = rx.subarray(0, idx).toString('utf8');
          const key = extractHeader(hs, 'sec-websocket-key');
          rx = Buffer.from(rx.subarray(idx + 4));
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + expectedAccept(key) + '\r\n\r\n'
          );
          upgraded = true;
          socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'partial', text: 'hel', ts: 10 })), false));
          socket.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify({ type: 'final', text: 'hello world', ts: 20 })), false));
        }
        // drain any binary audio frames the client sends (content ignored)
        let off = 0;
        while (true) { const f = decodeFrame(rx.subarray(off)); if (!f.consumed) break; off += f.consumed; }
        rx = off < rx.length ? Buffer.from(rx.subarray(off)) : Buffer.alloc(0);
      });
      socket.on('error', () => {});
    });
    // Expose tracked sockets so tests can force-destroy before server.close() (Node has no
    // public closeAllConnections in this version; destroying ensures the server's close event
    // fires promptly without relying on the client to cleanly tear down).
    server._destroySockets = () => { for (const s of sockets) { try { s.destroy(); } catch {} } };
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('session handshake -> live partial + final frames round-trip over a real socket', async () => {
  const server = await loopbackServer();
  const port = server.address().port;
  const got = { partial: [], final: [], status: [] };

  const session = createStreamSTT({ stt: { provider: 'auto', fasterWhisperURL: 'ws://127.0.0.1:' + port + '/stream' } })
    .createSession({ channel: 'you', onFinal: (r) => got.final.push(r), onPartial: (r) => got.partial.push(r), onStatus: (s) => got.status.push(s), onError: () => {} });

  session.start();

  // Wait for a finalized transcript (up to 2 s), with both timers always cleared on exit so the
  // process doesn't hang on a leaked interval.
  let poll, guard;
  await new Promise((resolve) => {
    guard = setTimeout(() => { clearInterval(poll); resolve(); }, 2000);
    poll = setInterval(() => {
      if (got.final.length > 0) { clearTimeout(guard); clearInterval(poll); resolve(); }
    }, 10);
  });

  // Tear down: close the WS session (destroys the client socket), then force-destroy any
  // sockets the server still holds so net.Server.close() fires its callback promptly.
  session.close();
  server._destroySockets();
  server.close();
  await new Promise((r) => server.once('close', r));

  assert.equal(got.status.filter((s) => s.active).length, 1, 'onStatus active=true fired once on connect');
  assert.equal(got.partial[0] && got.partial[0].text, 'hel');
  assert.equal(got.partial[0] && got.partial[0].ts, 10);
  assert.equal(got.final[0] && got.final[0].text, 'hello world');
  assert.equal(got.final[0] && got.final[0].ts, 20);
});
