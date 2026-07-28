// Engine-agnostic STT seam.
//
// The rest of the app (main.js, src/stt-stream.js) never names a local engine
// directly. It calls createStreamSTT(settings, { localEngineManager }).createSession(...);
// this module's registry picks the engine named by settings.stt.engine and builds a
// session that speaks the SAME surface as the external faster-whisper WS session
// in stt-stream.js ({ start, sendAudio(int16), close } + onFinal/onPartial/onStatus/onError).
//
// Adding a new local engine later (whisper.cpp, …) = one new file that calls
// registerEngine('whisper-cpp', factory) implementing that surface. Nothing in main.js
// or stt-stream.js changes — the whole point of the seam.
//
// The faster-whisper engine (the default, registered below) bridges start/sendAudio/close
// onto the managed Python process's JSON-RPC (src/stt-process.js): load the model if it
// isn't already, stream_start → sid, forward per-sid partial/final events, and stream_stop
// on close. Audio is sent fire-and-forget (manager.notify) so the ~16 msg/s/channel audio
// cadence never accumulates pending request promises.

const engines = new Map();

function registerEngine(name, factory) {
  if (typeof factory !== 'function') throw new Error(`engine factory "${name}" must be a function`);
  engines.set(name, factory);
  return () => engines.delete(name);
}
function listEngines() { return [...engines.keys()]; }
function hasEngine(name) { return engines.has(name); }
function createEngineSession(name, opts) {
  const factory = engines.get(name);
  if (!factory) return null; // unknown engine → caller (stt-stream) degrades to batch
  return factory(opts);
}

// Map engine id → { label } for the Settings engine selector (data-driven, future-proof).
const ENGINE_META = { 'faster-whisper': { label: 'faster-whisper (local)' } };
function engineMeta() {
  return [...engines.keys()].map((id) => ({ id, ...(ENGINE_META[id] || { label: id }) }));
}

// ---- local faster-whisper session (the registered engine) ---------------
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
  }

  _loadParams() {
    const cfg = (this.settings.stt && this.settings.stt.local) || {};
    return {
      name: cfg.model || 'small',
      device: cfg.device || 'auto',
      compute_type: cfg.computeType || 'auto', // snake_case for the Python service
      language: this.language,
      vad: cfg.vad !== false,
      download_root: this.manager.getModelsDir(),
    };
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
        await this.manager.call('load', params, { timeout: 0 }); // model download can take minutes
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
      if (this.onStatus) this.onStatus({ active: true, provider: 'faster-whisper' });
    } catch (e) {
      if (this.onError) this.onError(e);
      if (this.onStatus) this.onStatus({ active: false, reason: (e && e.message) || 'start failed' });
    } finally {
      this._starting = false;
    }
  }

  sendAudio(int16Buffer) {
    if (!this.sid || this._closed || !this.manager) return;
    // base64 over the JSON pipe: 33% overhead at 16kHz mono ≈ 42 KB/s localhost — negligible.
    this.manager.notify('stream_audio', { sid: this.sid, pcm_b64: Buffer.from(int16Buffer).toString('base64') });
  }

  async close() {
    this._closed = true;
    for (const u of this._unsubs) { try { u(); } catch {} }
    this._unsubs = [];
    if (this.sid) { try { await this.manager.call('stream_stop', { sid: this.sid }); } catch {} }
    this.sid = null;
  }
}

registerEngine('faster-whisper', (opts) => {
  if (!opts || !opts.manager) return null; // no manager wired in → degrade (batch)
  return new LocalFasterWhisperSession(opts);
});

module.exports = {
  registerEngine, listEngines, hasEngine, createEngineSession, engineMeta,
  LocalFasterWhisperSession,
};
