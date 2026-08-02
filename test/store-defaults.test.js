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

test('stt has a managed local-engine block (enabled + engine + local.*) separate from stt.model', () => {
  const s = store.getSettings();
  // enabled: master toggle; engine: local engine selector (registry in stt-engine.js)
  assert.equal(s.stt.enabled, true, 'STT enabled by default');
  assert.equal(s.stt.engine, 'faster-whisper', 'default local engine is faster-whisper');
  assert.ok(s.stt.local && typeof s.stt.local === 'object', 'stt.local block exists');
  assert.equal(s.stt.local.model, 'small', 'small is the CPU/local sweet spot');
  assert.equal(s.stt.local.device, 'auto', 'auto → cuda if available else cpu');
  assert.equal(s.stt.local.computeType, 'int8', 'CPU default compute type');
  assert.equal(s.stt.local.language, 'auto', 'auto-detect by default');
  assert.equal(s.stt.local.vad, true, 'VAD endpoint detection on by default');
  // the OpenAI Whisper batch model name lives at stt.model — distinct from stt.local.model
  assert.notEqual(s.stt.local.model, s.stt.model, 'local model and batch model are separate namespaces');
});

test('stt.local merges cleanly with a persisted value (deepMerge does not drop it)', () => {
  store.setSettings({ stt: { local: { model: 'large-v3', device: 'cuda' } } });
  const s = store.getSettings();
  assert.equal(s.stt.local.model, 'large-v3');
  assert.equal(s.stt.local.device, 'cuda');
  // untouched local fields survive the partial merge
  assert.equal(s.stt.local.computeType, 'int8');
  assert.equal(s.stt.local.vad, true);
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

test('migrates legacy transport faster-whisper to external-ws provider id', () => {
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({ stt: { provider: 'faster-whisper' } }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  const s = store.getSettings();
  assert.equal(s.stt.provider, 'external-ws', 'transport faster-whisper migrated to external-ws');
  // explicit external-ws is not re-migrated
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({ stt: { provider: 'external-ws' } }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  assert.equal(store.getSettings().stt.provider, 'external-ws');
});

// ---- phase-4 composition defaults (pre-prompt, skills, memory, résumé digest) ----

test('composition defaults exist: promptOverrides, skillDir, skillEnabled, memory.notes, resumeSummary', () => {
  const s = store.getSettings();
  // prePrompt/prePromptTemplate left DEFAULTS in the prompt-registry migration (their live home is
  // now promptOverrides.prePrompt; the registry owns the built-in templates). The override slot is
  // empty so the effective pre-prompt is the registry default, resolved through resolveField.
  assert.equal(s.prePrompt, undefined, 'legacy top-level prePrompt is gone (now promptOverrides.prePrompt)');
  assert.equal(s.prePromptTemplate, undefined, 'legacy top-level prePromptTemplate is gone');
  assert.ok(s.promptOverrides && typeof s.promptOverrides === 'object', 'promptOverrides block exists');
  assert.equal(s.promptOverrides.prePrompt, undefined, 'no prePrompt override by default → registry default applies');
  assert.equal(s.skillDir, '', 'no project dir set by default → no skills injected');
  assert.equal(s.skillEnabled, true, 'skills on by default (the dir gate makes this a no-op until a dir is set)');
  assert.ok(s.memory && typeof s.memory === 'object', 'memory block exists');
  assert.equal(s.memory.notes, '', 'user notes default empty');
  assert.equal(s.resumeSummary, '', 'digest empty until the first regenerate-on-save run');
});

test('migrates legacy top-level prePrompt/prePromptTemplate into promptOverrides.prePrompt and drops the old keys', () => {
  // A returning user whose cue-data.json still has the Phase-4 top-level prePrompt (custom text) +
  // prePromptTemplate ('custom', the synthetic selection). Both move into the new promptOverrides
  // home used by src/prompt-registry.js, so resolveField('prePrompt') returns the user's custom text.
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({
    prePrompt: 'my custom lead', prePromptTemplate: 'custom',
  }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  const s = store.getSettings();
  assert.deepEqual(s.promptOverrides.prePrompt, { option: 'custom', text: 'my custom lead' },
    'legacy prePrompt/prePromptTemplate folded into the override slot');
  assert.equal(s.prePrompt, undefined, 'legacy prePrompt key gone after migration');
  assert.equal(s.prePromptTemplate, undefined, 'legacy prePromptTemplate key gone after migration');
  // The compose seam reads the new home; the effective pre-prompt is the migrated custom text.
  const { resolveField } = require('../src/prompt-registry');
  assert.equal(resolveField('prePrompt', s), 'my custom lead', 'effective pre-prompt is the migrated custom text');

  // A user-set promptOverrides.prePrompt is NOT overwritten by a stale legacy prePrompt (a hand-set
  // override wins). The legacy keys are still scrubbed so there is a single source after the save.
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({
    prePrompt: 'stale legacy', prePromptTemplate: 'custom',
    promptOverrides: { prePrompt: { option: 'interview', text: 'my kept lead' } },
  }));
  delete require.cache[require.resolve('../src/store')];
  store = require('../src/store');
  const s2 = store.getSettings();
  assert.equal(s2.promptOverrides.prePrompt.text, 'my kept lead', 'a hand-set override wins over the stale legacy prePrompt');
  assert.equal(s2.prePrompt, undefined, 'legacy keys scrubbed even when the override was kept');
});

test('memory.notes merges cleanly with a persisted notes value (deepMerge does not drop it)', () => {
  store.setSettings({ memory: { notes: 'prefers terse answers; uses cue for interviews' } });
  const s = store.getSettings();
  assert.equal(s.memory.notes, 'prefers terse answers; uses cue for interviews');
});

// ---- schema-driven configurable defaults ----

test('schema-driven LLM settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.llm.maxTokens, 4096);
  assert.equal(s.llm.idleTimeoutMs, 30000);
});

test('schema-driven memory settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.memory.minNewTurns, 10);
  assert.equal(s.memory.summaryIntervalMs, 60000);
  assert.equal(s.memory.maxSummaryChars, 2000);
  assert.equal(s.memory.maxNotesChars, 4000);
  // memory.notes should still exist from BASE_DEFAULTS
  assert.equal(s.memory.notes, '');
});

test('schema-driven transcript settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.transcript.maxTurns, 200);
});

test('schema-driven skills settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.skills.maxChars, 8000);
});

test('schema-driven resume settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.resume.maxContextChars, 12000);
  assert.equal(s.resume.maxSummaryChars, 1500);
});

test('schema-driven screen settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.screen.maxEdge, 1568);
  assert.equal(s.screen.jpegQuality, 85);
  assert.equal(s.screen.cacheTtlMs, 1500);
});

test('schema-driven STT tuning settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.stt.maxSpawnFailures, 3);
  assert.equal(s.stt.helloTimeoutMs, 8000);
  assert.equal(s.stt.callTimeoutMs, 15000);
  assert.equal(s.stt.modelReloadTimeoutMs, 120000);
  assert.equal(s.stt.shutdownGraceMs, 1000);
  assert.equal(s.stt.modelDownloadTimeoutMs, 600000);
  assert.equal(s.stt.modelLoadTimeoutMs, 120000);
  assert.equal(s.stt.preSidBytes, 64000);
  assert.equal(s.stt.streamMaxConnectFailures, 3);
  assert.equal(s.stt.streamMaxBackoffMs, 8000);
  assert.equal(s.stt.flushMs, 3500);
  assert.equal(s.stt.minBytes, 9600);
  assert.equal(s.stt.rmsGate, 240);
  assert.equal(s.stt.transcribeTimeoutMs, 30000);
});

test('schema-driven Python settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.python.vadAggressiveness, 2);
  assert.equal(s.python.endMs, 700);
  assert.equal(s.python.minSpeechMs, 400);
  assert.equal(s.python.partialEveryS, 0.4);
  assert.equal(s.python.energyGate, 0.01);
  assert.equal(s.python.beamSize, 1);
  assert.equal(s.python.stderrTailBytes, 1024);
});

test('schema-driven UI settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.ui.zoomMin, 0.5);
  assert.equal(s.ui.zoomMax, 3);
  assert.equal(s.ui.zoomStep, 0.1);
  assert.equal(s.ui.statusDurationMs, 11000);
  assert.equal(s.ui.inputMaxHeight, 140);
});

test('schema-driven main settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.main.backoffBaseMs, 1000);
  assert.equal(s.main.shortcutMaxLength, 80);
});

test('schema-driven shortcut settings have correct defaults', () => {
  const s = store.getSettings();
  assert.equal(s.shortcuts.leetcode, 'CommandOrControl+H');
  assert.equal(s.shortcuts.quit, 'CommandOrControl+Shift+X');
  assert.equal(s.shortcuts.immediateAssist, 'Control+Alt+A');
  assert.equal(s.shortcuts.toggleOverlay, 'Control+Alt+C');
  // Assist shortcut is already in BASE_DEFAULTS
  assert.equal(s.shortcuts.assist, 'CommandOrControl+Return');
});

test('schema-driven pre-prompt template overrides default to empty (use built-in)', () => {
  const s = store.getSettings();
  const templates = s.promptOverrides && s.promptOverrides.prepromptTemplates;
  assert.ok(templates, 'prepromptTemplates exists');
  assert.equal(templates.concise, '', 'concise template default is empty');
  assert.equal(templates.interview, '', 'interview template default is empty');
  assert.equal(templates.engineer, '', 'engineer template default is empty');
  assert.equal(templates.copilot, '', 'copilot template default is empty');
});

test('validation clamps out-of-range values on load', () => {
  // Write a corrupt cue-data.json with out-of-range values
  fs.writeFileSync(path.join(tmpDir, 'cue-data.json'), JSON.stringify({
    llm: { maxTokens: -1 },
    ui: { zoomMin: 999 },
  }));
  delete require.cache[require.resolve('../src/store')];
  stubElectron(tmpDir);
  store = require('../src/store');
  const s = store.getSettings();
  assert.equal(s.llm.maxTokens, 256, 'clamped to min');
  assert.equal(s.ui.zoomMin, 2.0, 'clamped to max');
});

// ---- validatePatch (setSettings validation) ----

test('validatePatch returns empty for valid patch', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ apiKeys: { openai: 'sk-test123' } });
  assert.deepEqual(errors, [], 'valid patch should have no errors');
});

test('validatePatch catches invalid OpenAI key format', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ apiKeys: { openai: 'invalid-key' } });
  assert.ok(errors.some((e) => e.includes('OpenAI')), 'should warn about OpenAI key format');
});

test('validatePatch catches invalid Groq key format', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ apiKeys: { groq: 'invalid-key' } });
  assert.ok(errors.some((e) => e.includes('Groq')), 'should warn about Groq key format');
});

test('validatePatch accepts valid Groq key', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ apiKeys: { groq: 'gsk_abc123def456' } });
  assert.ok(!errors.some((e) => e.includes('Groq')), 'valid Groq key should not warn');
});

test('validatePatch catches unknown STT provider', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ stt: { provider: 'nonexistent' } });
  assert.ok(errors.some((e) => e.includes('STT provider')), 'should warn about unknown STT provider');
});

test('validatePatch accepts valid STT providers', () => {
  const { validatePatch } = require('../src/store');
  for (const p of ['auto', 'batch', 'faster-whisper', 'funasr', 'assemblyai', 'deepgram', 'openai', 'groq', 'gemini', 'external-ws']) {
    const errors = validatePatch({ stt: { provider: p } });
    assert.ok(!errors.some((e) => e.includes('STT provider')), p + ' should be valid');
  }
});

test('validatePatch catches unknown LLM provider', () => {
  const { validatePatch } = require('../src/store');
  const errors = validatePatch({ provider: 'nonexistent' });
  assert.ok(errors.some((e) => e.includes('LLM provider')), 'should warn about unknown LLM provider');
});

test('validatePatch accepts valid LLM providers', () => {
  const { validatePatch } = require('../src/store');
  for (const p of ['openai', 'anthropic', 'gemini', 'nvidia', 'ollama']) {
    const errors = validatePatch({ provider: p });
    assert.ok(!errors.some((e) => e.includes('LLM provider')), p + ' should be valid');
  }
});

test('setSettings applies validation (schema clamping in patch)', () => {
  // setSettings should clamp out-of-range values in the patch
  store.setSettings({ llm: { maxTokens: -999 } });
  const s = store.getSettings();
  assert.equal(s.llm.maxTokens, 256, 'clamped to min on setSettings');
});
