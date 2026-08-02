// Managed Python Speech-to-Text service — process, venv, and JSON-RPC plumbing.
//
// The rest of the app never talks to Python. It calls this manager's JSON-RPC
// surface; the manager owns the lifecycle:
//   - ensureVenv(): create a project-local venv (userData/stt-venv) and pip-install
//     the pinned python/requirements.txt — once, idempotent, re-installs only when
//     the requirements hash changes. Users never run pip. CUDA torch is an opt-in
//     manual step (not installed here — see docs/faster-whisper-setup.md).
//   - start(): spawn the service from the venv python (`-u` so stdout is unbuffered),
//     await the `hello` handshake.
//   - call(method, params): request/response, correlated by an integer id.
//   - on('partial'|'final'|'status'|'progress'|'error'|'exit', cb): stream events
//     the service emits without an id. The engine (src/stt-engine.js) demuxes
//     partial/final by sid onto per-channel callbacks.
//   - restart on crash with exponential backoff + re-load of the active model;
//     after MAX_SPAWN_FAILURES consecutive failures it latches and stops retrying
//     (the engine/main degrade to the existing batch path — no regression).
//   - stop(): clean shutdown (send 'shutdown', close stdin, kill after a grace).
//
// Protocol over the pipe: one JSON object per line. Requests: {id, m, ...params}.
// Responses: {id, ok, result|error}. Events (no id): {m, ...fields}. stdout is JSON
// only; stderr is free-form logs captured for diagnostics/last-error.
//
// Param-injected ({ spawn, spawnSync, fs, getPath }) so tests need no `electron`
// and spawn no Python — the test/stt-stream.test.js precedent (electron-dependent
// code is param-injected, per .claude/docs/conventions.md).

const path = require('path');
const crypto = require('crypto');

// Structured STT logger (Pino). The manager accepts a `logger` (object: pino-shaped,
// { trace/debug/info/warn/error/fatal, child }) — defaulting to a noop so the pure-Node
// test suite never requires Pino and never spawns a worker transport (param-injection
// invariant, .claude/docs/conventions.md). Production wiring passes a sttChild from
// src/logger.js. parsePyLogLine / mapPyLevelToPino forward the spawned Python
// service's stderr JSON logs into Pino preserving the level (ADR-014).
const { noopLogger: _defaultNoop, mapPyLevelToPino, parsePyLogLine,
        resolveLogDir } = require('./logger');

// Electron's app.getPath is resolved lazily (on first use), NOT at module load, so this module can
// be `require`d by the pure-Node test suite without crashing: outside Electron `require('electron')`
// returns the binary path string (not { app }), so `app.getPath` would throw at load. Tests inject a
// fake `getPath` into createSttProcessManager and never touch this; the production caller (main.js)
// runs inside Electron, where `require('electron')` returns the real { app }. This preserves the
// param-injection invariant (per .claude/docs/conventions.md) — code is electron-free for tests.
let _boundGetPath;
function defaultGetPath(name) {
  if (!_boundGetPath) {
    const { app } = require('electron');
    _boundGetPath = app.getPath.bind(app);
  }
  return _boundGetPath(name);
}

// Engine spec: a managed Python service is fully described by where its requirements
// file lives, which script to spawn, the venv/models dir names under userData, and a
// `verifyImport` snippet run after pip-install to confirm the deps imported. The manager
// grew up hardcoded to faster-whisper; threading this as an option lets a SECOND offline
// engine (FunASR) run its own isolated service with its own venv — see
// .claude/docs/decisions.md (ADR — multi-manager generalization). The faster-whisper
// defaults below are byte-for-byte the old literals so existing behavior is unchanged.
const DEFAULT_ENGINE_SPEC = {
  requirementsPath: path.join(__dirname, '..', 'python', 'requirements.txt'),
  scriptPath: path.join(__dirname, '..', 'python', 'cue_stt_service.py'),
  venvDirName: 'stt-venv',
  modelsDirName: 'stt-models',
  // NOTE: kept in sync with python/cue_stt_service.py imports. The verify probe's stdout
  // lines 1..3 feed diag.fasterWhisperVersion / cuda — see ensureVenv().
  verifyImport: 'import faster_whisper, ctranslate2; '
    + 'print(faster_whisper.__version__); '
    + 'print(ctranslate2.__version__); '
    + 'print(ctranslate2.get_cuda_device_count() > 0)',
};

const MAX_SPAWN_FAILURES = 3;
const HELLO_TIMEOUT_MS = 8000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;
// Re-load after an unexpected restart: the model is already cached (local_files_only=true in
// the last logged load params), so a cached load is seconds — bound it. The first-load download
// is handled by the engine (src/stt-engine.js) BEFORE load, never here.
const MODEL_RELOAD_TIMEOUT_MS = 120000;
const SHUTDOWN_GRACE_MS = 1000;

// ---- pure JSON <-> line framing (testable without a process) ------------
function encodeJsonLine(obj) {
  return JSON.stringify(obj) + '\n';
}
function parseJsonLine(line) {
  try { return JSON.parse(line); }
  catch { return null; }
}

// Request/response correlation + event lift, independent of a live child. Tests
// construct it with a fake `send` (records/inspects writes) and feed server lines
// back through `feedLine` to assert resolves/emit. `onEvent` receives bare events.
class RpcChannel {
  constructor({ send, onEvent, defaultTimeout }) {
    this._send = send;
    this._onEvent = onEvent || (() => {});
    this._pending = new Map();
    this._id = 1;
    this._defaultTimeout = typeof defaultTimeout === 'number' ? defaultTimeout : DEFAULT_CALL_TIMEOUT_MS;
  }
  request(method, params = {}, { timeout = this._defaultTimeout } = {}) {
    return new Promise((resolve, reject) => {
      const id = String(this._id++);
      const entry = { resolve, reject };
      let timer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          if (this._pending.delete(id)) reject(new Error(`timeout: ${method}`));
        }, timeout);
      }
      entry.timer = timer;
      this._pending.set(id, entry);
      const payload = { id, m: method, ...params };
      try {
        this._send(encodeJsonLine(payload));
      } catch (e) {
        this._pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
  }
  // Feed one decoded server line (object). Responses resolve/reject by id; events
  // (objects with `m`, no `id`) go to onEvent. Unknown shapes are ignored.
  feedLine(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.id !== undefined && obj.id !== null) {
      const entry = this._pending.get(String(obj.id));
      if (!entry) return;
      this._pending.delete(String(obj.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (obj.ok) entry.resolve(obj.result);
      else entry.reject(new Error(obj.error || 'rpc error'));
      return;
    }
    if (obj.m) this._onEvent(obj);
  }
  feedLineStr(line) { this.feedLine(parseJsonLine(line)); }
  // Fire-and-forget: write a request with no id (the service runs it but sends no
  // response). Used for the hot audio path — ~16 messages/s/channel — so we never
  // accumulate pending promises waiting on a reply that won't come.
  notify(method, params = {}) {
    try { this._send(encodeJsonLine({ m: method, ...params })); }
    catch { /* a closed stdin surfaces via the child 'exit' path, not here */ }
  }
  rejectAll(err) {
    for (const entry of this._pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }
  hasPending() { return this._pending.size > 0; }
}

// ---- venv bootstrap decision logic (pure given injected fs + platform) --
// Python 3.10+ is required. Candidates are tried in order; the first that runs
// and reports a usable version wins. `py` (the Windows launcher) is included
// because `python3` is rarely on PATH there.
const PY_CANDIDATES = ['python3', 'python', 'py'];

function parsePyVer(s) {
  const m = /(\d+)\.(\d+)/.exec(s || '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2] };
}

function pickPython(spawnSync, candidates = PY_CANDIDATES) {
  for (const exe of candidates) {
    let r;
    try { r = spawnSync(exe, ['--version'], { encoding: 'utf8' }); }
    catch { continue; }
    if (!r || r.status !== 0) continue;
    const out = `${(r.stdout || '')}${(r.stderr || '')}`;
    const v = parsePyVer(out);
    if (!v) continue;
    if (v.major > 3 || (v.major === 3 && v.minor >= 10)) return { exe, version: out.trim() };
  }
  return null;
}

function venvPythonPath(venvDir, platform) {
  return platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

// Decide what to do given the filesystem state. Pure (no spawning): callers run
// the returned commands. `reqsHash` pins the install so a requirements.txt change
// re-installs, but an unchanged hash is a no-op (fast startup). `venvDirName` lets
// each managed engine keep an isolated venv (faster-whisper: 'stt-venv', funasr:
// 'stt-venv-funasr') so their torch-vs-CTranslate2 stacks never collide.
function buildVenvPlan({ userDataPath, platform, fs, reqsHash, venvDirName = 'stt-venv' }) {
  const venvDir = path.join(userDataPath, venvDirName);
  const venvPython = venvPythonPath(venvDir, platform);
  const marker = path.join(venvDir, 'cue-installed.txt');
  const exists = fs.existsSync(venvPython);
  const markerOK =
    exists &&
    fs.existsSync(marker) &&
    fs.readFileSync(marker, 'utf8') === reqsHash;
  const create = !exists;
  const install = create || !markerOK;
  return { venvDir, venvPython, marker, create, install, reqsHash };
}

// Pin the install to this requirements file's hash. Reads the injected path so an
// engine's isolated requirements file (python/requirements-funasr.txt) controls its own
// venv marker — an unchanged hash is a no-op, a requirements change re-installs. Defaults
// to faster-whisper's requirements.txt for backward compatibility with the single-engine
// callers/tests that pass only an fs.
function requirementsHash(fs, requirementsPath = DEFAULT_ENGINE_SPEC.requirementsPath) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(requirementsPath, 'utf8')).digest('hex'); }
  catch { return ''; }
}

// Build the environment the spawned Python service reads at startup (logging +
// VAD/speech params from settings). `logDir` is resolved to an ABSOLUTE path here
// (via the injected getPath) so the Python side's os.makedirs works regardless of the
// venv's cwd, and the Node + Python rotating log files share one directory. Booleans/ints
// are stringified only when explicitly set, so an absent key lets Python apply its own
// default. Pure given (logging, pythonSettings, getPath); a mkdir failure on the
// resolved dir is swallowed (non-fatal — Python degrades to console-only logging).
function buildPyLogEnv(logging, pythonSettings, getPath) {
  const env = {};
  // --- logging ---
  if (logging) {
    if (logging.level != null) env.CUE_STT_LOG_LEVEL = String(logging.level);
    if (logging.console != null) env.CUE_STT_LOG_CONSOLE = String(logging.console);
    if (logging.file != null) env.CUE_STT_LOG_FILE = String(logging.file);
    if (logging.pretty != null) env.CUE_STT_LOG_PRETTY = String(logging.pretty);
    const rotate = logging.rotate || {};
    if (rotate.sizeBytes != null) env.CUE_STT_LOG_ROTATE_SIZE = String(rotate.sizeBytes);
    if (rotate.count != null) env.CUE_STT_LOG_ROTATE_COUNT = String(rotate.count);
    try { env.CUE_STT_LOG_DIR = resolveLogDir(logging.logDir, getPath); }
    catch { /* unwritable/invalid dir is non-fatal: Python logs to console only */ }
  }
  // --- Python VAD / speech params (from settings.python.*) ---
  if (pythonSettings) {
    if (pythonSettings.vadAggressiveness != null) env.CUE_STT_VAD_AGG = String(pythonSettings.vadAggressiveness);
    if (pythonSettings.endMs != null) env.CUE_STT_VAD_END_MS = String(pythonSettings.endMs);
    if (pythonSettings.minSpeechMs != null) env.CUE_STT_MIN_SPEECH_MS = String(pythonSettings.minSpeechMs);
    if (pythonSettings.partialEveryS != null) env.CUE_STT_PARTIAL_EVERY_S = String(pythonSettings.partialEveryS);
    if (pythonSettings.energyGate != null) env.CUE_STT_ENERGY_GATE = String(pythonSettings.energyGate);
    if (pythonSettings.beamSize != null) env.CUE_STT_BEAM_SIZE = String(pythonSettings.beamSize);
  }
  return env;
}

module.exports = {
  encodeJsonLine, parseJsonLine, RpcChannel,
  pickPython, parsePyVer, venvPythonPath, buildVenvPlan, requirementsHash, buildPyLogEnv,
  DEFAULT_ENGINE_SPEC,
  PY_CANDIDATES, MAX_SPAWN_FAILURES, HELLO_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS,

  createSttProcessManager({ spawn, spawnSync, fs, getPath = defaultGetPath,
    logger = _defaultNoop, logging = null, pythonSettings = null,
    maxSpawnFailures: maxFailParam,
    helloTimeoutMs: helloTimeoutParam,
    callTimeoutMs: callTimeoutParam,
    modelReloadTimeoutMs: reloadTimeoutParam,
    shutdownGraceMs: shutdownGraceParam,
    spec: specParam = null,
    setTimeout: setTimer = global.setTimeout, clearTimeout: clearTimer = global.clearTimeout }) {
    const platform = process.platform;
    // Engine spec (script / requirements / venv name / models name / verify import). Null
    // → faster-whisper defaults, so the existing single-engine callers — and the test
    // suite — see byte-for-byte the old behavior.
    const spec = specParam || DEFAULT_ENGINE_SPEC;
    let modelsDir = path.join(getPath('userData'), spec.modelsDirName);
    // Module-scoped child so every log line carries module:'stt-process' without the
    // caller having to bind it each call. noopLogger.child() returns the same noop,
    // so tests pay nothing.
    const log = (logger && logger.child) ? logger.child({ module: 'stt-process' }) : logger;

    // Configurable timeouts from settings (env-only tier in config-schema.js).
    const _maxSpawnFailures = typeof maxFailParam === 'number' ? maxFailParam : MAX_SPAWN_FAILURES;
    const _helloTimeoutMs = typeof helloTimeoutParam === 'number' ? helloTimeoutParam : HELLO_TIMEOUT_MS;
    const _callTimeoutMs = typeof callTimeoutParam === 'number' ? callTimeoutParam : DEFAULT_CALL_TIMEOUT_MS;
    const _modelReloadTimeoutMs = typeof reloadTimeoutParam === 'number' ? reloadTimeoutParam : MODEL_RELOAD_TIMEOUT_MS;
    const _shutdownGraceMs = typeof shutdownGraceParam === 'number' ? shutdownGraceParam : SHUTDOWN_GRACE_MS;

    // -- process + venv state --
    let child = null;
    let venv = null;          // { venvPython, pythonVersion } once ensureVenv() ok
    let running = false;
    let stopping = false;
    let spawnFailures = 0;
    let latched = false;
    let lastLoad = null;      // re-applied on restart
    let stderrBuf = '';
    let diag = { status: 'stopped', activeModel: null, pythonVersion: null,
                 cuda: false, fasterWhisperVersion: null, lastError: null };

    // streaming session event callbacks (set by the engine): { partial, final, status, progress, error }
    const listeners = { partial: new Set(), final: new Set(), status: new Set(),
                        progress: new Set(), error: new Set(), exit: new Set() };

    const channel = new RpcChannel({
      send: (line) => { if (child && child.stdin && !child.stdin.destroyed) child.stdin.write(line); },
      defaultTimeout: _callTimeoutMs,
      onEvent: (obj) => {
        if (obj.m === 'status') {
          diag.status = obj.status || diag.status;
          if (obj.model) diag.activeModel = obj.model;
          if (obj.cuda !== undefined) diag.cuda = obj.cuda;
        }
        if (obj.m === 'error') { diag.lastError = obj.error || 'error'; }
        const set = listeners[obj.m];
        if (set) for (const cb of set) {
          try { cb(obj); } catch (e) { log.warn({ event: obj.m, error: e && e.message }, 'listener error'); }
        }
      },
    });

    function on(ev, cb) {
      const set = listeners[ev];
      if (!set) return () => {};
      set.add(cb);
      return () => set.delete(cb);
    }

    // ---- stdout framing: buffer + split on newlines ----
    let rx = '';
    function onStdout(chunk) {
      rx += chunk.toString('utf8');
      let nl;
      while ((nl = rx.indexOf('\n')) >= 0) {
        const line = rx.slice(0, nl).trim();
        rx = rx.slice(nl + 1);
        if (line) channel.feedLineStr(line);
      }
    }
    // ---- stderr framing: line-buffered so a Python JSON log spread across pipe
    // chunks is parsed as ONE line. Each complete line is forwarded through Pino at
    // the matching level (parsePyLogLine + mapPyLevelToPino); non-JSON lines
    // (faster-whisper/numpy warnings, crash banners) fall through to debug. The tail is
    // kept for diagnostics().lastError. stdout is JSON-RPC ONLY — a stray JSON-RPC line
    // on stderr would already be a bug, but parsePyLogLine returns null for a record
    // without a `level`, so protocol lines land in debug rather than as fake logs.
    let stderrLine = '';
    function onStderr(chunk) {
      stderrLine += chunk.toString('utf8');
      let nl;
      while ((nl = stderrLine.indexOf('\n')) >= 0) {
        const line = stderrLine.slice(0, nl);
        stderrLine = stderrLine.slice(nl + 1);
        if (line) _forwardPyStderrLine(line);
      }
    }
    function _forwardPyStderrLine(line) {
      stderrBuf = (stderrBuf + line + '\n').slice(-1024); // keep tail for last-error
      const rec = parsePyLogLine(line);
      if (rec) {
        const fn = log[mapPyLevelToPino(rec.level)] || log.info;
        fn.call(log, {
          py: true, pyLevel: rec.level, pyModule: rec.module,
          pyPid: rec.pid, pyTime: rec.ts, pyExtra: rec.extra, pyTraceback: rec.traceback,
        }, String(rec.message || ''));
      } else {
        log.debug({ py: true }, line); // legacy free-form stderr (unstructured warning)
      }
    }

    async function ensureVenv({ onVenvProgress = () => {} } = {}) {
      if (venv) return { ok: true, ...venv };
      const py = pickPython(spawnSync);
      if (!py) { diag.lastError = 'Python 3.10+ not found on PATH'; log.error(diag.lastError); return { ok: false, error: diag.lastError }; }
      const reqsHash = requirementsHash(fs, spec.requirementsPath);
      const plan = buildVenvPlan({ userDataPath: getPath('userData'), platform, fs, reqsHash, venvDirName: spec.venvDirName });
      diag.pythonVersion = py.version;
      try {
        if (plan.create) {
          onVenvProgress('Creating virtual environment…');
          log.info('creating python virtual environment');
          const r = spawnSync(py.exe, ['-m', 'venv', plan.venvDir], { encoding: 'utf8' });
          if (r.status !== 0 || !fs.existsSync(plan.venvPython)) {
            diag.lastError = 'venv creation failed: ' + `${r.stdout || ''}${r.stderr || ''}`.trim();
            log.error({ error: diag.lastError }, 'venv creation failed');
            return { ok: false, error: diag.lastError };
          }
        }
        if (plan.install) {
          onVenvProgress('Installing dependencies (one-time, CPU)…');
          log.info({ requirements: spec.requirementsPath }, 'installing python dependencies');
          await new Promise((resolve, reject) => {
            const pip = spawn(plan.venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check',
                                                '-r', spec.requirementsPath], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            pip.stdout.on('data', (d) => { out += d.toString(); });
            pip.stderr.on('data', (d) => { out += d.toString(); });
            pip.on('error', reject);
            pip.on('exit', (code) => code === 0 ? resolve() : reject(new Error('pip install failed: ' + out.slice(-800))));
          });
          fs.writeFileSync(plan.marker, plan.reqsHash);
        }
        // verify this engine's deps import + capture version/cuda info. The verify probe
        // is engine-specific (faster-whisper prints fw/ctranslate2 version + cuda count;
        // funasr would print funasr/torch version + torch.cuda.is_available()).
        const verify = spawnSync(plan.venvPython, ['-c', spec.verifyImport], { encoding: 'utf8' });
        if (verify.status !== 0) {
          diag.lastError = 'verify failed: ' + `${verify.stdout || ''}${verify.stderr || ''}`.trim();
          log.error({ error: diag.lastError }, 'dependency verification failed');
          return { ok: false, error: diag.lastError };
        }
        const lines = (verify.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        // Line 1 = primary engine version, line 3 = cuda-availability bool. Engines with a
        // different verify shape can be handled here later; for now this matches both the
        // faster-whisper probe and a funasr `import funasr, torch; print(funasr.__version__);
        // print(torch.__version__); print(torch.cuda.is_available())` probe.
        venv = { venvPython: plan.venvPython, pythonVersion: py.version,
                 fasterWhisperVersion: lines[0] || 'unknown', cuda: String(lines[2]) === 'True' };
        diag.fasterWhisperVersion = venv.fasterWhisperVersion;
        diag.cuda = venv.cuda;
        log.info({ python: py.version, engine: venv.fasterWhisperVersion, cuda: venv.cuda },
                 'venv ready');
        return { ok: true, ...venv };
      } catch (e) {
        diag.lastError = (e && e.message) || String(e);
        log.error({ error: diag.lastError }, 'venv setup failed');
        return { ok: false, error: diag.lastError };
      }
    }

    function spawnService() {
      if (!venv) throw new Error('venv not ready — call ensureVenv() first');
      // Hand the logging config to the Python service as env (python/cue_stt_logging.py
      // reads CUE_STT_LOG_* at startup). Merged onto process.env so PATH etc. survive;
      // a resolved ABSOLUTE CUE_STT_LOG_DIR keeps the Node + Python rotating logs in one dir.
      const pyLogEnv = buildPyLogEnv(logging, pythonSettings, getPath);
      const env = Object.keys(pyLogEnv).length ? { ...process.env, ...pyLogEnv } : undefined;
      child = spawn(venv.venvPython, ['-u', spec.scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
      log.debug({ script: spec.scriptPath, venv: venv.venvPython }, 'spawning stt service');
      rx = '';
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('exit', (code, signal) => onExit(code, signal));
      child.on('error', (e) => { diag.lastError = e.message; onExit(1); });
    }

    // ---- start + restart ----
    async function start() {
      if (running) return true;
      if (latched) return false;
      if (!venv) {
        const ev = await ensureVenv();
        if (!ev.ok) return false;
      }
      spawnService();
      try {
        const hello = await channel.request('hello', {}, { timeout: _helloTimeoutMs });
        if (hello) {
          diag.pythonVersion = hello.python_version || diag.pythonVersion;
          diag.fasterWhisperVersion = hello.faster_whisper_version || diag.fasterWhisperVersion;
          diag.cuda = !!hello.cuda;
        }
        running = true;
        spawnFailures = 0;
        diag.status = 'started';
        diag.lastError = null;
        log.info({ python: diag.pythonVersion, faster_whisper: diag.fasterWhisperVersion,
                   cuda: diag.cuda }, 'stt service started');
        if (lastLoad) {
          // a restart mid-session: re-load the last (cached) model so streaming sids can resume.
          // Finite timeout — the cache is local, so this is seconds, and a stuck reload must not
          // pin the service forever (it latches via onExit's failure path on a hung load).
          try { await channel.request('load', lastLoad, { timeout: _modelReloadTimeoutMs }); }
          catch (e) { log.error({ error: e && e.message }, 're-load after restart failed'); }
        }
        for (const cb of listeners.status) {
          try { cb({ m: 'status', status: 'ready', active_model: diag.activeModel, cuda: diag.cuda }); }
          catch (e) { /* listener errors are non-fatal */ }
        }
        return true;
      } catch (e) {
        diag.lastError = e && e.message;
        log.error({ error: diag.lastError }, 'stt service start failed');
        try { if (child) child.kill(); } catch {}
        child = null;
        return false;
      }
    }

    async function ensureRunning() {
      if (running) return true;
      return start();
    }

    function onExit(code, signal) {
      running = false;
      channel.rejectAll(new Error('service exited'));
      for (const cb of listeners.exit) { try { cb({ code, signal }); } catch {} }
      if (stopping) {
        stopping = false;
        diag.status = 'stopped';
        log.info('stt service stopped');
        return;
      }
      // unexpected: restart with backoff, latch after MAX_SPAWN_FAILURES
      spawnFailures++;
      if (spawnFailures > _maxSpawnFailures) {
        latched = true;
        diag.status = 'latched';
        diag.lastError = `service exited ${spawnFailures}× — gave up; degrade to batch`;
        log.error({ failures: spawnFailures },
                  'stt service gave up after repeated crashes; degrading to batch');
        for (const cb of listeners.status) {
          try { cb({ m: 'status', status: 'inactive', reason: diag.lastError }); } catch {}
        }
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, spawnFailures - 1), 8000);
      diag.status = 'restarting';
      diag.lastError = `service exited (code ${code}/${signal || ''}); restarting in ${delay}ms`;
      log.warn({ code, signal, attempt: spawnFailures, delay }, 'stt service exited; restarting');
      for (const cb of listeners.status) {
        try { cb({ m: 'status', status: 'restarting', reason: diag.lastError }); } catch {}
      }
      setTimer(() => { start().catch(() => {}); }, delay);
    }

    async function call(method, params = {}, opts) {
      if (!running) { const ok = await ensureRunning(); if (!ok) throw new Error('STT service not running'); }
      return channel.request(method, params, opts || {});
    }

    function notify(method, params = {}) {
      if (!running) return;
      channel.notify(method, params);
    }

    function stop() {
      log.info('stt service stopping');
      stopping = true;
      latched = false;
      spawnFailures = 0;
      try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch {}
      const c = child;
      if (c) {
        setTimer(() => { try { if (!c.killed) c.kill(); } catch {} }, _shutdownGraceMs);
      }
      child = null;
      running = false;
      diag.status = 'stopped';
    }

    function diagnostics() {
      return { running, latched, venvReady: !!venv, status: diag.status,
               activeModel: diag.activeModel, pythonVersion: diag.pythonVersion,
               cuda: diag.cuda, fasterWhisperVersion: diag.fasterWhisperVersion,
               lastError: diag.lastError, stderrTail: stderrBuf };
    }

    function setModelsDir(p) { if (p) modelsDir = p; }
    function getModelsDir() { return modelsDir; }
    function getLastLoad() { return lastLoad; }
    function setLastLoad(l) { lastLoad = l; }

    return {
      ensureVenv, start, ensureRunning, stop, call, notify, on, diagnostics,
      setLastLoad, getLastLoad, setModelsDir, getModelsDir,
      isRunning: () => running, isLatched: () => latched, isVenvReady: () => !!venv,
      // test-only escape hatches
      _channel: channel, _onExit: onExit, _feedStdout: onStdout, _feedStderr: onStderr,
      _setVenv(v) { venv = v; }, _setChild(c) { child = c; }, _setRunning(v) { running = v; },
    };
  },
};
