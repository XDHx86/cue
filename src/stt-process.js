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

const REQS_PATH = path.join(__dirname, '..', 'python', 'requirements.txt');
const SCRIPT_PATH = path.join(__dirname, '..', 'python', 'cue_stt_service.py');

const MAX_SPAWN_FAILURES = 3;
const HELLO_TIMEOUT_MS = 8000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;
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
  constructor({ send, onEvent }) {
    this._send = send;
    this._onEvent = onEvent || (() => {});
    this._pending = new Map();
    this._id = 1;
  }
  request(method, params = {}, { timeout = DEFAULT_CALL_TIMEOUT_MS } = {}) {
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
// re-installs, but an unchanged hash is a no-op (fast startup).
function buildVenvPlan({ userDataPath, platform, fs, reqsHash }) {
  const venvDir = path.join(userDataPath, 'stt-venv');
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

function requirementsHash(fs) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(REQS_PATH, 'utf8')).digest('hex'); }
  catch { return ''; }
}

module.exports = {
  REQS_PATH, SCRIPT_PATH,
  encodeJsonLine, parseJsonLine, RpcChannel,
  pickPython, parsePyVer, venvPythonPath, buildVenvPlan, requirementsHash,
  PY_CANDIDATES, MAX_SPAWN_FAILURES, HELLO_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS,

  createSttProcessManager({ spawn, spawnSync, fs, getPath = defaultGetPath, log = () => {},
    setTimeout: setTimer = global.setTimeout, clearTimeout: clearTimer = global.clearTimeout }) {
    const platform = process.platform;
    let modelsDir = path.join(getPath('userData'), 'stt-models');

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
      onEvent: (obj) => {
        if (obj.m === 'status') {
          diag.status = obj.status || diag.status;
          if (obj.model) diag.activeModel = obj.model;
          if (obj.cuda !== undefined) diag.cuda = obj.cuda;
        }
        if (obj.m === 'error') { diag.lastError = obj.error || 'error'; }
        const set = listeners[obj.m];
        if (set) for (const cb of set) {
          try { cb(obj); } catch (e) { log('[stt-process] listener', obj.m, e && e.message); }
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
    function onStderr(chunk) {
      const s = chunk.toString('utf8');
      stderrBuf = (stderrBuf + s).slice(-1024); // keep the tail for last-error
      log('[stt stderr]', s.trimEnd());
    }

    async function ensureVenv({ onVenvProgress = () => {} } = {}) {
      if (venv) return { ok: true, ...venv };
      const py = pickPython(spawnSync);
      if (!py) { diag.lastError = 'Python 3.10+ not found on PATH'; return { ok: false, error: diag.lastError }; }
      const reqsHash = requirementsHash(fs);
      const plan = buildVenvPlan({ userDataPath: getPath('userData'), platform, fs, reqsHash });
      diag.pythonVersion = py.version;
      try {
        if (plan.create) {
          onVenvProgress('Creating virtual environment…');
          const r = spawnSync(py.exe, ['-m', 'venv', plan.venvDir], { encoding: 'utf8' });
          if (r.status !== 0 || !fs.existsSync(plan.venvPython)) {
            diag.lastError = 'venv creation failed: ' + `${r.stdout || ''}${r.stderr || ''}`.trim();
            return { ok: false, error: diag.lastError };
          }
        }
        if (plan.install) {
          onVenvProgress('Installing faster-whisper (one-time, CPU)…');
          await new Promise((resolve, reject) => {
            const pip = spawn(plan.venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check',
                                                '-r', REQS_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            pip.stdout.on('data', (d) => { out += d.toString(); });
            pip.stderr.on('data', (d) => { out += d.toString(); });
            pip.on('error', reject);
            pip.on('exit', (code) => code === 0 ? resolve() : reject(new Error('pip install failed: ' + out.slice(-800))));
          });
          fs.writeFileSync(plan.marker, plan.reqsHash);
        }
        // verify deps importable + capture faster-whisper / cuda info
        const verify = spawnSync(plan.venvPython, ['-c',
          'import faster_whisper, ctranslate2; '
          + 'print(faster_whisper.__version__); '
          + 'print(ctranslate2.__version__); '
          + 'print(ctranslate2.get_cuda_device_count() > 0)'], { encoding: 'utf8' });
        if (verify.status !== 0) {
          diag.lastError = 'verify failed: ' + `${verify.stdout || ''}${verify.stderr || ''}`.trim();
          return { ok: false, error: diag.lastError };
        }
        const lines = (verify.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
        venv = { venvPython: plan.venvPython, pythonVersion: py.version,
                 fasterWhisperVersion: lines[0] || 'unknown', cuda: String(lines[2]) === 'True' };
        diag.fasterWhisperVersion = venv.fasterWhisperVersion;
        diag.cuda = venv.cuda;
        return { ok: true, ...venv };
      } catch (e) {
        diag.lastError = (e && e.message) || String(e);
        return { ok: false, error: diag.lastError };
      }
    }

    function spawnService() {
      if (!venv) throw new Error('venv not ready — call ensureVenv() first');
      child = spawn(venv.venvPython, ['-u', SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        const hello = await channel.request('hello', {}, { timeout: HELLO_TIMEOUT_MS });
        if (hello) {
          diag.pythonVersion = hello.python_version || diag.pythonVersion;
          diag.fasterWhisperVersion = hello.faster_whisper_version || diag.fasterWhisperVersion;
          diag.cuda = !!hello.cuda;
        }
        running = true;
        spawnFailures = 0;
        diag.status = 'started';
        diag.lastError = null;
        if (lastLoad) {
          // a restart mid-session: re-load the last model and resume streaming sids
          try { await channel.request('load', lastLoad, { timeout: 0 }); }
          catch (e) { log('[stt-process] re-load after restart failed', e.message); }
        }
        for (const cb of listeners.status) {
          try { cb({ m: 'status', status: 'ready', active_model: diag.activeModel, cuda: diag.cuda }); }
          catch (e) { /* listener errors are non-fatal */ }
        }
        return true;
      } catch (e) {
        diag.lastError = e && e.message;
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
        return;
      }
      // unexpected: restart with backoff, latch after MAX_SPAWN_FAILURES
      spawnFailures++;
      if (spawnFailures > MAX_SPAWN_FAILURES) {
        latched = true;
        diag.status = 'latched';
        diag.lastError = `service exited ${spawnFailures}× — gave up; degrade to batch`;
        for (const cb of listeners.status) {
          try { cb({ m: 'status', status: 'inactive', reason: diag.lastError }); } catch {}
        }
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, spawnFailures - 1), 8000);
      diag.status = 'restarting';
      diag.lastError = `service exited (code ${code}/${signal || ''}); restarting in ${delay}ms`;
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
      stopping = true;
      latched = false;
      spawnFailures = 0;
      try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch {}
      const c = child;
      if (c) {
        setTimer(() => { try { if (!c.killed) c.kill(); } catch {} }, SHUTDOWN_GRACE_MS);
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
      _channel: channel, _onExit: onExit, _feedStdout: onStdout,
      _setVenv(v) { venv = v; }, _setChild(c) { child = c; }, _setRunning(v) { running = v; },
    };
  },
};
