// Local STT engine — session + load-params utilities for the managed Python faster-whisper
// service. The legacy engine registry (registerEngine/listEngines/createEngineSession/engineMeta)
// has been removed (R2) — engine discovery now goes through the provider registry
// (src/registry.js). This module only exports the session implementation and shared
// constants consumed by the faster-whisper provider (src/providers/stt/faster-whisper/index.js).

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;

// Finite bounds for the local engine's start sequence. The previous design gave `load` an
// INFINITE timeout (timeout:0) and let it download silently (local_files_only=False) — a stuck
// or slow HuggingFace fetch blocked stream_start forever (sid never set, every PCM chunk
// silently dropped): the literal "local STT hangs forever" symptom. Now the host downloads
// first (with progress), then loads from the cache with a finite timeout. A cached load is
// seconds, so the bound is generous; a download of a multi-GB large model can take many minutes
// on a slow link, so the download bound is long but still finite (the host surfaces progress).
const MODEL_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min — bounded; host shows progress
const MODEL_LOAD_TIMEOUT_MS = 120 * 1000;          // cached load only — seconds, bound for safety
// Audio buffered while `sid` is null (warm-up: venv spawn + hello + download + load + stream_start).
// ~2s of 16kHz mono Int16: enough that speech said during a *fast* cached load isn't lost while
// keeping the ring small. A long first-download drops the tail past this window (unavoidable).
const PRE_SID_BYTES = Math.floor(16000 * 2 * 2);

// Shared source of truth for the managed Python engine's `load` params, derived from
// settings.stt.local (model/device/computeType/vad) + the manager's models dir. Used by
// BOTH the streaming session (below) and the batch provider (src/providers/stt/faster-whisper)
// so a batch call that follows a streaming load reuses the SAME params and skips a redundant
// reload. `language` is null-uniform: the streaming path always carries null (auto-detect) and
// the batch path matches it so the params compare equal against manager.getLastLoad().
function localLoadParams(settings, manager, language = null) {
  const cfg = (settings && settings.stt && settings.stt.local) || {};
  return {
    name: cfg.model || 'small',
    device: cfg.device || 'auto',
    compute_type: cfg.computeType || 'auto', // snake_case for the Python service
    language: language === undefined ? null : language,
    vad: cfg.vad !== false,
    download_root: manager && manager.getModelsDir ? manager.getModelsDir() : undefined,
    // Cache-only load: the host pre-downloads via model_download (which emits progress), so
    // load() can NEVER block on a silent network fetch — the old infinite-timeout hang.
    local_files_only: true,
  };
}

// ---- local faster-whisper session ---------------
// `settings` is carried so start() reads stt.local.{model,device,computeType,vad} and
// re-loads when the user changes them. `manager` is the createSttProcessManager instance.
class LocalFasterWhisperSession {
  constructor({ manager, channel, language, onFinal, onPartial, onError, onStatus, settings }) {
    this.manager = manager;
    this.channel = channel;
    // language follows the same convention as the external session: null = auto-detect.
    this.language = language === undefined ? null : language;
    this.onFinal = onFinal; this.onPartial = onPartial; this.onError = onError; this.onStatus = onStatus;
    this.settings = settings || {};
    this.sid = null;
    this._unsubs = [];
    this._closed = false;
    this._starting = false;
    this._preSid = [];                 // bounded ring of Int16 chunks captured before `sid` was set
  }

  _loadParams() {
    return localLoadParams(this.settings, this.manager, this.language);
  }

  // Cheap filesystem check (the Python service's models_list is an os.path.isdir scan, no model
  // load). Best-effort: on any error we return true so the caller falls through to a normal load
  // (which would then surface the real error rather than spinning an unneeded download).
  async _isObjectCached(params) {
    try {
      const res = await this.manager.call('models_list', { download_root: params.download_root });
      const hit = ((res && res.models) || []).find((m) => m && m.name === params.name);
      return !!(hit && hit.cached);
    } catch { return true; }
  }

  // Buffer audio captured while `sid` is null (warm-up). A bounded ring of ~2s so speech said
  // during a fast cached load isn't lost — the long first-download drops its own tail past the cap
  // (unavoidable), but at least audio isn't *silently* dropped with zero feedback.
  _bufferPreSid(buf) {
    this._preSid.push(buf);
    let total = 0; for (const b of this._preSid) total += b.length;
    const preSidCap = (this.settings.stt && typeof this.settings.stt.preSidBytes === 'number')
      ? this.settings.stt.preSidBytes : PRE_SID_BYTES;
    while (total > preSidCap && this._preSid.length > 1) total -= this._preSid.shift().length;
  }
  _flushPreSid() {
    if (!this.sid || this._closed || !this._preSid.length) { this._preSid = []; return; }
    const merged = Buffer.concat(this._preSid);
    this._preSid = [];
    // base64 over the JSON pipe: 33% overhead at 16kHz mono = 42 KB/s localhost — negligible.
    this.manager.notify('stream_audio', { sid: this.sid, pcm_b64: merged.toString('base64') });
  }

  async start() {
    if (this._closed || this._starting) return;
    this._starting = true;
    try {
      // ensureRunning() is idempotent: spawns + handshakes only if not already up; once the
      // process is alive (after venv bootstrap), the load/stream calls go straight through.
      if (!(await this.manager.ensureRunning())) {
        if (this.onStatus) this.onStatus({ active: false, reason: 'local STT service unavailable' });
        return;
      }
      // Load the configured model only if it isn't already active — a restart re-loads the last
      // one itself, so we skip to avoid re-downloading / redundant GPU init on every session.
      const params = this._loadParams();
      const last = this.manager.getLastLoad();
      if (!last || JSON.stringify(last) !== JSON.stringify(params)) {
        // Decouple DOWNLOAD from LOAD (root cause of the "local hangs forever" timeout):
        // download first via model_download (which emits progress to the renderer), THEN load from
        // the cache with a finite timeout. load() therefore never stalls on a silent network fetch.
        if (!(await this._isObjectCached(params))) {
          if (this.onStatus) this.onStatus({ active: false, starting: true, reason: 'preparing model (' + params.name + ') — downloading…' });
          await this.manager.call('model_download',
            { name: params.name, download_root: params.download_root },
            { timeout: (this.settings.stt && this.settings.stt.modelDownloadTimeoutMs) || MODEL_DOWNLOAD_TIMEOUT_MS });
        }
        if (this.onStatus) this.onStatus({ active: false, starting: true, reason: 'loading model (' + params.name + ')…' });
        await this.manager.call('load', params, { timeout: (this.settings.stt && this.settings.stt.modelLoadTimeoutMs) || MODEL_LOAD_TIMEOUT_MS });
        this.manager.setLastLoad(params);
      }
      const start = await this.manager.call('stream_start', { language: this.language, vad: params.vad });
      this.sid = start && start.sid;
      if (!this.sid) {
        if (this.onStatus) this.onStatus({ active: false, reason: 'stream_start returned no sid' });
        return;
      }
      // Demux process-wide events onto this session by sid. The manager fans every event to
      // every session; sessions ignore events that aren't theirs.
      this._unsubs.push(this.manager.on('partial', (e) => {
        if (e.sid !== this.sid || !this.onPartial) return;
        this.onPartial({ text: e.text, ts: e.ts });
      }));
      this._unsubs.push(this.manager.on('final', (e) => {
        if (e.sid !== this.sid || !this.onFinal) return;
        this.onFinal({ text: e.text, ts: e.ts });
      }));
      this._unsubs.push(this.manager.on('status', (e) => {
        if (!this.onStatus) return;
        // a 'streaming' status for a different sid is another session — ignore it.
        if (e.status === 'streaming' && e.sid && e.sid !== this.sid) return;
        if (e.status === 'ready' || e.status === 'streaming') this.onStatus({ active: true, provider: 'faster-whisper' });
        else if (e.status === 'inactive' || e.status === 'latched' || e.status === 'unloaded') {
          this.onStatus({ active: false, reason: e.reason || 'service unavailable' });
        }
      }));
      this._flushPreSid(); // ship any audio captured while warming up
      if (this.onStatus) this.onStatus({ active: true, provider: 'faster-whisper' });
    } catch (e) {
      if (this.onError) this.onError(e);
      if (this.onStatus) this.onStatus({ active: false, reason: (e && e.message) || 'start failed' });
    } finally {
      this._starting = false;
    }
  }

  sendAudio(int16Buffer) {
    if (this._closed || !this.manager) return;
    if (!this.sid) { this._bufferPreSid(int16Buffer); return; } // warm-up: keep a bounded tail
    this.manager.notify('stream_audio', { sid: this.sid, pcm_b64: Buffer.from(int16Buffer).toString('base64') });
  }

  async close() {
    this._closed = true;
    this._preSid = [];
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
    if (this.sid) { try { await this.manager.call('stream_stop', { sid: this.sid }); } catch {} }
    this.sid = null;
  }
}

module.exports = {
  localLoadParams, LocalFasterWhisperSession,
  MODEL_DOWNLOAD_TIMEOUT_MS, MODEL_LOAD_TIMEOUT_MS, PRE_SID_BYTES,
};
