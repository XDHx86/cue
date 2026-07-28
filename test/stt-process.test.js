const assert = require('node:assert/strict');
const test = require('node:test');

const {
  encodeJsonLine, parseJsonLine, RpcChannel,
  pickPython, parsePyVer, venvPythonPath, buildVenvPlan, requirementsHash,
} = require('../src/stt-process');

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
