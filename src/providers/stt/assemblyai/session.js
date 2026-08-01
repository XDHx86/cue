// AssemblyAI real-time streaming session — v3 WebSocket protocol.
//
// Uses the WsClient from ../external-ws/session.js (hand-rolled RFC 6455 over net/tls)
// with custom Authorization header for API key auth. The AssemblyAI v3 protocol sends
// audio config as URL query params (not a JSON handshake), streams raw Int16 PCM as
// binary frames (~50ms chunks), and receives structured JSON messages.
//
// Protocol reference: AssemblyAI Streaming API v3 (endpoint wss://streaming.assemblyai.com/v3/ws)
// SDK reference (NOT used — hand-rolled for dependency-free path): assemblyai npm v4.36.4
// Verified: 2026-08-01

const { WsClient, OP_TEXT, OP_BINARY } = require('../external-ws/session');
const { noopLogger } = require('../../../logger');

const ASSEMBLYAI_V3_URL = 'wss://streaming.assemblyai.com/v3/ws';

// Fatal error codes that should NOT trigger reconnection (from SDK source: error codes 1008/1009)
const FATAL_ERROR_CODES = new Set([1008, 1009]);

class AssemblyAIStreamSession {
  constructor({ apiKey, realtimeUrl, language, wordBoost, speechModel,
                onFinal, onPartial, onError, onStatus, log,
                maxConnectFailures, maxBackoffMs }) {
    this.apiKey = apiKey;
    this.url = (realtimeUrl || ASSEMBLYAI_V3_URL);
    this.language = language || null;
    this.wordBoost = wordBoost || '';
    this.speechModel = speechModel || '';
    this.onFinal = onFinal;
    this.onPartial = onPartial;
    this.onError = onError;
    this.onStatus = onStatus;
    this.log = log || noopLogger;
    this.ws = null;
    this.failCount = 0;
    this.userClosed = false;
    this.backoffTimer = null;
    this.sessionId = null;
    this._reconnectPending = false; // guard against double-scheduling (Termination + socket close)
    this.maxConnectFailures = typeof maxConnectFailures === 'number' ? maxConnectFailures : 3;
    this.maxBackoffMs = typeof maxBackoffMs === 'number' ? maxBackoffMs : 8000;
  }

  // Build the full connection URL with query parameters.
  _buildUrl() {
    const u = new URL(this.url);
    u.searchParams.set('sample_rate', '16000');
    if (this.speechModel) u.searchParams.set('speech_model', this.speechModel);
    if (this.language) u.searchParams.set('language_code', this.language);
    u.searchParams.set('mode', 'balanced');
    return u.toString();
  }

  start() {
    if (this.userClosed) return;
    this._reconnectPending = false; // clear guard so next close/termination can schedule
    // Close any lingering connection from a prior reconnect attempt
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    const url = this._buildUrl();
    this.log.debug({ url }, 'assemblyai session connecting');
    const ws = new WsClient({
      url,
      headers: { 'Authorization': this.apiKey },
      onOpen: () => this._onOpen(),
      onMessage: (m) => this._onMessage(m),
      onClose: () => this._onClose(),
      onError: (e) => {
        this.log.error({ error: e && e.message }, 'assemblyai session socket error');
        if (this.onError) this.onError(e);
      },
    });
    this.ws = ws;
    ws.connect();
  }

  _onOpen() {
    this.failCount = 0;
    this.log.info({ language: this.language }, 'assemblyai session open');
    // Note: onStatus({ active: true }) fires on receiving the Begin message, not on open.
    // The session is not fully active until the server confirms with Begin.
  }

  _onMessage(m) {
    if (m.op !== OP_TEXT) return; // binary frames from server are unexpected — ignore
    let msg;
    try {
      msg = JSON.parse(m.payload.toString('utf8'));
    } catch {
      this.log.warn('assemblyai: unparseable server frame');
      return; // ignore malformed JSON — don't crash the session
    }

    const type = msg && msg.type;

    switch (type) {
      case 'Begin':
        this.sessionId = msg.id || null;
        this.log.info({ sessionId: this.sessionId, expiresAt: msg.expires_at }, 'assemblyai session began');
        if (this.onStatus) this.onStatus({ active: true, provider: 'assemblyai' });
        break;

      case 'Turn': {
        const text = typeof msg.transcript === 'string' ? msg.transcript : '';
        if (!text) break; // drop empty transcripts
        const ts = Date.now();
        if (msg.end_of_turn) {
          if (this.onFinal) this.onFinal({ text, ts });
        } else {
          if (this.onPartial) this.onPartial({ text, ts });
        }
        break;
      }

      case 'Termination':
        this.log.info({ sessionId: this.sessionId,
          audioDuration: msg.audio_duration_seconds,
          sessionDuration: msg.session_duration_seconds }, 'assemblyai session terminated');
        // Server ended the session — reconnect to start a fresh one.
        if (!this.userClosed) this._scheduleReconnect('server terminated session');
        break;

      case 'Error': {
        const code = msg.error_code;
        const err = new Error('assemblyai error ' + (code || 'unknown') + ': ' + (msg.error || ''));
        this.log.error({ errorCode: code, error: msg.error }, 'assemblyai error');
        if (this.onError) this.onError(err);
        if (FATAL_ERROR_CODES.has(code)) {
          this.log.error({ errorCode: code }, 'assemblyai fatal error — not reconnecting');
          if (this.onStatus) this.onStatus({ active: false, reason: err.message });
          return; // latch immediately — no reconnect
        }
        // Non-fatal error — reconnect
        if (!this.userClosed) this._scheduleReconnect(err.message);
        break;
      }

      case 'Heartbeat':
        // Informational — no action needed
        break;

      case 'SpeechStarted':
        // Informational (U3.5 Pro only) — no action needed
        break;

      default:
        this.log.debug({ type }, 'assemblyai: unknown message type');
        break;
    }
  }

  _scheduleReconnect(reason) {
    // Guard: prevent double-scheduling when both Termination and socket close fire
    if (this._reconnectPending || this.userClosed) return;
    this._reconnectPending = true;
    this.failCount++;
    if (this.failCount >= this.maxConnectFailures) {
      this.log.error({ attempts: this.failCount, reason },
        'assemblyai session gave up after repeated failures; degrading to batch');
      if (this.onStatus) this.onStatus({
        active: false,
        reason: 'assemblyai unreachable after ' + this.maxConnectFailures + ' attempts',
      });
      return; // latch — stop reconnecting
    }
    const delay = Math.min(1000 * Math.pow(2, this.failCount - 1), this.maxBackoffMs);
    this.log.warn({ attempts: this.failCount, delay, reason }, 'assemblyai session reconnecting');
    this.backoffTimer = setTimeout(() => { this.backoffTimer = null; this.start(); }, delay);
  }

  _onClose() {
    if (this.userClosed) return;
    // Unexpected close without a preceding error/termination message — reconnect
    this._scheduleReconnect('socket closed');
  }

  sendAudio(int16Buffer) {
    if (this.ws && this.ws.connected) this.ws.send(int16Buffer, true); // binary frame
  }

  close() {
    this.log.debug({ sessionId: this.sessionId }, 'assemblyai session closing');
    this.userClosed = true;
    if (this.backoffTimer) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
    if (this.ws && this.ws.connected) {
      // Send Terminate for graceful billing, then close
      try {
        this.ws.send(Buffer.from(JSON.stringify({ type: 'Terminate' })), false);
      } catch {}
      try { this.ws.close(); } catch {}
    } else if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
  }
}

module.exports = { AssemblyAIStreamSession, ASSEMBLYAI_V3_URL };
