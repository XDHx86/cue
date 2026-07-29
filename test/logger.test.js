const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  createSttLogger, getSttLogger, sttChild, stopSttLogger, noopLogger,
  mapPyLevelToPino, parsePyLogLine, logPyStderrLine,
  resolveLogDir, normalizeLevel, coerceBool, coerceInt,
  NODE_LOG_FILE, DEFAULT_LEVEL,
  _resetSttLogger,
} = require('../src/logger');

// The singleton root logger + its pino.transport worker must not leak between tests (a leftover
// transport from one case would defeat the idempotency assertions and could dangle a worker).
const setup = require('node:test');
setup.beforeEach(() => _resetSttLogger());
setup.afterEach(() => _resetSttLogger());

// Temp dirs created by resolveLogDir (it makedirs unconditionally) are cleaned up here.
const _tmpRoots = [];
setup.afterEach(() => {
  for (const d of _tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  _tmpRoots.length = 0;
});
function tmpRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-stt-log-'));
  _tmpRoots.push(d);
  return d;
}

// ---- level / bool / int coercion (shared by Node logger + CLI + store) ----
test('normalizeLevel: known levels lowercased; unknown/empty/null → DEFAULT_LEVEL', () => {
  assert.equal(normalizeLevel('info'), 'info');
  assert.equal(normalizeLevel('INFO'), 'info');
  assert.equal(normalizeLevel('WARN'), 'warn');
  assert.equal(normalizeLevel('error'), 'error');
  assert.equal(normalizeLevel('fatal'), 'fatal');
  assert.equal(normalizeLevel('debug'), 'debug');
  assert.equal(normalizeLevel('trace'), 'trace');
  assert.equal(normalizeLevel('verbose'), DEFAULT_LEVEL, 'unknown → default');
  assert.equal(normalizeLevel(''), DEFAULT_LEVEL);
  assert.equal(normalizeLevel(null), DEFAULT_LEVEL);
  assert.equal(normalizeLevel(undefined), DEFAULT_LEVEL);
});

test('coerceBool maps truthy/falsy strings + bools; unrecognized → fallback', () => {
  for (const t of ['true', '1', 'on', 'yes', 'True', 'ON']) assert.equal(coerceBool(t, false), true, `${t} → true`);
  for (const f of ['false', '0', 'off', 'no', 'False', 'OFF']) assert.equal(coerceBool(f, true), false, `${f} → false`);
  assert.equal(coerceBool(true, false), true);
  assert.equal(coerceBool(false, true), false);
  assert.equal(coerceBool('maybe', true), true, 'unrecognized string keeps the fallback');
  assert.equal(coerceBool('maybe', false), false);
  assert.equal(coerceBool(undefined, true), true, 'absent → fallback');
  assert.equal(coerceBool(undefined, false), false);
  assert.equal(coerceBool(null, false), false);
});

test('coerceInt maps ints/numeric strings; 0/negative/garbage/absent → fallback', () => {
  assert.equal(coerceInt(5, 99), 5);
  assert.equal(coerceInt('10', 99), 10);
  assert.equal(coerceInt(0, 99), 99, '0 is not >0 → fallback');
  assert.equal(coerceInt(-3, 99), 99, 'negative → fallback');
  assert.equal(coerceInt('abc', 99), 99);
  assert.equal(coerceInt(undefined, 99), 99);
  assert.equal(coerceInt(null, 7), 7);
});

// ---- logDir resolution (mkdir side-effects isolated in temp dirs) ----
test('resolveLogDir: absolute path honored + created; absolute "" / empty → <userData>/logs', () => {
  const base = tmpRoot();
  const sub = path.join(base, 'sub', 'logs');
  assert.equal(resolveLogDir(sub), sub);
  assert.equal(fs.existsSync(sub), true, 'mkdir -p created the absolute dir');
});

test('resolveLogDir: empty logDir resolves under the injected userData via getPath + makedirs', () => {
  const base = tmpRoot();
  const out = resolveLogDir('', () => base);
  assert.equal(out, path.join(base, 'logs'));
  assert.equal(fs.existsSync(out), true);
});

test('resolveLogDir: a relative logDir resolves under userData', () => {
  const base = tmpRoot();
  const out = resolveLogDir('sessions', () => base);
  assert.equal(out, path.join(base, 'sessions'));
  assert.equal(fs.existsSync(out), true);
});

test('resolveLogDir: an absolute logDir wins over getPath (getPath is never called)', () => {
  const base = tmpRoot();
  const abs = path.join(base, 'abs');
  let called = false;
  const out = resolveLogDir(abs, () => { called = true; return base; });
  assert.equal(out, abs);
  assert.equal(called, false, 'getPath not consulted for an absolute path');
});

// ---- Python → Pino level bridge ----
test('mapPyLevelToPino maps Loguru levels to pino level method names; unknown → info', () => {
  assert.equal(mapPyLevelToPino('DEBUG'), 'debug');
  assert.equal(mapPyLevelToPino('INFO'), 'info');
  assert.equal(mapPyLevelToPino('warning'), 'warn');
  assert.equal(mapPyLevelToPino('WARN'), 'warn');
  assert.equal(mapPyLevelToPino('WARNING'), 'warn');
  assert.equal(mapPyLevelToPino('ERROR'), 'error');
  assert.equal(mapPyLevelToPino('CRITICAL'), 'fatal');
  assert.equal(mapPyLevelToPino('FATAL'), 'fatal');
  assert.equal(mapPyLevelToPino('TRACE'), 'trace');
  assert.equal(mapPyLevelToPino('mystery'), 'info', 'unknown level → info');
  assert.equal(mapPyLevelToPino(''), 'info');
  assert.equal(mapPyLevelToPino(null), 'info');
  assert.equal(mapPyLevelToPino(undefined), 'info');
});

test('parsePyLogLine decodes a structured (JSON) Loguru line; returns null otherwise', () => {
  const line = JSON.stringify({ level: 'INFO', message: 'hi', module: 'svc', pid: 12,
    ts: '2026-01-01T00:00:00Z', extra: { model: 'small' } });
  const rec = parsePyLogLine(line);
  assert.equal(rec.level, 'INFO');
  assert.equal(rec.message, 'hi');
  assert.equal(rec.module, 'svc');
  assert.equal(rec.pid, 12);
  assert.equal(rec.extra.model, 'small');
  assert.equal(parsePyLogLine('not json'), null);
  assert.equal(parsePyLogLine(''), null);
  assert.equal(parsePyLogLine(null), null);
  assert.equal(parsePyLogLine(JSON.stringify({ noLevel: true })), null, 'level is required');
  const tb = parsePyLogLine(JSON.stringify({ level: 'ERROR', traceback: 'TB' }));
  assert.equal(tb.traceback, 'TB', 'traceback carried through');
});

// A pino-shaped logger that records every level call; child() shares the same call log so a
// consumer that derives a child (the manager does) still records into the same array.
function recordingLogger(sharedCalls) {
  const calls = sharedCalls || [];
  function mk(lvl) { return function (o, m) { calls.push({ lvl, o, m }); }; }
  const log = {
    trace: mk('trace'), debug: mk('debug'), info: mk('info'),
    warn: mk('warn'), error: mk('error'), fatal: mk('fatal'),
    child() { return recordingLogger(calls); }, flush() {},
  };
  log._calls = calls;
  return log;
}

test('logPyStderrLine forwards a structured line at the matching level and returns true', () => {
  const rec = recordingLogger();
  const ok = logPyStderrLine(rec, JSON.stringify({
    level: 'WARNING', message: 'warm', module: 'cue_stt_service', pid: 7, ts: 't', extra: { x: 1 },
  }));
  assert.equal(ok, true, 'a JSON Loguru line is a structured line');
  const ws = rec._calls.filter((c) => c.lvl === 'warn');
  assert.equal(ws.length, 1);
  assert.equal(ws[0].m, 'warm');
  assert.equal(ws[0].o.py, true);
  assert.equal(ws[0].o.pyLevel, 'WARNING');
  assert.equal(ws[0].o.pyModule, 'cue_stt_service');
  assert.equal(ws[0].o.pyExtra.x, 1);
});

test('logPyStderrLine drops a non-JSON line to debug and returns false', () => {
  const rec = recordingLogger();
  const ok = logPyStderrLine(rec, 'numpy: falling back to slow path');
  assert.equal(ok, false, 'a non-JSON line is not a structured line');
  const dbg = rec._calls.filter((c) => c.lvl === 'debug');
  assert.equal(dbg.length, 1);
  assert.equal(dbg[0].o.py, true);
  assert.ok(typeof dbg[0].m === 'string' && dbg[0].m.includes('numpy'), 'raw text survives as the message');
});

// ---- singleton lifecycle + idempotency (transport-less to avoid spawning workers in tests) ----
test('createSttLogger is idempotent: a second call returns the same root (no duplicate transports)', () => {
  const a = createSttLogger({ console: false, file: false });
  const b = createSttLogger({ console: false, file: false });
  assert.equal(a, b, 'same instance — the transport set is built exactly once');
});

test('getSttLogger builds from a settings object once and caches the root regardless of later cfg', () => {
  const root = getSttLogger({ stt: { logging: { level: 'debug', console: false, file: false } } });
  assert.ok(root && typeof root.info === 'function');
  assert.equal(getSttLogger({ stt: { logging: { level: 'error' } } }), root,
    'a second call is a cache hit — the new config is ignored');
});

test('sttChild returns a child logger bound to its module name without rebuilding the root', () => {
  const root = getSttLogger({ stt: { logging: { console: false, file: false } } });
  const child = sttChild('stt-process');
  assert.ok(typeof child.info === 'function');
  assert.notEqual(child, root, 'a distinct child logger');
  // child.info must not throw (it writes through the transport-less root synchronously)
  assert.doesNotThrow(() => child.info({ x: 1 }, 'ok'));
});

test('stopSttLogger drops the root so a new config can rebuild it', () => {
  const a = createSttLogger({ console: false, file: false });
  const p = stopSttLogger();
  // transport-less logger has no worker → no flush promise
  assert.equal(p, undefined);
  const b = createSttLogger({ console: false, file: false });
  assert.notEqual(a, b, 'a fresh root after reset');
});

test('noopLogger: level methods are no-ops; child() returns noopLogger; flush is a no-op', () => {
  assert.doesNotThrow(() => {
    noopLogger.trace({ a: 1 }, 'm');
    noopLogger.info('whatever');
    noopLogger.warn();
    noopLogger.error(new Error('e'));
    noopLogger.fatal({ x: 1 }, 'kaboom');
    noopLogger.child({ module: 'x' }).info('nested');
    noopLogger.flush();
  });
  assert.strictEqual(noopLogger.child({ module: 'x' }), noopLogger, 'child is the same noop singleton');
});

// ---- rotating-file write integration (the only worker-spawning test) ----
test('createSttLogger writes a structured line to a rotating file under an absolute logDir and flushes on stopSttLogger', async () => {
  const dir = tmpRoot();
  const root = createSttLogger({
    level: 'info', console: false, file: true, pretty: false, logDir: dir,
    rotate: { count: 3 },
  });
  root.info({ hello: 'world' }, 'integration line');
  const flush = stopSttLogger();
  if (flush && typeof flush.then === 'function') await flush;

  // pino-roll v4 EXTENDS the base stem with a rotation segment: the active file is
  // cue-node.1.log (a date segment appears under daily rotation: cue-node.<date>.1.log). So we
  // scan the dir for any cue-node* file and poll (bounded) for its content instead of reading a
  // hard-coded name — robust to both the worker's async first-write and the extension format.
  const entry = await new Promise((resolve) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.startsWith('cue-node')); } catch {}
      for (const n of names) {
        try { if (fs.readFileSync(path.join(dir, n), 'utf8').length) return resolve(n); } catch {}
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.ok(entry, 'a cue-node* rolling file was created and received content within 3s');
  const text = fs.readFileSync(path.join(dir, entry), 'utf8');
  assert.match(text, /integration line/, 'the message reached the rotating file');
  assert.match(text, /"hello":"world"/, 'structured payload was serialized');
  assert.match(text, /"service":"cue"/, 'base bindings (pid, service) are present');
  assert.match(text, /"pid":\d+/, 'process id context is present');
  assert.ok(entry.startsWith('cue-node') && entry !== NODE_LOG_FILE,
    'pino-roll v4 appended a rotation segment to the base stem (cue-node.1.log)');
});
