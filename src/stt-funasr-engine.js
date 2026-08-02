// FunASR engine session (+ load-params) for the managed Python FunASR service.
// Mirrors src/stt-engine.js for faster-whisper — same PRE_SID ring, finite-timeout
// download-before-load decoupling (ADR-016), webrtcvad-driven streaming loop.
// The Python service (python/cue_stt_funasr_service.py) speaks the same JSON-RPC
// protocol: stream_start / stream_audio / stream_stop + partial/final/status events.

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;
const MODEL_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min
const MODEL_LOAD_TIMEOUT_MS    = 120 * 1000;        // cached load only
const PRE_SID_BYTES = Math.floor(16000 * 2 * 2);   // ~2 s of 16 kHz Int16 mono

function funasrLoadParams(settings, manager, language) {
  const cfg = (settings && settings.stt && settings.stt.funasr) || {};
  return {
    model: cfg.model || "paraformer-large-zh",
    device: cfg.device || "cpu",
    language: language === undefined ? null : language,
    vad: true, // webrtcvad endpointing is always on for FunASR
    download_root: manager && manager.getModelsDir ? manager.getModelsDir() : undefined,
    local_files_only: true,
  };
}

class LocalFunasrSession {
  constructor({ manager, channel, language, onFinal, onPartial, onError, onStatus, settings }) {
    this.manager = manager;
    this.channel = channel;
    this.language = language === undefined ? null : language;
    this.onFinal = onFinal; this.onPartial = onPartial; this.onError = onError; this.onStatus = onStatus;
    this.settings = settings || {};
    this.sid = null;
    this._unsubs = [];
    this._closed = false;
    this._starting = false;
    this._preSid = [];
    // internal tracking on load-params to detect engine load changes
    this._lastLoadParams = null;
  }

  _buildLoadParams() {
    return funasrLoadParams(this.settings, this.manager, this.language);
  }

  async _isCached(params) {
    try {
      const res = await this.manager.call("models_list", { download_root: params.download_root });
      const hit = ((res && res.models) || []).find((m) => m && m.name === params.model);
      return !!(hit && hit.cached);
    } catch { return true; }
  }

  _bufferPreSid(buf) {
    this._preSid.push(buf);
    let total = 0; for (const b of this._preSid) total += b.length;
    const preSidCap = (this.settings.stt && typeof this.settings.stt.preSidBytes === "number")
      ? this.settings.stt.preSidBytes : PRE_SID_BYTES;
    while (total > preSidCap && this._preSid.length > 1) total -= this._preSid.shift().length;
  }

  _flushPreSid() {
    if (!this.sid || this._closed || !this._preSid.length) { this._preSid = []; return; }
    const merged = Buffer.concat(this._preSid);
    this._preSid = [];
    this.manager.notify("stream_audio", { sid: this.sid, pcm_b64: merged.toString("base64") });
  }

  async start() {
    if (this._closed || this._starting) return;
    this._starting = true;
    try {
      if (!(await this.manager.ensureRunning())) {
        if (this.onStatus) this.onStatus({ active: false, reason: "FunASR service unavailable" });
        return;
      }
      const params = this._buildLoadParams();
      const last = this._lastLoadParams;
      if (!last || JSON.stringify(last) !== JSON.stringify(params)) {
        if (!(await this._isCached(params))) {
          if (this.onStatus) this.onStatus({ active: false, starting: true, reason: `preparing model (${params.model}) — downloading…` });
          await this.manager.call("model_download",
            { name: params.model, download_root: params.download_root },
            { timeout: (this.settings.stt && this.settings.stt.modelDownloadTimeoutMs) || MODEL_DOWNLOAD_TIMEOUT_MS });
        }
        if (this.onStatus) this.onStatus({ active: false, starting: true, reason: `loading model (${params.model})…` });
        await this.manager.call("load", params, { timeout: (this.settings.stt && this.settings.stt.modelLoadTimeoutMs) || MODEL_LOAD_TIMEOUT_MS });
        this._lastLoadParams = params;
      }
      const start = await this.manager.call("stream_start", { language: this.language });
      this.sid = start && start.sid;
      if (!this.sid) {
        if (this.onStatus) this.onStatus({ active: false, reason: "stream_start returned no sid" });
        return;
      }
      this._unsubs.push(this.manager.on("partial", (e) => {
        if (e.sid !== this.sid || !this.onPartial) return;
        this.onPartial({ text: e.text, ts: e.ts });
      }));
      this._unsubs.push(this.manager.on("final", (e) => {
        if (e.sid !== this.sid || !this.onFinal) return;
        this.onFinal({ text: e.text, ts: e.ts });
      }));
      this._unsubs.push(this.manager.on("status", (e) => {
        if (!this.onStatus) return;
        if (e.status === "streaming" && e.sid && e.sid !== this.sid) return;
        if (e.status === "ready" || e.status === "streaming") this.onStatus({ active: true, provider: "funasr" });
        else if (e.status === "inactive" || e.status === "latched" || e.status === "unloaded") {
          this.onStatus({ active: false, reason: e.reason || "service unavailable" });
        }
      }));
      this._flushPreSid();
      if (this.onStatus) this.onStatus({ active: true, provider: "funasr" });
    } catch (e) {
      if (this.onError) this.onError(e);
      if (this.onStatus) this.onStatus({ active: false, reason: (e && e.message) || "start failed" });
    } finally {
      this._starting = false;
    }
  }

  sendAudio(int16Buffer) {
    if (this._closed || !this.manager) return;
    if (!this.sid) { this._bufferPreSid(int16Buffer); return; }
    this.manager.notify("stream_audio", { sid: this.sid, pcm_b64: Buffer.from(int16Buffer).toString("base64") });
  }

  async close() {
    this._closed = true;
    this._preSid = [];
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
    if (this.sid) { try { await this.manager.call("stream_stop", { sid: this.sid }); } catch {} }
    this.sid = null;
  }
}

module.exports = {
  funasrLoadParams,
  LocalFunasrSession,
  MODEL_DOWNLOAD_TIMEOUT_MS, MODEL_LOAD_TIMEOUT_MS, PRE_SID_BYTES,
};