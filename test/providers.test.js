const assert = require('node:assert/strict');
const test = require('node:test');

// Loads the REAL src/providers/llm/* tree (not temp fixtures) and asserts the 5 LLM providers
// register with the right shape (ids, order, capabilities, configurableSettings) AND that folding
// their defaultSettings reproduces exactly the LLM-relevant DEFAULTS slices that live in
// src/store.js today — the contract R1c relies on: store folds provider defaultSettings into
// DEFAULTS, so the provider descriptors are the one source for apiKeys/models/ollama defaults.
//
// Pure-Node: provider modules lazy-require their network SDK INSIDE createEngine, so loading the
// descriptors (defineProvider side effect) pulls no SDK and needs no Electron. We never call
// createEngine here. Reset hygiene matches test/registry.test.js in case file isolation changes.

const registry = require('../src/registry');
const loader = require('../src/registry-loader');

// Load the REAL provider tree ONCE at module scope. Unlike test/registry.test.js (which registers
// throwaway fixtures per-case and _resetProviders between them), these are the actual on-disk
// provider modules: Node caches them by path after the first require, so their top-level
// defineProvider() runs exactly once and never re-runs on a re-require. Resetting between cases
// here would therefore leave the registry EMPTY for every test after the first. Each test file
// runs in its own worker, so this one-time load can't leak into other suites. This mirrors how
// main.js uses the registry — load providers once at startup, then read.
loader.loadProviders({ _require: require });

// Mirror of src/store.js deepMerge — inlined here so this test stays electron-free (store.js
// requires electron at load). If store's deepMerge ever changes semantics, update both.
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

// Fold a type's provider defaultSettings the way src/store.js does (deep-merged union; order is
// immaterial since each provider contributes disjoint keys).
function foldDefaults(type) {
  let acc = {};
  for (const d of registry.listProviders(type)) {
    if (d.defaultSettings) acc = deepMerge(acc, d.defaultSettings);
  }
  return acc;
}

function loadReal() {
  // Idempotent: modules are cached after the top-level call, so this is a no-op re-require that
  // just re-reads the already-registered descriptors. Kept for readability in tests below.
  loader.loadProviders({ _require: require });
}

test('loading the real src/providers tree registers the 7 LLM providers and 10 STT providers', () => {
  loadReal();
  const ids = registry.listProviders('llm').map((d) => d.id);
  assert.deepEqual(ids, ['openai', 'anthropic', 'gemini', 'groq', 'nvidia', 'ollama', 'omni'], 'LLM ids + order');
  const sttIds = registry.listProviders('stt').map((d) => d.id);
  assert.deepEqual(sttIds, ['funasr', 'faster-whisper', 'assemblyai', 'deepgram', 'openai', 'groq', 'gemini', 'omni', 'external-ws', 'ollama'], 'STT ids + order');
});

test('every STT provider declares modelSettingsPath (string or null)', () => {
  loadReal();
  const withPath = ['funasr', 'faster-whisper', 'assemblyai', 'deepgram', 'openai', 'groq'];
  const withoutPath = ['gemini', 'external-ws'];
  for (const id of withPath) {
    const d = registry.getProvider('stt', id);
    assert.equal(typeof d.modelSettingsPath, 'string', id + ' has a string modelSettingsPath');
    assert.ok(d.modelSettingsPath.startsWith('stt.'), id + ' path starts with stt.');
  }
  for (const id of withoutPath) {
    const d = registry.getProvider('stt', id);
    assert.equal(d.modelSettingsPath, null, id + ' has null modelSettingsPath');
  }
});

test('every LLM descriptor validates and has a render-safe, function-bearing createEngine', () => {
  loadReal();
  for (const d of registry.listProviders('llm')) {
    assert.equal(typeof d.createEngine, 'function', d.id + ' has createEngine');
    const safe = registry.renderSafe(d);
    assert.equal(typeof safe.createEngine, 'undefined', d.id + ' renderSafe strips createEngine');
    assert.ok(safe.configurableSettings.length > 0, d.id + ' declares configurableSettings');
    assert.ok(JSON.stringify(safe), d.id + ' renderSafe is JSON-serializable');
  }
});

test('capabilities match the pre-refactor LLM switch (all stream + vision where supported)', () => {
  loadReal();
  for (const d of registry.listProviders('llm')) {
    assert.equal(d.capabilities.streaming, true, d.id + ' streams');
    // Groq LLM has no vision support (Llama models don't accept image input); all others do.
    if (d.id === 'groq') {
      assert.equal(d.capabilities.vision, false, d.id + ' does not support vision');
    } else {
      assert.equal(d.capabilities.vision, true, d.id + ' vision (image input)');
    }
  }
});

test('ollama ready logic diverges: no apiKey field is secret; baseURL is configurable', () => {
  loadReal();
  const ollama = registry.getProvider('llm', 'ollama');
  const fieldIds = ollama.configurableSettings.map((f) => f.id);
  assert.ok(!fieldIds.includes('apiKey'), 'ollama has no API key (sentinel satisfies the SDK constructor)');
  assert.ok(fieldIds.includes('baseURL'), 'ollama exposes its local /v1 base URL');
  // Engining readiness is exercised via createEngine; here we assert the descriptor contract only.
});

test('folded LLM defaultSettings reproduce today\'s literal DEFAULTS slices (apiKeys + models + ollama)', () => {
  loadReal();
  const fold = foldDefaults('llm');
  assert.deepEqual(fold.apiKeys, {
    openai: '', anthropic: '', gemini: '', groq: '', nvidia: '', ollama: 'ollama', omni: 'omniroute',
  }, 'apiKeys fold matches store DEFAULTS.apiKeys (deepgram is STT, added by store, not here)');
  assert.deepEqual(fold.models, {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    omni: { fast: 'auto', smart: 'auto' },
  }, 'models fold matches store DEFAULTS.models');
  assert.deepEqual(fold.ollama, { baseURL: '' }, 'ollama baseURL default folds in (was a store literal)');
  assert.deepEqual(fold.omniroute, { baseURL: '' }, 'omniroute baseURL default folds in');
});

test('createEngine resolves the apiKeys/models keys from settings and reports ready (stubbed — no SDK)', () => {
  loadReal();
  // Stub settings with keys + models present; createEngine must NOT call any SDK at construction
  // (it lazy-requires inside stream()). We assert the engine shape + readiness, never call stream.
  // Remote providers (openai, anthropic, gemini, nvidia, groq) are ready with key+model.
  // Local providers (ollama, omni) require a health check — without it, ready=false.
  const settings = {
    smart: false,
    apiKeys: { openai: 'sk-x', anthropic: 'sk-y', gemini: 'AIza', nvidia: 'nvapi', ollama: 'ollama', groq: 'gsk_x', omni: 'omniroute' },
    models: {
      openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
      anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
      gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
      groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
      nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' },
      ollama: { fast: 'llama3.2', smart: 'llama3.3' },
      omni: { fast: 'auto', smart: 'auto' },
    },
    ollama: { baseURL: '' },
    omniroute: { baseURL: '' },
  };
  const remoteProviders = ['openai', 'anthropic', 'gemini', 'groq', 'nvidia'];
  const localProviders = ['ollama', 'omni'];
  for (const d of registry.listProviders('llm')) {
    const eng = d.createEngine({ settings });
    assert.equal(eng.provider, d.id, d.id + ' engine.provider');
    if (remoteProviders.includes(d.id)) {
      assert.equal(eng.ready, true, d.id + ' ready with key+model (remote)');
    } else if (localProviders.includes(d.id)) {
      assert.equal(eng.ready, false, d.id + ' not ready without health check (local)');
    }
    assert.equal(typeof eng.stream, 'function', d.id + ' engine.stream is a function');
    assert.equal(eng.model, settings.models[d.id].fast, d.id + ' picks fast tier when smart=false');
  }
});

test('createEngine ready=false when key/model absent or health check cold (local providers)', () => {
  loadReal();
  const noKey = (extra = {}) => ({ smart: false, apiKeys: {}, models: {}, ollama: { baseURL: '' }, ...extra });
  // openai without key+model → not ready (remote, key+model gate)
  assert.equal(registry.getProvider('llm', 'openai').createEngine({ settings: noKey() }).ready, false);
  // ollama with a model but no health check → not ready (local providers require a health check)
  const ollamaEng = registry.getProvider('llm', 'ollama').createEngine({
    settings: noKey({ models: { ollama: { fast: 'llama3.2', smart: 'llama3.3' } } }),
  });
  assert.equal(ollamaEng.ready, false, 'ollama not ready without health check (local provider)');
  // ollama with no model → not ready (model gate still applies even if health check passed)
  assert.equal(registry.getProvider('llm', 'ollama').createEngine({ settings: noKey() }).ready, false);
  // omni with a model but no health check → not ready (local provider)
  const omniEng = registry.getProvider('llm', 'omni').createEngine({
    settings: noKey({ models: { omni: { fast: 'auto', smart: 'auto' } }, omniroute: { baseURL: '' } }),
  });
  assert.equal(omniEng.ready, false, 'omni not ready without health check (local provider)');
});
