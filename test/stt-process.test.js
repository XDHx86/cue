const assert = require('node:assert/strict');
const test = require('node:test');

const {
  encodeJsonLine, parseJsonLine, RpcChannel,
  pickPython, parsePyVer, venvPythonPath, buildVenvPlan, requirementsHash, buildPyLogEnv,
  createSttProcessManager, MAX_SPAWN_FAILURES, DEFAULT_ENGINE_SPEC,
} = require('../src/stt-process');
const path = require('node:path');

// ---- framing ----
test('encodeJsonLine appends a newline and round-trips through parseJsonLine', () => {
  const o = { id: '1', m: 'hello', name: 'smål «»', n: { a: [1, 2] } };
  const line = encodeJsonLine(o);
  assert.ok(line.endsWith('\n'), 'terminates with newline');
  assert.deepEqual(parseJsonLine(line.trim()), o, 'round-trips nested + non-ASCII');
});

test('parseJsonLine returns null for unparseable input', () => {
  assert.equal(parseJsonLine('not json'), null);
  assert.equal(parseJsonLine(''), null);
});

// ---- RpcChannel ----
test('RpcChannel.request resolves with the response result correlated by id', async () => {
  const sent = [];
  const ch = new RpcChannel({ send: (l) => sent.push(l), onEvent: () => {} });
  const p = ch.request('hello', { a: 1 }, { timeout: 0 });
  const req = JSON.parse(sent[0]);
  assert.equal(req.m, 'hello'); assert.equal(req.a, 1); assert.ok(req.id);
  ch.feedLine({ id: req.id, ok: true, result: { x: 1 } });
  assert.deepEqual(await p, { x: 1 });
});

test('RpcChannel rejects on an ok:false response with the error string', async () => {
  const ch = new RpcChannel({ send: () => {}, onEvent: () => {} });
  const p = ch.request('boom', {}, { timeout: 0 });
  ch.feedLine({ id: '1', ok: false, error: 'explode' });
  await assert.rejects(() => p, /explode/);
});

test('RpcChannel lifts bare events ({m, no id}) to onEvent', () => {
  const events = [];
  const ch = new RpcChannel({ send: () => {}, onEvent: (e) => events.push(e) });
  ch.feedLine({ m: 'partial', sid: '1', text: 'hi' });
  ch.feedLine({ m: 'final', sid: '1', text: 'hi there' });
  ch.feedLine({ m: 'status', status: 'ready', model: 'small' });
  assert.equal(events.length, 3);
  assert.equal(events[0].m, 'partial'); assert.equal(events[2].model, 'small');
});

test('RpcChannel times out pending requests when no response arrives', async () => {
  const ch = new RpcChannel({ send: () => {}, onEvent: () => {} });
  await assert.rejects(() => ch.request('slow', {}, { timeout: 15 }), /timeout: slow/);
});

test('RpcChannel.rejectAll rejects every pending request', async () => {
  const ch = new RpcChannel({ send: () => {}, onEvent: () => {} });
  const p1 = ch.request('a', {}, { timeout: 0 });
  const p2 = ch.request('b', {}, { timeout: 0 });
  ch.rejectAll(new Error('service exited'));
  await assert.rejects(() => p1, /service exited/);
  await assert.rejects(() => p2, /service exited/);
  assert.equal(ch.hasPending(), false);
});

test('RpcChannel ignores malformed lines and unknown shapes', () => {
  const events = [];
  const ch = new RpcChannel({ send: () => {}, onEvent: (e) => events.push(e) });
  ch.feedLineStr('not json');
  ch.feedLine(null);
  assert.equal(events.length, 0);
});

// ---- python detection ----
function fakeSpawnSync(table) {
  return (exe) => {
    const t = table[exe];
    if (!t) return { status: -1 };
    return { status: t.status, stdout: t.stdout || '', stderr: t.stderr || '' };
  };
}

test('pickPython returns the first interpreter at 3.10+', () => {
  const ss = fakeSpawnSync({ python3: { status: 0, stdout: 'Python 3.11.2\n' } });
  const py = pickPython(ss);
  assert.equal(py && py.exe, 'python3');
  assert.match(py.version, /3\.11/);
});

test('pickPython skips an older 3.8 and returns a later candidate', () => {
  const ss = fakeSpawnSync({
    python3: { status: 0, stdout: 'Python 3.8.10\n' },
    python: { status: 0, stdout: 'Python 3.10.12\n' },
  });
  const py = pickPython(ss);
  assert.equal(py && py.exe, 'python');
  assert.match(py.version, /3\.10/);
});

test('pickPython returns null when no decent Python is present', () => {
  const ss = fakeSpawnSync({ python3: { status: 127 }, python: { status: 0, stdout: 'Python 3.7.0' } });
  assert.equal(pickPython(ss), null);
});

test('parsePyVer extracts major.minor and rejects garbage', () => {
  assert.deepEqual(parsePyVer('Python 3.11.2'), { major: 3, minor: 11 });
  assert.equal(parsePyVer('nope'), null);
});

test('venvPythonPath is Scripts/python.exe on win32, bin/python elsewhere', () => {
  assert.equal(venvPythonPath('/v', 'win32').replace(/\\/g, '/'), '/v/Scripts/python.exe');
  assert.equal(venvPythonPath('/v', 'darwin').replace(/\\/g, '/'), '/v/bin/python');
});

// ---- venv plan (no spawning; pure given injected fs state) ----
function memFs(files) {
  // path.join on Windows yields backslashes; normalize both keys and lookups so
  // the fake fs is separator-agnostic (the real fs.join result still resolves).
  const norm = (p) => String(p).replace(/\\/g, '/');
  const store = {};
  for (const [k, v] of Object.entries(files)) store[norm(k)] = v;
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(store, norm(p)),
    readFileSync: (p) => store[norm(p)] || '',
    writeFileSync: (p, v) => { store[norm(p)] = v; },
  };
}

test('buildVenvPlan: fresh install → create + install true', () => {
  const fs = memFs({});
  const plan = buildVenvPlan({ userDataPath: '/ud', platform: 'darwin', fs, reqsHash: 'h' });
  assert.equal(plan.create, true);
  assert.equal(plan.install, true);
  assert.equal(plan.venvPython.replace(/\\/g, '/'), '/ud/stt-venv/bin/python');
});

test('buildVenvPlan: venv exists + marker matches hash → no create, no install', () => {
  const fs = memFs({
    '/ud/stt-venv/bin/python': 'exe',
    '/ud/stt-venv/cue-installed.txt': 'h',
  });
  const plan = buildVenvPlan({ userDataPath: '/ud', platform: 'darwin', fs, reqsHash: 'h' });
  assert.equal(plan.create, false);
  assert.equal(plan.install, false);
});

test('buildVenvPlan: requirements.txt changed (hash mismatch) → re-install, no recreate', () => {
  const fs = memFs({
    '/ud/stt-venv/bin/python': 'exe',
    '/ud/stt-venv/cue-installed.txt': 'old',
  });
  const plan = buildVenvPlan({ userDataPath: '/ud', platform: 'darwin', fs, reqsHash: 'new' });
  assert.equal(plan.create, false);
  assert.equal(plan.install, true, 'a changed requirements.txt re-runs pip');
});

// ---- requirements hash (deterministic, from injected fs) ----
test('requirementsHash returns a deterministic sha1 of python/requirements.txt', () => {
  const fs = memFs({ [require('path').join(__dirname, '..', 'python', 'requirements.txt')]: 'faster-whisper==1.1.1\n' });
  const h = requirementsHash(fs);
  assert.equal(/[0-9a-f]{40}/.test(h), true, '40-hex sha1');
  assert.equal(requirementsHash(fs), h, 'stable for identical content');
});

// ---- manager lifecycle: restart-latch + diagnostics via injected spawn ----
// (No Python is spawned. The venv is pre-injected and `setTimeout` is a no-op so
// we can drive the crash-latch decision deterministically.)
test('manager latches (degrade-to-batch) after MAX consecutive crashes and emits inactive', () => {
  const { createSttProcessManager, MAX_SPAWN_FAILURES } = require('../src/stt-process');
  const statuses = [];
  const m = createSttProcessManager({
    spawn: () => null,
    spawnSync: () => ({ status: 0 }),
    fs: memFs({}),
    getPath: () => '/ud',
    log: () => {},
    setTimeout: () => 0,   // don't actually schedule restarts — we drive _onExit by hand
    clearTimeout: () => {},
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });
  m._setRunning(true);
  m.on('status', (s) => statuses.push(s.status));

  for (let i = 0; i < MAX_SPAWN_FAILURES; i++) m._onExit(1, null);
  assert.equal(m.isLatched(), false, `not yet latched after ${MAX_SPAWN_FAILURES} crashes`);
  m._onExit(1, null); // the one that pushes spawnFailures over MAX
  assert.equal(m.isLatched(), true, 'latched after exceeding MAX_SPAWN_FAILURES');
  assert.ok(statuses.includes('restarting'), 'reported restarting on the way down');
  assert.ok(statuses.includes('inactive'), 'emitted inactive once latched');
  const diag = m.diagnostics();
  assert.equal(diag.latched, true);
  assert.match(diag.lastError || '', /gave up/i);
});

test('manager.start() succeeds when the spawned service answers hello with the matching id', async () => {
  const { createSttProcessManager } = require('../src/stt-process');
  const m = createSttProcessManager({
    spawn: () => makeEchoChild(),
    spawnSync: () => ({ status: 0 }),
    fs: memFs({}),
    getPath: () => '/ud',
    log: () => {},
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });

  function makeEchoChild() {
    const dataCbs = [];
    const child = {
      stdin: { destroyed: false, write(line) { const o = parseJsonLine(line.trim()); if (o && o.id) setImmediate(() => dataCbs.forEach((cb) => cb(Buffer.from(JSON.stringify({ id: o.id, ok: true, result: { python_version: '3.11.2', cuda: false } }) + '\n')))); }, end() {} },
      stdout: { on(ev, cb) { if (ev === 'data') dataCbs.push(cb); } },
      stderr: { on() {} },
      on() {}, kill() {}, killed: false,
    };
    return child;
  }

  assert.equal(await m.start(), true, 'start resolved true once hello round-tripped');
  assert.equal(m.isRunning(), true);
  const diag = m.diagnostics();
  assert.equal(diag.running, true);
  assert.equal(diag.pythonVersion, '3.11.2');
  assert.equal(diag.cuda, false);
  m.stop();
});

// ---- logging config → Python env passthrough (buildPyLogEnv, ADR-014) ----
// The manager turns a settings.stt.logging-shaped block into CUE_STT_LOG_* env for the spawned
// Python service (python/cue_stt_logging.py setup_logging reads these). logDir is resolved to
// an ABSOLUTE <userData>/logs here so Node + Python rotating logs share one directory; an unset
// key is omitted (Python applies its own default) rather than forced to a string.

test('buildPyLogEnv returns {} when no logging config is given', () => {
  assert.deepEqual(buildPyLogEnv(null, null, () => '/ud'), {});
  assert.deepEqual(buildPyLogEnv(undefined, null, () => '/ud'), {});
});

test('buildPyLogEnv maps every set field to a CUE_STT_LOG_* env string and resolves logDir absolutely', () => {
  const env = buildPyLogEnv(
    { level: 'debug', console: false, file: true, pretty: false, rotate: { sizeBytes: 5242880, count: 5 } },
    null,
    () => '/ud',
  );
  assert.equal(env.CUE_STT_LOG_LEVEL, 'debug');
  assert.equal(env.CUE_STT_LOG_CONSOLE, 'false');
  assert.equal(env.CUE_STT_LOG_FILE, 'true');
  assert.equal(env.CUE_STT_LOG_PRETTY, 'false');
  assert.equal(env.CUE_STT_LOG_ROTATE_SIZE, '5242880');
  assert.equal(env.CUE_STT_LOG_ROTATE_COUNT, '5');
  assert.equal(env.CUE_STT_LOG_DIR.replace(/\\/g, '/'), '/ud/logs',
    'an empty/absent logDir resolves to <userData>/logs (absolute) so Python makedirs works');
});

test('buildPyLogEnv omits unset keys (Python applies its own default) but always resolves logDir', () => {
  const env = buildPyLogEnv({ level: 'warn' }, null, () => '/ud');
  assert.equal(env.CUE_STT_LOG_LEVEL, 'warn');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CUE_STT_LOG_CONSOLE'), false,
    'unset keys are omitted, not forced to a string');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CUE_STT_LOG_FILE'), false);
  assert.ok(env.CUE_STT_LOG_DIR, 'logDir is always resolved so a rotating file target is set');
});

test('buildPyLogEnv honors an absolute logDir as-is; a relative one resolves under userData', () => {
  const abs = buildPyLogEnv({ logDir: '/var/log/cue' }, null, () => '/ud');
  assert.equal(abs.CUE_STT_LOG_DIR.replace(/\\/g, '/'), '/var/log/cue');
  const rel = buildPyLogEnv({ logDir: 'sessions/logs' }, null, () => '/ud');
  assert.equal(rel.CUE_STT_LOG_DIR.replace(/\\/g, '/'), '/ud/sessions/logs');
});

// ---- Python stderr → Pino forwarding / level preservation (ADR-014) ----
// The spawned service emits one Loguru JSON object per stderr line. The manager buffers stderr by
// newlines, parses each with parsePyLogLine, and forwards it through its (injected) logger at
// mapPyLevelToPino(level) — a Python WARNING becomes a Pino warn — preserving log levels across the
// process boundary. A pino-shaped recording logger captures the forwarded calls for assertions.

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

test('manager forwards a Loguru JSON stderr line through the logger at the matching level', () => {
  const rec = recordingLogger();
  const m = createSttProcessManager({
    spawn: () => null, spawnSync: () => ({ status: 0 }), fs: memFs({}),
    getPath: () => '/ud', logger: rec,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });
  m._setRunning(true);

  const line = JSON.stringify({
    level: 'WARNING', message: 'model warm', module: 'cue_stt_service', pid: 12,
    ts: '2026-01-01T00:00:00Z', extra: { model: 'small' },
  });
  m._feedStderr(Buffer.from(line + '\n', 'utf8'));

  const ws = rec._calls.filter((c) => c.lvl === 'warn');
  assert.equal(ws.length, 1, 'exactly one warn forwarded');
  assert.equal(ws[0].m, 'model warm');
  assert.equal(ws[0].o.py, true);
  assert.equal(ws[0].o.pyLevel, 'WARNING', 'original Loguru level preserved in the payload');
  assert.equal(ws[0].o.pyModule, 'cue_stt_service');
  assert.equal(ws[0].o.pyExtra.model, 'small');
});

test('manager forwards a CRITICAL/traceback line at fatal and a non-JSON line at debug', () => {
  const rec = recordingLogger();
  const m = createSttProcessManager({
    spawn: () => null, spawnSync: () => ({ status: 0 }), fs: memFs({}),
    getPath: () => '/ud', logger: rec,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });
  m._setRunning(true);

  const crit = JSON.stringify({ level: 'CRITICAL', message: 'oom', module: 'svc',
    pid: 1, ts: 't', extra: null, traceback: 'Traceback (most recent call last):\n  boom' });
  m._feedStderr(Buffer.from(crit + '\n', 'utf8'));
  const fatals = rec._calls.filter((c) => c.lvl === 'fatal');
  assert.equal(fatals.length, 1, 'Python CRITICAL → pino fatal');
  assert.equal(fatals[0].m, 'oom');
  assert.ok(fatals[0].o.pyTraceback && fatals[0].o.pyTraceback.includes('Traceback'),
    'traceback carried through to the log');

  m._feedStderr(Buffer.from('numpy: falling back to slow path\n', 'utf8'));
  const dbg = rec._calls.filter((c) => c.lvl === 'debug' && c.o && c.o.py === true);
  assert.equal(dbg.length, 1, 'a non-JSON free-form stderr line falls through to debug');
  assert.ok(typeof dbg[0].m === 'string' && dbg[0].m.includes('numpy'),
    'the raw line text survives as the message');
});

test('manager buffers a Python JSON log split across pipe chunks into one forwarded line', () => {
  // stderr arrives as arbitrary byte chunks; the line framer must reassemble a JSON line split
  // across chunk boundaries before parsing it as a single record (no half-line JSON parse).
  const rec = recordingLogger();
  const m = createSttProcessManager({
    spawn: () => null, spawnSync: () => ({ status: 0 }), fs: memFs({}),
    getPath: () => '/ud', logger: rec,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });
  m._setRunning(true);

  const full = JSON.stringify({ level: 'ERROR', message: 'partial chunk ok', module: 'svc' });
  const half = Math.floor(full.length / 2);
  m._feedStderr(Buffer.from(full.slice(0, half), 'utf8'));   // no newline yet
  assert.equal(rec._calls.filter((c) => c.lvl === 'error').length, 0, 'not flushed before the newline');
  m._feedStderr(Buffer.from(full.slice(half) + '\n', 'utf8'));
  const errs = rec._calls.filter((c) => c.lvl === 'error');
  assert.equal(errs.length, 1, 'reassembled into exactly one forwarded error line');
  assert.equal(errs[0].m, 'partial chunk ok');
});

// ---- generalized engine spec (multi-manager: faster-whisper + FunASR) ----
// The manager grew up hardcoded to faster-whisper; threading an engine "spec" (script /
// requirements / venv dir name / models dir name / verify import) lets a SECOND offline
// engine (FunASR) run its own isolated service with its own venv, so a torch-vs-CTranslate2
// stack never collides. The defaults are byte-for-byte the old literals (backward-compat),
// and the verify-import surface lets each engine report its own version string. The happy
// path is driven by a fake child that round-trips the `hello` handshake back; `ensureVenv`
// is not exercised here (no Python is spawned) — the venv is pre-injected, as in the
// lifecycle tests above.

test('DEFAULT_ENGINE_SPEC points at the faster-whisper script + venv (backward-compat default)', () => {
  assert.equal(DEFAULT_ENGINE_SPEC.venvDirName, 'stt-venv');
  assert.equal(DEFAULT_ENGINE_SPEC.modelsDirName, 'stt-models');
  assert.ok(DEFAULT_ENGINE_SPEC.scriptPath.endsWith('cue_stt_service.py'),
    'default script is the faster-whisper service');
  assert.ok(DEFAULT_ENGINE_SPEC.requirementsPath.endsWith('requirements.txt'),
    'default requirements is python/requirements.txt');
  assert.match(DEFAULT_ENGINE_SPEC.verifyImport, /faster_whisper/, 'verify probe imports faster-whisper');
});

test('buildVenvPlan honors a custom venvDirName so each engine gets an isolated venv', () => {
  const fs = memFs({});
  const plan = buildVenvPlan({ userDataPath: '/ud', platform: 'win32', fs, reqsHash: 'h',
                               venvDirName: 'stt-venv-funasr' });
  assert.equal(plan.venvPython.replace(/\\/g, '/'), '/ud/stt-venv-funasr/Scripts/python.exe',
    'a funasr venv lives in its own dir, never the faster-whisper one');
  assert.equal(plan.create, true);
});

test('requirementsHash reads the spec-supplied requirements file, isolating an engine install marker', () => {
  // A funasr-style requirements file pins its own marker, independent of faster-whisper's.
  const funasrReqs = path.join(__dirname, '..', 'python', 'requirements-funasr.txt');
  const fs = memFs({ [funasrReqs]: 'funasr==1.0\ntorch==2.1.0\n' });
  const funasrHash = requirementsHash(fs, funasrReqs);
  assert.equal(/[0-9a-f]{40}/.test(funasrHash), true, '40-hex sha1 of the funasr requirements');
  // A different requirements file yields a different hash → a marker mismatch correctly re-installs.
  const fsFw = memFs({ [require('node:path').join(__dirname, '..', 'python', 'requirements.txt')]: 'faster-whisper==1.1.1\n' });
  const fwHash = requirementsHash(fsFw);
  assert.notEqual(funasrHash, fwHash, 'two engines => two independent install markers');
});

test('a manager built with a funasr spec spawns that engine\'s script + verify-import, not faster-whisper', async () => {
  const funasrSpec = {
    requirementsPath: path.join(__dirname, '..', 'python', 'requirements-funasr.txt'),
    scriptPath: '/srv/cue_stt_funasr_service.py',
    venvDirName: 'stt-venv-funasr',
    modelsDirName: 'stt-models-funasr',
    verifyImport: 'import funasr, torch; print(funasr.__version__); print(torch.__version__); print(torch.cuda.is_available())',
  };
  let spawnedWith = null;
  const m = createSttProcessManager({
    spawn: (exe, args) => { spawnedWith = { exe, args }; return makeEchoChild(); },
    spawnSync: () => ({ status: 0 }),
    fs: memFs({}),
    getPath: () => '/ud',
    log: () => {},
    spec: funasrSpec,
  });
  m._setVenv({ venvPython: '/v/bin/python', pythonVersion: '3.11.2' });

  function makeEchoChild() {
    const dataCbs = [];
    const child = {
      stdin: { destroyed: false, write(line) { const o = parseJsonLine(line.trim()); if (o && o.id) setImmediate(() => dataCbs.forEach((cb) => cb(Buffer.from(JSON.stringify({ id: o.id, ok: true, result: { python_version: '3.11.2', cuda: true } }) + '\n')))); }, end() {} },
      stdout: { on(ev, cb) { if (ev === 'data') dataCbs.push(cb); } },
      stderr: { on() {} },
      on() {}, kill() {}, killed: false,
    };
    return child;
  }

  assert.equal(await m.start(), true, 'starts with the funasr service');
  assert.ok(spawnedWith, 'spawn was called');
  assert.deepEqual(spawnedWith.args, ['-u', '/srv/cue_stt_funasr_service.py'],
    'spawned the funasr SCRIPT, not the default faster-whisper one');
  assert.equal(m.getModelsDir().replace(/\\/g, '/'), '/ud/stt-models-funasr',
    'models dir derives from the spec modelsDirName');
  m.stop();
});
