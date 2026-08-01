// WebSocket transport for the external faster-whisper streaming server.
//
// cue is the WS *client*; you start the server (see docs/faster-whisper-setup.md). This module
// hand-rolls a minimal RFC 6455 WebSocket client over `net`/`tls`/`crypto` rather than pulling
// in the `ws` package — the same "dependency-free path" precedent as src/env.js (no native
// modules, no dep chain). Electron 43's Node is 20.x, which has no global `WebSocket` in main,
// so the hand-roll also removes any ambiguity about availability.
//
// A session sends a JSON handshake, then binary Int16 PCM frames; the server replies with text
// frames {"type":"partial"|"final","text","ts"}. It reconnects with exponential backoff and
// latches (onStatus inactive) after 3 consecutive connect failures so the pipeline degrades to
// batch instead of spinning forever.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { noopLogger } = require('../../../logger');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1, OP_BINARY = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;

function parseWsUrl(wsUrl) {
  const u = new URL(wsUrl);
  const secure = u.protocol === 'wss:';
  const port = u.port ? parseInt(u.port, 10) : (secure ? 443 : 80);
  return { secure, host: u.hostname, port, path: (u.pathname || '/') + (u.search || '') };
}

// 16 random bytes, base64 — the client side of the Sec-WebSocket-Key/Accept handshake.
function makeHandshakeKey() { return crypto.randomBytes(16).toString('base64'); }
function expectedAccept(key) { return crypto.createHash('sha1').update(key + WS_GUID).digest('base64'); }
function extractHeader(headerStr, name) {
  for (const line of headerStr.split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i).trim().toLowerCase() === name) return line.slice(i + 1).trim();
  }
  return null;
}

// Encode one frame (RFC 6455 section 5.2). `mask` should be true for client->server frames (the spec
// requires client masking); server->client frames are unmasked.
function encodeFrame(op, payload, mask) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;
  const maskKey = mask ? crypto.randomBytes(4) : null;
  const extLen = len < 126 ? 0 : (len < 65536 ? 2 : 8);
  const head = Buffer.alloc(2 + extLen + (mask ? 4 : 0));
  head[0] = 0x80 | (op & 0x0f); // FIN=1, RSV=0
  let p = 1;
  if (len < 126) {
    head[p++] = len | (mask ? 0x80 : 0);
  } else if (len < 65536) {
    head[p++] = 126 | (mask ? 0x80 : 0);
    head[p++] = (len >> 8) & 0xff; head[p++] = len & 0xff;
  } else {
    head[p++] = 127 | (mask ? 0x80 : 0);
    head.writeUInt32BE(0, p); p += 4;          // high 32 bits of length (0 for our sizes)
    head.writeUInt32BE(len, p); p += 4;         // low 32 bits
  }
  if (mask) head.set(maskKey, p);
  const out = Buffer.concat([head, payload]);
  if (mask) {
    const base = head.length;
    for (let i = 0; i < payload.length; i++) out[base + i] = payload[i] ^ maskKey[i % 4];
  }
  return out;
}

// Try to parse ONE frame from the front of `buf`. Returns {consumed, fin, op, payload} or
// {consumed: 0} if the buffer doesn't yet contain a whole frame. Handles both masked and
// unmasked frames (servers shouldn't mask, but some do). Payload is copied out so the caller
// is free to shrink its receive buffer.
function decodeFrame(buf) {
  if (buf.length < 2) return { consumed: 0 };
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const op = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let p = 2;
  if (len === 126) {
    if (buf.length < 4) return { consumed: 0 };
    len = buf.readUInt16BE(2); p = 4;
  } else if (len === 127) {
    if (buf.length < 10) return { consumed: 0 };
    len = buf.readUInt32BE(6); p = 10; // low 32 bits of the 64-bit length (frames are small)
  }
  let mask = null;
  if (masked) {
    if (buf.length < p + 4) return { consumed: 0 };
    mask = buf.subarray(p, p + 4); p += 4;
  }
  if (buf.length < p + len) return { consumed: 0 };
  let payload = buf.subarray(p, p + len);
  if (masked) {
    const um = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) um[i] = payload[i] ^ mask[i % 4];
    payload = um;
  } else {
    payload = Buffer.from(payload); // defensive copy
  }
  return { consumed: p + len, fin, op, payload };
}

// A single WebSocket connection (no auto-reconnect — the session owns reconnection). Events are
// delivered via the on* callbacks; `onMessage` fires once per text/binary frame with
// { op, payload } (payload is a Buffer). Close fires exactly once per connection lifecycle.
class WsClient {
  constructor({ url, onOpen, onMessage, onClose, onError, headers }) {
    this.parsed = parseWsUrl(url);
    this.onOpen = onOpen; this.onMessage = onMessage; this.onClose = onClose; this.onError = onError;
    this.headers = headers || {};
    this.sock = null; this.connected = false; this._key = null; this._rx = Buffer.alloc(0);
    this._closed = false;
  }

  connect() {
    const { secure, host, port } = this.parsed;
    const sock = secure
      ? tls.connect({ host, port, rejectUnauthorized: true })
      : net.connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('error', (e) => { if (this.onError) this.onError(e); });
    sock.on(secure ? 'secureConnect' : 'connect', () => this._handshake());
    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => this._fireClose());
  }

  _handshake() {
    const { host, port, path, secure } = this.parsed;
    const defaultPort = secure ? 443 : 80;
    const hostHeader = port && port !== defaultPort ? host + ':' + port : host;
    this._key = makeHandshakeKey();
    let req = 'GET ' + path + ' HTTP/1.1\r\n' +
      'Host: ' + hostHeader + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + this._key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n';
    // Add custom headers (e.g., Authorization for AssemblyAI)
    for (const [key, value] of Object.entries(this.headers)) {
      req += key + ': ' + value + '\r\n';
    }
    req += '\r\n';
    this.sock.write(req);
  }

  _onData(d) {
    this._rx = this._rx.length ? Buffer.concat([this._rx, d]) : d;
    if (!this.connected) {
      const idx = this._rx.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const headerStr = this._rx.subarray(0, idx).toString('utf8');
      const rest = this._rx.subarray(idx + 4);
      this._rx = Buffer.from(rest);
      const accept = extractHeader(headerStr, 'sec-websocket-accept');
      if (!/^HTTP\/1\.1 101/.test(headerStr) || accept !== expectedAccept(this._key)) {
        try { this.sock.destroy(); } catch {}
        if (this.onError) this.onError(new Error('bad websocket handshake'));
        return; // socket close will fire onClose
      }
      this.connected = true;
      if (this.onOpen) this.onOpen();
    }
    this._pump();
  }

  _pump() {
    let off = 0;
    while (true) {
      const f = decodeFrame(this._rx.subarray(off));
      if (f.consumed === 0) break;
      off += f.consumed;
      this._dispatch(f);
    }
    this._rx = off ? (off < this._rx.length ? Buffer.from(this._rx.subarray(off)) : Buffer.alloc(0)) : this._rx;
  }

  _dispatch(f) {
    switch (f.op) {
      case OP_TEXT:
      case OP_BINARY:
        if (this.onMessage) this.onMessage({ op: f.op, payload: f.payload });
        break;
      case OP_CLOSE:
        this._sendRaw(OP_CLOSE, Buffer.alloc(0)); // ack
        try { this.sock.end(); } catch {}
        break; // socket 'close' -> _fireClose
      case OP_PING:
        this._sendRaw(OP_PONG, f.payload);
        break;
      case OP_PONG:
        break;
    }
  }

  send(payload, binary) { if (this.connected) this._sendRaw(binary ? OP_BINARY : OP_TEXT, payload); }
  _sendRaw(op, payload) { if (this.sock && this.connected) this.sock.write(encodeFrame(op, payload, true)); }

  close() {
    if (this._closed) return;
    if (this.sock && this.connected) { this._sendRaw(OP_CLOSE, Buffer.alloc(0)); try { this.sock.end(); } catch {} }
    try { if (this.sock) this.sock.destroy(); } catch {}
    this._fireClose();
  }

  _fireClose() {
    if (this._closed) return;
    this._closed = true; this.connected = false;
    if (this.onClose) this.onClose();
  }
}

// One faster-whisper streaming session for a single audio channel (you OR them). Reconnects with
// exponential backoff; after 3 consecutive failures it latches and reports inactive so the
// capture pipeline can degrade that channel to the batch STT path.
class FasterWhisperStreamSession {
  constructor({ url, language, onFinal, onPartial, onError, onStatus, log, maxConnectFailures, maxBackoffMs }) {
    this.url = url;
    this.language = language === undefined ? null : language;
    this.onFinal = onFinal; this.onPartial = onPartial; this.onError = onError; this.onStatus = onStatus;
    this.log = log || noopLogger;
    this.ws = null;
    this.failCount = 0;
    this.userClosed = false;
    this.backoffTimer = null;
    this.maxConnectFailures = typeof maxConnectFailures === 'number' ? maxConnectFailures : 3;
    this.maxBackoffMs = typeof maxBackoffMs === 'number' ? maxBackoffMs : 8000;
  }

  start() {
    if (this.userClosed) return;
    this.log.debug({ url: this.url, language: this.language }, 'stream session connecting');
    const ws = new WsClient({
      url: this.url,
      onOpen: () => this._onOpen(),
      onMessage: (m) => this._onMessage(m),
      onClose: () => this._onClose(),
      onError: (e) => {
        this.log.error({ error: e && e.message }, 'stream session socket error');
        if (this.onError) this.onError(e);
      },
    });
    this.ws = ws;
    ws.connect();
  }

  _onOpen() {
    this.failCount = 0;
    this.log.info({ url: this.url, language: this.language }, 'stream session open');
    if (this.onStatus) this.onStatus({ active: true, provider: 'external-ws' });
    // Handshake: tell the server the audio format we will stream. Int16 mono @16kHz follows as
    // binary frames. language:null lets faster-whisper auto-detect.
    this.ws.send(Buffer.from(JSON.stringify({ sample_rate: 16000, channels: 1, language: this.language })), false);
  }

  _onMessage(m) {
    if (m.op !== OP_TEXT) return;
    let msg;
    try { msg = JSON.parse(m.payload.toString('utf8')); }
    catch { if (this.onError) this.onError(new Error('unparseable faster-whisper frame')); return; }
    const text = msg && typeof msg.text === 'string' ? msg.text : '';
    if (!text) return;
    const ts = msg.ts || Date.now();
    if (msg.type === 'final') { if (this.onFinal) this.onFinal({ text, ts }); }
    else if (msg.type === 'partial') { if (this.onPartial) this.onPartial({ text, ts }); }
  }

  _onClose() {
    if (this.userClosed) return;
    this.failCount++;
    if (this.failCount >= this.maxConnectFailures) {
      this.log.error({ attempts: this.failCount },
                     'stream session gave up after repeated connect failures; degrading to batch');
      if (this.onStatus) this.onStatus({ active: false, reason: 'faster-whisper unreachable after ' + this.maxConnectFailures + ' attempts' });
      return; // latch: stop reconnecting; main degrades this channel to batch
    }
    const delay = Math.min(1000 * Math.pow(2, this.failCount - 1), this.maxBackoffMs);
    this.log.warn({ attempts: this.failCount, delay }, 'stream session closed; reconnecting');
    this.backoffTimer = setTimeout(() => { this.backoffTimer = null; this.start(); }, delay);
  }

  sendAudio(int16Buffer) { if (this.ws && this.ws.connected) this.ws.send(int16Buffer, true); }

  close() {
    this.log.debug('stream session closing');
    this.userClosed = true;
    if (this.backoffTimer) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

module.exports = {
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader, parseWsUrl,
  WsClient, FasterWhisperStreamSession,
  OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG,
};
