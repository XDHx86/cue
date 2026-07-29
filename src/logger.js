// Centralized app logging for the Node/Electron side (Pino). Structured, leveled,
// written to a console destination plus a rotating dated file under userData/logs.
//
// This is the APP-wide logger (ADR-014, generalized in P2): one Pino singleton shared
// by every main-process module via a module-scoped child (child('llm'), child('main'),
// child('stt-process')). It is NOT STT-specific; the STT modules were the first users
// (hence the legacy stt-* aliases still exported below for back-comat), but the
// transport machinery — console→stderr + rotating file, level coercion, the
// Python→Pino stderr bridge — is generic.
//
// Singleton: createLogger()/getLogger() cache ONE root logger so the transports are
// never instantiated twice — always exactly one log-file handle, never duplicates.
// Consumers get module-scoped child loggers via child(name). The param-injected STT
// manager (src/stt-process.js) defaults its logger to `noopLogger`, so the pure-Node
// tests never require Pino and never spawn a worker transport (tests stay
// electron-free per .claude/docs/conventions.md).
//
// Python→Pino bridge: the managed Python service emits one JSON log object per
// stderr line (python/cue_stt_logging.py, Loguru). onStderr in stt-process.js
// parses each line with parsePyLogLine() and forwards it through a Pino child at
// mapPyLevelToPino(level) — a Python WARNING becomes a Pino warn, so log levels
// survive the process boundary ("preserving log levels whenever possible").
//
// Pure-JS deps only (pino, pino-pretty, pino-roll) — no native compilation, so
// ADR-003 (no native modules) holds. See ADR-014 in .claude/docs/decisions.md.

const path = require('path');
const fs = require('fs');
const os = require('os');
const pino = require('pino');

const DEFAULT_LEVEL = 'info';            // debug|info|warn|error|fatal
const DEFAULT_ROTATE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_ROTATE_COUNT = 5;          // rotated files kept (+ the active one)
// Base stem for the Node rolling log file. pino-roll v4 appends a rotation segment — the active
// file is `cue-node.1.log`, rotating to `.2.log`, `.3.log`… (and a date segment under daily
// rotation: `cue-node.<YYYY-MM-DD>.1.log`). So this is the BASE, not an exact filename; tests and
// docs glob `cue-node*` rather than read this literally. Python keeps its own cue-python.log stem.
const NODE_LOG_FILE = 'cue-node.log';

const KNOWN_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// Electron's app.getPath is resolved LAZILY (not at module load) — same pattern as
// src/stt-process.js defaultGetPath / src/env.js. Outside Electron (tests / CLI)
// `require('electron')` returns the binary path string, so `app.getPath` would
// throw at load. Tests inject a fake `getPath`; the CLI never uses Pino loggers;
// the production caller (main.js) runs inside Electron. Keeps this require pure.
let _boundGetPath;
function defaultGetPath(name) {
  if (!_boundGetPath) {
    const { app } = require('electron');
    _boundGetPath = app.getPath.bind(app);
  }
  return _boundGetPath(name);
}

// ---- config coercion (env overrides arrive as strings) -------------------
function coerceBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  return fallback;
}

function coerceInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeLevel(v) {
  const s = String(v || '').trim().toLowerCase();
  return KNOWN_LEVELS.includes(s) ? s : DEFAULT_LEVEL;
}

// Resolve a log directory from config. ''/null → userData/logs. An absolute path
// is honored as-is; a relative path resolves under userData. The dir is created
// (recursive) so callers never mkdir. Pure given the injected `getPath`, which is
// only hit when the path isn't already absolute (tests pass a fake or abs path).
function resolveLogDir(logDir, getPath = defaultGetPath) {
  if (logDir && path.isAbsolute(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    return logDir;
  }
  const base = getPath('userData');
  const dir = logDir ? path.join(base, logDir) : path.join(base, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- singleton root logger ------------------------------------------------
let _rootLogger = null;
let _transport = null;       // pino.Transport (worker) when any destination is live

// Build (or reuse) the shared root logger. Idempotent: a second call returns the
// same root — transports are created exactly once (no duplicate log files). Pass
// { console:false, file:false } for a transport-less logger (no worker spawned) —
// used by tests. `getPath` is param-injected so tests never touch Electron.
function createSttLogger(opts = {}) {
  if (_rootLogger) return _rootLogger;

  const level = normalizeLevel(opts.level);
  const useConsole = coerceBool(opts.console, true);
  const useFile = coerceBool(opts.file, true);
  const pretty = coerceBool(opts.pretty, true);
  const rotate = opts.rotate || {};
  const rotateBytes = coerceInt(rotate.sizeBytes, DEFAULT_ROTATE_SIZE_BYTES);
  const rotateCount = coerceInt(rotate.count, DEFAULT_ROTATE_COUNT);

  const loggerOpts = { level, base: { pid: process.pid, service: 'cue' } };

  const targets = [];
  if (useConsole) {
    // Console logs go to STDERR (fd 2), never stdout — stdout stays reserved for machine-readable
    // results (the CLI's `console.log` status lines; the app's stdout is immaterial). This matches
    // the unix convention and the stt-cli.js precedent (progress already routed to stderr).
    targets.push(pretty
      ? { target: 'pino-pretty', level, options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l', singleLine: true, ignore: 'service', destination: 2 } }
      : { target: 'pino/file', level, options: { destination: 2 } });
  }
  if (useFile) {
    const dir = resolveLogDir(opts.logDir, opts.getPath);
    const file = path.join(dir, NODE_LOG_FILE);
    // pino-roll v4: `limit` is { count } (not a bare number); `size` is MB when no
    // unit. Size rotation when rotateBytes is set, else daily.
    const rollOpts = { file, mkdir: true, limit: { count: rotateCount } };
    if (rotateBytes > 0) rollOpts.size = Math.max(1, Math.round(rotateBytes / (1024 * 1024)));
    else rollOpts.frequency = 'daily';
    targets.push({ target: 'pino-roll', level, options: rollOpts });
  }

  if (targets.length) {
    // pino.transport({targets}) returns a ThreadStream (a write stream that multiplexes to the
    // worker-thread targets). It is passed as the DESTINATION (2nd arg), not the `transport`
    // option — pino 10 rejects a stream under `transport` ("option.transport do not allow
    // stream"); the `transport` option expects a descriptor object, while a resolved stream is
    // a destination. This is the documented `pino(options, transport)` form.
    _transport = pino.transport({ targets });
    // A transport failure (e.g. disk full / packaged-app worker hiccup) must never
    // break the STT pipeline — surface it best-effort and keep running.
    _transport.on('error', (e) => { try { console.warn('[logger] transport error', e && e.message); } catch {} });
    _rootLogger = pino(loggerOpts, _transport);
    return _rootLogger;
  }
  // No destinations → a plain pino logger writing to the platform null device (no worker thread),
  // so a "log nothing" (console:false, file:false) config stays silent and tests never print to
  // stdout. Safe for the pure-Node test suite (nothing dangles across `node --test` runs).
  _rootLogger = pino(loggerOpts, fs.createWriteStream(os.devNull));
  return _rootLogger;
}

// Lazy init-once from a settings object (main.js: getSttLogger(settings)).
// Subsequent calls reuse the cached root regardless of cfg.
function getSttLogger(cfg) {
  if (_rootLogger) return _rootLogger;
  const logging = (cfg && cfg.stt && cfg.stt.logging) || {};
  return createSttLogger({
    level: logging.level, logDir: logging.logDir,
    console: logging.console, file: logging.file, pretty: logging.pretty,
    rotate: logging.rotate,
  });
}

// App-level entry (P2 generalization). Reads the top-level `logging` config block;
// falls back to the legacy `stt.logging` block so existing settings keep working
// during the transition (one app logger, not a second STT-only one).
function getLogger(cfg) {
  if (_rootLogger) return _rootLogger;
  const logging = (cfg && cfg.logging) || (cfg && cfg.stt && cfg.stt.logging) || {};
  return createSttLogger({
    level: logging.level, logDir: logging.logDir,
    console: logging.console, file: logging.file, pretty: logging.pretty,
    rotate: logging.rotate,
  });
}

// Module-scoped child for a consumer. main.js inits first via getSttLogger(settings),
// then sttChild('stt-process') throughout. A child with no init first falls back to
// defaults (Electron userData) — acceptable inside the app process.
function sttChild(name, bindings = {}) {
  return getSttLogger().child({ module: name, ...bindings });
}

// Neutral alias (P2): app modules call child('llm') / child('main'); STT modules keep
// using sttChild. Same singleton, same `module`-tagged children — one log stream.
function child(name, bindings = {}) {
  return getLogger().child({ module: name, ...bindings });
}

// Flush + drop the root so a fresh configuration can rebuild it (app quit / tests).
// Returns the transport's end() promise when a transport was live (best-effort drain),
// or undefined for a transport-less logger — so callers that want a clean flush before
// exit (scripts/stt-cli.js) can `await stopSttLogger()`; the synchronous will-quit handler
// simply ignores the return. Idempotent: a second call is a no-op.
function stopSttLogger() {
  const t = _transport;
  _transport = null;
  _rootLogger = null;
  if (!t) return undefined;
  try {
    // This is a DELIBERATE shutdown: the ThreadStream emits "the worker is ending"/"the worker has
    // exited" as 'error' events on end(). They are not faults — detach our best-effort error
    // surface first so tearing down the logger doesn't spam console.warn (a real mid-run fault,
    // e.g. disk full, fires 'error' while the listener is still attached and still surfaces).
    t.removeAllListeners('error');
    const p = t.end();
    if (p && typeof p.then === 'function') { p.catch(() => {}); return p; }
  } catch {}
  return undefined;
}

// ---- Python→Pino level bridge ---------------------------------------------
// Map Loguru level names to pino level methods. Logurus used here: DEBUG/INFO/
// WARNING/ERROR/CRITICAL; pino: trace/debug/info/warn/error/fatal.
const PY_LEVEL_MAP = {
  DEBUG: 'debug', INFO: 'info', WARNING: 'warn', WARN: 'warn',
  ERROR: 'error', CRITICAL: 'fatal', FATAL: 'fatal', TRACE: 'trace',
};
function mapPyLevelToPino(level) {
  if (!level) return 'info';
  return PY_LEVEL_MAP[String(level).toUpperCase()] || 'info';
}

// Parse one Python stderr line into a compact record, or null if it isn't a
// Loguru JSON log line (so non-JSON / crash banner lines fall through to debug).
function parsePyLogLine(line) {
  if (!line) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !obj.level) return null;
  return {
    level: obj.level,
    message: obj.message,
    module: obj.module,
    pid: obj.pid,
    ts: obj.ts,
    extra: obj.extra,
    traceback: obj.traceback,
  };
}

// Forward one decoded Python stderr line through a Pino logger, preserving the
// level. Returns true if the line was a structured (JSON) Python log line. Used by
// the manager's onStderr; levels below the logger's level are dropped by pino, so
// the configured log level applies uniformly across Node and Python.
function logPyStderrLine(logger, line, { pyModule = 'python' } = {}) {
  const rec = parsePyLogLine(line);
  if (rec) {
    const fn = logger[mapPyLevelToPino(rec.level)] || logger.info;
    fn.call(logger, {
      py: true, pyLevel: rec.level, pyModule: rec.module || pyModule,
      pyPid: rec.pid, pyTime: rec.ts, pyExtra: rec.extra, pyTraceback: rec.traceback,
    }, String(rec.message || ''));
    return true;
  }
  logger.debug({ py: true, pyModule }, String(line));
  return false;
}

// ---- noop logger (param-injected default for stt-process.js + tests) ------
// Same shape as a pino logger: level methods + `.child()` + `.flush()`. The level
// methods accept pino's `info(obj, msg)` / `info(msg)` overloads but discard them —
// the manager calls `log.info({...}, "msg")` and `logPyStderrLine` reads by level.
const noopLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return noopLogger; },
  flush() {},
};

module.exports = {
  // Neutral app-level API (P2). Preferred for new consumers.
  createLogger: createSttLogger, getLogger, child, stopLogger: stopSttLogger,
  _resetLogger: stopSttLogger,
  // Legacy STT-named aliases (back-comat for src/stt-process.js, src/stt-stream.js,
  // scripts/stt-cli.js, and test/logger.test.js). Same underlying singleton.
  createSttLogger, getSttLogger, sttChild, stopSttLogger,
  noopLogger,
  mapPyLevelToPino, parsePyLogLine, logPyStderrLine,
  resolveLogDir, normalizeLevel, coerceBool, coerceInt,
  defaultGetPath,
  NODE_LOG_FILE, DEFAULT_LEVEL, DEFAULT_ROTATE_SIZE_BYTES, DEFAULT_ROTATE_COUNT,
  // test-only escape hatch: reset the singleton between cases without leaving a
  // dangling transport from a previous one.
  _resetSttLogger: stopSttLogger,
};
