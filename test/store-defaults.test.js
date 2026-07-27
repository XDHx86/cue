const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// store.js calls require('electron').app.getPath('userData') at module load to locate its
// JSON file. Inject an electron stub into require.cache before requiring store so DEFAULTS
// tests never touch the user's real cue-data.json — the param-injection pattern electron-
// dependent code uses elsewhere in the repo (per the plan's guidance citing profile-context.js).
function stubElectron(tmpDir) {
  const Module = require('module');
  const id = require.resolve('electron');
  Module._cache[id] = { id, filename: id, loaded: true, paths: [], exports: { app: { getPath: () => tmpDir } }, children: [] };
}
function unstubElectron() {
  const Module = require('module');
  delete Module._cache[require.resolve('electron')];
}
let store;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-'));
  delete require.cache[require.resolve('../src/store')];
  stubElectron(tmpDir);
  store = require('../src/store');
});
test.afterEach(() => {
  delete require.cache[require.resolve('../src/store')];
  unstubElectron();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* fine */ }
});

test('ollama is present in DEFAULTS apiKeys and models, with the sentinel key', () => {
  const s = store.getSettings();
  assert.equal(s.apiKeys.ollama, 'ollama', 'the ollama sentinel key ("ollama") is non-empty so auto-switch never flips away');
  assert.ok(s.models.ollama, 'ollama has a models entry');
  assert.ok(s.models.ollama.fast, 'ollama has a fast model default');
  assert.ok(s.models.ollama.smart, 'ollama has a smart model default');
});

test('ollama is NOT in the auto-switch validProviders — a user must manually select it', () => {
  // Simulate a user who has only the ollama sentinel and no real keys anywhere: auto-switch
  // should leave provider (default openai) alone rather than flipping to ollama, because a
  // running server is not guaranteed.  Set provider to something with no key to trigger the
  // switch path, and confirm ollama is never chosen.
  store.setSettings({ provider: 'openai', apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '', deepgram: '', ollama: 'ollama' } });
  store.setSettings({ provider: 'nvidia' }); // nvidia has no key → triggers auto-switch re-eval on next load
  const s = store.getSettings();
  assert.notEqual(s.provider, 'ollama', 'auto-switch must never pick ollama (no real key, no guaranteed server)');
  assert.equal(s.provider, 'nvidia', 'with no real keys anywhere, provider stays where the user left it');
});

test('ollama baseURL default is empty string; llm.js falls back to localhost', () => {
  const s = store.getSettings();
  assert.ok(s.ollama, 'ollama settings object exists');
  assert.equal(typeof s.ollama.baseURL, 'string');
  assert.equal(s.ollama.baseURL, '', 'empty default URL triggers llm.js fallback to http://localhost:11434/v1');
});

test('stt defaults to auto with an empty fasterWhisperURL (batch fallback) and a deepgram URL', () => {
  const s = store.getSettings();
  assert.ok(s.stt, 'stt block exists in DEFAULTS');
  assert.equal(s.stt.provider, 'auto', 'auto → batch by default since fasterWhisperURL is empty');
  assert.equal(s.stt.fasterWhisperURL, '', "empty URL means 'not configured' — avoids a connect-fail storm for users without a server");
  assert.equal(s.stt.model, '', 'stt.model default empty → stt.js uses whisper-1');
});

test('migrates a legacy top-level sttModel into stt.model and drops the old key', () => {
  // Simulate a returning user whose cue-data.json still has the pre-Phase-3 top-level sttModel.
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({ sttModel: 'whisper-1' }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  const s = store.getSettings();
  assert.equal(s.stt && s.stt.model, 'whisper-1', 'whisper model moved to stt.model');
  assert.equal(s.sttModel, undefined, 'legacy sttModel key is gone after migration');
  // a user-set stt.model must NOT be overwritten by a stale legacy sttModel
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({ sttModel: 'old', stt: { provider: 'auto', model: 'whisper-large' } }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  const s2 = store.getSettings();
  assert.equal(s2.stt.model, 'whisper-large', 'explicit stt.model wins over the legacy sttModel');
});
