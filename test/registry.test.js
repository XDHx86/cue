const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const registry = require('../src/registry');
const loader = require('../src/registry-loader');

// Same reset hygiene as test/logger.test.js: a provider registered in one case must not leak.
const suite = require('node:test');
suite.beforeEach(() => registry._resetProviders());
suite.afterEach(() => registry._resetProviders());

// A fixture LLM descriptor factory (side-effects intentionally absent — createEngine is a stub).
function fakeLlm(id, order = 0) {
  return {
    id, displayName: id.toUpperCase(), description: id + ' llm',
    providerType: 'llm',
    capabilities: { streaming: true },
    supportedModels: [{ id: id + '-fast', label: id + ' Fast' }, { id: id + '-smart', label: id + ' Smart' }],
    configurableSettings: [
      { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...' },
    ],
    defaultSettings: { apiKeys: { [id]: '' }, models: { [id]: { fast: id + '-fast', smart: id + '-smart' } } },
    order,
    createEngine() { return { provider: id, ready: true, stream() { return Promise.resolve(''); } }; },
  };
}

test('defineProvider registers under (type, id); same-named LLM and STT coexist (namespaced)', () => {
  registry.defineProvider(fakeLlm('openai'));
  registry.defineProvider({
    id: 'openai', displayName: 'OpenAI Whisper', providerType: 'stt', order: 10,
    configurableSettings: [{ id: 'model', label: 'Model', type: 'text' }],
    createEngine() { return { transcribe() {} }; },
  });
  assert.equal(registry.listProviders('llm').length, 1);
  assert.equal(registry.listProviders('stt').length, 1);
  assert.equal(registry.getProvider('llm', 'openai').displayName, 'OPENAI');
  assert.equal(registry.getProvider('stt', 'openai').displayName, 'OpenAI Whisper');
  assert.ok(registry.hasProvider('llm', 'openai'));
  assert.ok(!registry.hasProvider('llm', 'nope'));
});

test('listProviders sorts by order ascending; untyped returns all', () => {
  registry.defineProvider(fakeLlm('b', 2));
  registry.defineProvider(fakeLlm('a', 1));
  registry.defineProvider(fakeLlm('c')); // order defaults to 0
  const ids = registry.listProviders('llm').map((d) => d.id);
  assert.deepEqual(ids, ['c', 'a', 'b']); // 0,1,2
  assert.equal(registry.listProviders().length, 3);
});

test('defineProvider rejects malformed descriptors (loud failure at load)', () => {
  assert.throws(() => registry.defineProvider({ id: 'x', providerType: 'metal' }), /providerType/);
  assert.throws(() => registry.defineProvider({ providerType: 'llm' }), /non-empty string/); // missing id
  assert.throws(() => registry.defineProvider({ id: 'x', displayName: 'X', providerType: 'llm' }), /createEngine/);
  assert.throws(() => registry.defineProvider({
    id: 'x', displayName: 'X', providerType: 'llm', configurableSettings: 'no',
    createEngine() {},
  }), /configurableSettings/);
  assert.throws(() => registry.defineProvider({
    id: 'x', displayName: 'X', providerType: 'llm',
    configurableSettings: [{ id: 'k', label: 'K', type: 'mystery' }],
    createEngine() {},
  }), /field.*type/);
  assert.throws(() => registry.defineProvider({
    id: 'x', displayName: 'X', providerType: 'llm',
    configurableSettings: [{ id: 'k', label: 'K', type: 'select' /* missing options */ }],
    createEngine() {},
  }), /options/);
  assert.throws(() => registry.defineProvider({
    id: 'x', displayName: 'X', providerType: 'llm',
    configurableSettings: [], createEngine: 'not fn',
  }), /createEngine/);
});

test('defineProvider returns an unsubscribe; re-defining replaces quietly', () => {
  const off = registry.defineProvider(fakeLlm('a'));
  assert.equal(registry.listProviders('llm').length, 1);
  off();
  assert.equal(registry.listProviders('llm').length, 0);
  // Replacing a live provider (dev hot-reload) must not throw — just overwrite.
  registry.defineProvider(fakeLlm('a', 5));
  registry.defineProvider(fakeLlm('a', 9));
  assert.deepEqual(registry.listProviders('llm').map((d) => d.order), [9]);
});

test('renderSafe strips function values (JSON-safe for the renderer IPC)', () => {
  registry.defineProvider(fakeLlm('a'));
  const safe = registry.renderSafe(registry.getProvider('llm', 'a'));
  assert.equal(typeof safe.createEngine, 'undefined');
  assert.equal(typeof safe.streamSession, 'undefined');
  // R3: capabilities are now normalized to rich schema { state, source, confidence }
  assert.deepEqual(safe.capabilities, { streaming: { state: 'supported', source: 'declared', confidence: 1 } });
  assert.equal(safe.supportedModels.length, 2);
  assert.ok(JSON.stringify(safe)); // must serialize
});

test('listProvidersSafe returns render-safe descriptors only', () => {
  registry.defineProvider(fakeLlm('a'));
  const all = registry.listProvidersSafe('llm');
  assert.equal(all.length, 1);
  assert.equal(typeof all[0].createEngine, 'undefined');
});

test('resolveSupportedModels: static array passed through; null when absent; function awaited', async () => {
  registry.defineProvider(fakeLlm('a')); // static array
  registry.defineProvider({ ...fakeLlm('b'), supportedModels: null }); // free-text only
  registry.defineProvider({ ...fakeLlm('c'), supportedModels: (ctx) => ctx.fs ? [{ id: 'live', label: 'Live' }] : [] });
  const a = await registry.resolveSupportedModels(registry.getProvider('llm', 'a'), {});
  assert.equal(a.length, 2);
  const b = await registry.resolveSupportedModels(registry.getProvider('llm', 'b'), {});
  assert.equal(b, null);
  const c = await registry.resolveSupportedModels(registry.getProvider('llm', 'c'), { fs: true });
  assert.deepEqual(c.map((m) => m.id), ['live']);
  const cNoCtx = await registry.resolveSupportedModels(registry.getProvider('llm', 'c'), {});
  assert.deepEqual(cNoCtx, []);
});

// ---- registry-loader: folder discovery against a temp providers tree ----
let _tmpRoots = [];
suite.afterEach(() => { for (const d of _tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } _tmpRoots = []; });
function makeRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-registry-'));
  _tmpRoots.push(d);
  return d;
}
function writeProvider(root, type, id, src) {
  const dir = path.join(root, type, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), src);
}

test('discoverProviderFiles finds index.js child folders, skips hidden dirs and non-folders', () => {
  const root = makeRoot();
  writeProvider(root, 'llm', 'openai', '// stub');
  writeProvider(root, 'llm', 'anthropic', '// stub');
  fs.mkdirSync(path.join(root, 'llm', '.hidden'), { recursive: true }); // skipped
  fs.writeFileSync(path.join(root, 'llm', 'README.md'), 'x'); // not a dir
  // a folder with no index.js is skipped
  fs.mkdirSync(path.join(root, 'llm', 'noindex'), { recursive: true });
  const found = loader.discoverProviderFiles('llm', root, fs, path).map((f) => f.id).sort();
  assert.deepEqual(found, ['anthropic', 'openai']);
});

test('discoverProviderFiles: missing type dir → empty (no providers of that type yet)', () => {
  const root = makeRoot();
  assert.deepEqual(loader.discoverProviderFiles('stt', root, fs, path), []);
});

test('loadProviders requires each index.js (defineProvider side effect) and reports what loaded', () => {
  const root = makeRoot();
  // A provider module that calls defineProvider at load with a full descriptor.
  writeProvider(root, 'llm', 'openai', `
    const r = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'registry'))});
    r.defineProvider({
      id: 'openai', displayName: 'OpenAI', providerType: 'llm', order: 1,
      capabilities: { streaming: true },
      supportedModels: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      configurableSettings: [{ id: 'apiKey', label: 'API Key', type: 'secret' }],
      defaultSettings: { apiKeys: { openai: '' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } },
      createEngine() { return { provider: 'openai', ready: true, stream() {} }; },
    });
  `);
  const loaded = loader.loadProviders({ root, fsObj: fs, pathObj: path, _require: require });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].type, 'llm');
  assert.equal(loaded[0].id, 'openai');
  assert.equal(registry.getProvider('llm', 'openai').displayName, 'OpenAI');
  assert.equal(loaded[0].desc.createEngine, undefined); // reported render-safe
});

test('loadProviders scopes to the requested types only', () => {
  const root = makeRoot();
  const rPath = JSON.stringify(path.resolve(__dirname, '..', 'src', 'registry'));
  writeProvider(root, 'llm', 'a', `const r=require(${rPath});r.defineProvider({id:'a',displayName:'A',providerType:'llm',order:1,configurableSettings:[{id:'apiKey',label:'API Key',type:'secret'}],createEngine(){return{provider:'a',ready:true,stream(){}};}});`);
  writeProvider(root, 'stt', 'b', `const r=require(${rPath});r.defineProvider({id:'b',displayName:'B',providerType:'stt',configurableSettings:[],createEngine(){}});`);
  const onlyLlm = loader.loadProviders({ root, types: ['llm'], fsObj: fs, pathObj: path, _require: require });
  assert.equal(onlyLlm.length, 1);
  assert.equal(onlyLlm[0].type, 'llm');
  assert.equal(registry.listProviders('stt').length, 0); // STT folder present but not loaded
});
