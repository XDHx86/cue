// Deepgram streaming session — WebSocket protocol.
// Uses the WsClient from ../external-ws/session.js (hand-rolled RFC 6455 over net/tls)
// with Authorization: Token <key> header for API key auth.
// Protocol: binary Int16 PCM frames → JSON text responses.
// Reconnects with exponential backoff; latches after maxConnectFailures so the pipeline
// degrades to batch instead of spinning forever.

const { WsClient, OP_TEXT } = require('../external-ws/session');
const { noopLogger } = require('../../../logger');

const DEEPGRAM_V1_URL = 'wss://api.deepgram.com/v1/listen';

class DeepgramStreamSession {
  constructor({ apiKey, url, model, language, smartFormat, punctuate, endpointingMs, utteranceEndMs,
                onFinal, onPartial, onError, onStatus, log,
                maxConnectFailures, maxBackoffMs }) {
    this.apiKey = apiKey;
    this.url = url || DEEPGRAM_V1_URL;
    this.model = model || '';
    this.language = language || null;
    this.smartFormat = smartFormat !== false;
    this.punctuate = punctuate !== false;
    this.endpointingMs = endpointingMs || 300;
    this.utteranceEndMs = utteranceEndMs || 1000;
    this.onFinal = onFinal;
    this.onPartial = onPartial;
    this.onError = onError;
    this.onStatus = onStatus;
    this.log = log || noopLogger;
    this.ws = null;
    this.failCount = 0;
    this.userClosed = false;
    this.backoffTimer = null;
    this._reconnectPending = false;
    this.maxConnectFailures = typeof maxConnectFailures === 'number' ? maxConnectFailures : 3;
    this.maxBackoffMs = typeof maxBackoffMs === 'number' ? maxBackoffMs : 8000;
  }

  _buildUrl() {
    const u = new URL(this.url);
    u.searchParams.set('encoding', 'linear16');
    u.searchParams.set('sample_rate', '16000');
    u.searchParams.set('channels', '1');
    if (this.model) u.searchParams.set('model', this.model);
    if (this.language) u.searchParams.set('language', this.language);
    u.searchParams.set('interim_results', 'true');
    u.searchParams.set('endpointing', String(this.endpointingMs));
    u.searchParams.set('utterance_end_ms', String(this.utteranceEndMs));
    if (this.smartFormat) u.searchParams.set('smart_format', 'true');
    if (this.punctuate) u.searchParams.set('punctuate', 'true');
    u.searchParams.set('keepalive', 'true');
    return u.toString();
  }

  start() {
    if (this.userClosed) return;
    this._reconnectPending = false;
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    const url = this._buildUrl();
    this.log.debug({ url }, 'deepgram session connecting');
    const ws = new WsClient({
      url,
      headers: { 'Authorization': 'Token ' + this.apiKey },
      onOpen: () => this._onOpen(),
      onMessage: (m) => this._onMessage(m),
      onClose: () => this._onClose(),
      onError: (e) => {
        this.log.error({ error: e && e.message }, 'deepgram session socket error');
        if (this.onError) this.onError(e);
      },
    });
    this.ws = ws;
    ws.connect();
  }

  _onOpen() {
    this.failCount = 0;
    this.log.info({ model: this.model, language: this.language }, 'deepgram session open');
    // Deepgram doesn't send a "Begin" message like AssemblyAI; mark active immediately on connect.
    if (this.onStatus) this.onStatus({ active: true, provider: 'deepgram' });
  }

  _onMessage(m) {
    if (m.op !== OP_TEXT) return;
    let msg;
    try {
      msg = JSON.parse(m.payload.toString('utf8'));
    } catch {
      this.log.warn('deepgram: unparseable server frame');
      return;
    }

    const type = msg && msg.type;

    switch (type) {
      case 'Results': {
        const channel = msg.channel || {};
        const alt = (channel.alternatives && channel.alternatives[0]) || {};
        const transcript = typeof alt.transcript === 'string' ? alt.transcript : '';
        if (!transcript) break;
        const ts = Date.now();
        if (msg.is_final) {
          // is_final + speech_final = true utterance boundary (final transcript)
          // is_final alone = stable intermediate result (also treated as final for cue's purposes)
          if (this.onFinal) this.onFinal({ text: transcript, ts });
        } else {
          // Interim result — partial
          if (this.onPartial) this.onPartial({ text: transcript, ts });
        }
        break;
      }

      case 'UtteranceEnd': {
        // Longer silence detected — the utterance is complete. If we didn't already get a
        // speech_final, this is the signal. The transcript is not in this message.
        break;
      }

      case 'KeepAlive':
        break;

      case 'Error': {
        const err = new Error('Deepgram error: ' + (msg.description || msg.message || msg.error || 'unknown'));
        this.log.error({ error: err.message }, 'deepgram error');
        if (this.onError) this.onError(err);
        if (!this.userClosed) this._scheduleReconnect(err.message);
        break;
      }

      default:
        this.log.debug({ type }, 'deepgram: unknown message type');
        break;
    }
  }

  _scheduleReconnect(reason) {
    if (this._reconnectPending || this.userClosed) return;
    this._reconnectPending = true;
    this.failCount++;
    if (this.failCount >= this.maxConnectFailures) {
      this.log.error({ attempts: this.failCount, reason },
        'deepgram session gave up after repeated failures; degrading to batch');
      if (this.onStatus) this.onStatus({
        active: false,
        reason: 'deepgram unreachable after ' + this.maxConnectFailures + ' attempts',
      });
      return; // latch — stop reconnecting; main degrades this channel to batch
    }
    const delay = Math.min(1000 * Math.pow(2, this.failCount - 1), this.maxBackoffMs);
    this.log.warn({ attempts: this.failCount, delay, reason }, 'deepgram session reconnecting');
    this.backoffTimer = setTimeout(() => { this.backoffTimer = null; this.start(); }, delay);
  }

  _onClose() {
    if (this.userClosed) return;
    this._scheduleReconnect('socket closed');
  }

  sendAudio(int16Buffer) {
    if (this.ws && this.ws.connected) this.ws.send(int16Buffer, true); // binary frame
  }

  close() {
    this.log.debug('deepgram session closing');
    this.userClosed = true;
    if (this.backoffTimer) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

module.exports = { DeepgramStreamSession, DEEPGRAM_V1_URL };
