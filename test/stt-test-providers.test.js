const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Pure helpers of the provider verification harness (scripts/stt-test-providers.js). The
// harness's main() — which spawns Python and calls cloud APIs — is exercised manually by the
// user (see the P1 verification checklist), not here. These tests cover the testable surface:
// argv parsing, raw-PCM→WAV wrapping, and env-key resolution.
const { parseArgs, readWav, cloudKeys, resolveUserDataDir } = require('../scripts/stt-test-providers');

test('parseArgs: wav positional + --only + --data-dir', () => {
  const a = parseArgs(['node', 's', './x.wav', '--only', 'openai,gemini', '--data-dir', '/tmp/q']);
  assert.equal(a.wav, './x.wav');
  assert.deepEqual(a.only, ['openai', 'gemini']);
  assert.equal(a.dataDir, '/tmp/q');
});

test('parseArgs: bare flags do not collapse into the wav slot', () => {
  const a = parseArgs(['node', 's', 'a.wav']);
  assert.equal(a.wav, 'a.wav');
  assert.equal(a.only, null);
  assert.equal(a.dataDir, null);
});

test('readWav wraps raw Int16 PCM into a 44-byte-header WAV', () => {
  const { pcmToWav } = require('../src/wav');
  const tmp = path.join(os.tmpdir(), 'cue_test_raw.pcm');
  const raw = Buffer.alloc(200, 0); // 100 samples of silence
  fs.writeFileSync(tmp, raw);
  try {
    const wav = readWav(tmp); // not a RIFF → wraps raw PCM as 16kHz mono
    assert.equal(wav.slice(0, 4).toString(), 'RIFF');
    const ref = pcmToWav(raw, 16000, 1);
    assert.equal(wav.slice(0, 44).toString('hex'), ref.slice(0, 44).toString('hex'));
  } finally { fs.unlinkSync(tmp); }
});

test('readWav passes an existing WAV through unchanged', () => {
  const { pcmToWav } = require('../src/wav');
  const tmp = path.join(os.tmpdir(), 'cue_test_existing.wav');
  const w = pcmToWav(Buffer.alloc(1600, 0), 16000, 1);
  fs.writeFileSync(tmp, w);
  try {
    const out = readWav(tmp);
    assert.equal(out.length, w.length);
    assert.equal(out.toString('hex'), w.toString('hex'));
  } finally { fs.unlinkSync(tmp); }
});

test('cloudKeys: CUE_* takes precedence over bare OPENAI_API_KEY/GEMINI_API_KEY', () => {
  const old = { ...process.env };
  process.env.OPENAI_API_KEY = 'bare-oai'; process.env.GEMINI_API_KEY = 'bare-gem';
  try {
    let k = cloudKeys();
    assert.equal(k.openai, 'bare-oai');
    assert.equal(k.gemini, 'bare-gem');
    process.env.CUE_OPENAI_API_KEY = 'cue-oai'; process.env.CUE_GEMINI_API_KEY = 'cue-gem';
    k = cloudKeys();
    assert.equal(k.openai, 'cue-oai');
    assert.equal(k.gemini, 'cue-gem');
  } finally {
    delete process.env.CUE_OPENAI_API_KEY; delete process.env.CUE_GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;
    // restore others
    for (const key of Object.keys(old)) if (!(key in process.env)) process.env[key] = old[key];
  }
});

test('resolveUserDataDir: platform-specific base (pure, no Electron)', () => {
  const dirs = [];
  dirs.push(resolveUserDataDir({ platform: 'win32', env: { APPDATA: 'C:/Roaming' }, homedir: 'C:/U' }));
  dirs.push(resolveUserDataDir({ platform: 'darwin', env: { HOME: '/U' }, homedir: '/U' }));
  dirs.push(resolveUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, homedir: '/U' }));
  assert.deepEqual(dirs.map((d) => d.split(path.sep).pop()), ['cue', 'cue', 'cue']);
});
