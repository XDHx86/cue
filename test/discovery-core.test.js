const assert = require('node:assert/strict');
const test = require('node:test');

// Tests for the R3 provider discovery core modules: EventBus, Model, CapabilityRegistry,
// CacheManager, ProviderRegistry, ModelRegistry, HealthMonitor. These are pure-Node,
// no-Electron tests that validate the core infrastructure.
//
// Each test uses _reset() to isolate state (module-scoped workers prevent cross-file leaks).

const { EventBus } = require('../src/providers/core/EventBus');
const { Model, HEALTH, MODEL_SOURCES } = require('../src/providers/core/Model');
const { CapabilityRegistry, CAPABILITY_SCHEMA } = require('../src/providers/core/CapabilityRegistry');
const { CacheManager, CACHE_VERSION } = require('../src/providers/core/CacheManager');
const { ProviderRegistry } = require('../src/providers/core/ProviderRegistry');
const { ModelRegistry } = require('../src/providers/core/ModelRegistry');
const { HealthMonitor, HEALTH: P_HEALTH, MODEL_HEALTH } = require('../src/providers/core/HealthMonitor');
const core = require('../src/providers/core');

// ---- EventBus ---------------------------------------------------------------

test('EventBus: on/emit delivers events', () => {
  const bus = new EventBus();
  let received = null;
  bus.on('test:event', (data) => { received = data; });
  bus.emit('test:event', { value: 42 });
  assert.deepEqual(received, { value: 42 });
});

test('EventBus: once fires only once', () => {
  const bus = new EventBus();
  let count = 0;
  bus.once('test:event', () => { count++; });
  bus.emit('test:event');
  bus.emit('test:event');
  assert.equal(count, 1);
});

test('EventBus: off removes a listener', () => {
  const bus = new EventBus();
  let count = 0;
  const cb = () => { count++; };
  bus.on('test:event', cb);
  bus.emit('test:event');
  bus.off('test:event', cb);
  bus.emit('test:event');
  assert.equal(count, 1);
});

test('EventBus: unsubscribe function from on() removes listener', () => {
  const bus = new EventBus();
  let count = 0;
  const unsub = bus.on('test:event', () => { count++; });
  bus.emit('test:event');
  unsub();
  bus.emit('test:event');
  assert.equal(count, 1);
});

test('EventBus: listenerCount reports correct count', () => {
  const bus = new EventBus();
  assert.equal(bus.listenerCount('test'), 0);
  const a = bus.on('test', () => {});
  bus.on('test', () => {});
  assert.equal(bus.listenerCount('test'), 2);
  a();
  assert.equal(bus.listenerCount('test'), 1);
});

test('EventBus: _reset clears all listeners', () => {
  const bus = new EventBus();
  bus.on('a', () => {});
  bus.on('b', () => {});
  assert.equal(bus.listenerCount('a'), 1);
  bus._reset();
  assert.equal(bus.listenerCount('a'), 0);
  assert.equal(bus.listenerCount('b'), 0);
});

// ---- Model ------------------------------------------------------------------

test('Model: constructor validates required fields', () => {
  assert.throws(() => new Model({ id: '', providerId: 'x', providerType: 'llm' }), /id must be/);
  assert.throws(() => new Model({ id: 'a', providerId: '', providerType: 'llm' }), /providerId must be/);
  assert.throws(() => new Model({ id: 'a', providerId: 'x', providerType: 'bad' }), /providerType must be/);
});

test('Model: isUsable returns true for available, false for deprecated', () => {
  const m = new Model({ id: 'm1', providerId: 'p1', providerType: 'llm' });
  assert.equal(m.isUsable(), true);
  m.status = HEALTH.DEPRECATED;
  assert.equal(m.isUsable(), false);
  m.status = HEALTH.AVAILABLE;
  assert.equal(m.isUsable(), true);
});

test('Model: getCapability follows precedence chain', () => {
  const m = new Model({
    id: 'm1', providerId: 'p1', providerType: 'llm',
    capabilities: { streaming: { state: 'supported', source: 'model' } },
  });
  // Model-level wins
  assert.equal(m.getCapability('streaming').source, 'model');
  // Provider-level used when model doesn't have it
  assert.equal(m.getCapability('vision', { vision: { state: 'supported', source: 'provider' } }).source, 'provider');
  // Adapter-level used when neither model nor provider has it
  assert.equal(m.getCapability('reasoning', {}, { reasoning: { state: 'supported', source: 'adapter' } }).source, 'adapter');
  // Unknown when nothing has it
  assert.equal(m.getCapability('unknown').state, 'unknown');
});

test('Model: toJSON / fromJSON round-trips', () => {
  const m = new Model({
    id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerType: 'llm',
    capabilities: { streaming: { state: 'supported', source: 'declared' } },
    contextWindow: 128000, status: HEALTH.AVAILABLE,
  });
  const json = m.toJSON();
  const restored = Model.fromJSON(json);
  assert.equal(restored.id, 'gpt-4o');
  assert.equal(restored.name, 'GPT-4o');
  assert.equal(restored.contextWindow, 128000);
  assert.deepEqual(restored.capabilities, m.capabilities);
});

test('Model: fromRaw normalizes provider-specific data', () => {
  const raw = { id: 'gpt-4o', context_window: 128000 };
  const m = Model.fromRaw(raw, 'openai', 'llm');
  assert.equal(m.id, 'gpt-4o');
  assert.equal(m.providerId, 'openai');
  assert.equal(m.contextWindow, 128000);
  assert.equal(m.source, MODEL_SOURCES.DISCOVERED);
});

// ---- CapabilityRegistry -----------------------------------------------------

test('CapabilityRegistry: getCapabilityMeta returns metadata', () => {
  const reg = new CapabilityRegistry();
  const meta = reg.getCapabilityMeta('streaming');
  assert.equal(meta.label, 'Streaming');
  assert.equal(meta.category, 'transport');
});

test('CapabilityRegistry: getCapabilityMeta returns null for unknown', () => {
  const reg = new CapabilityRegistry();
  assert.equal(reg.getCapabilityMeta('nonexistent'), null);
});

test('CapabilityRegistry: getAll returns sorted by priority', () => {
  const reg = new CapabilityRegistry();
  const all = reg.getAll();
  assert.ok(all.length >= 4);
  assert.equal(all[0].name, 'streaming'); // priority 1
});

test('CapabilityRegistry: resolveCapability follows precedence', () => {
  const reg = new CapabilityRegistry();
  // Model wins over provider
  const r1 = reg.resolveCapability('streaming',
    { streaming: { state: 'supported', source: 'model' } },
    { streaming: { state: 'unsupported', source: 'provider' } }
  );
  assert.equal(r1.source, 'model');
  // Provider used when model is empty
  const r2 = reg.resolveCapability('streaming', {},
    { streaming: { state: 'supported', source: 'provider' } });
  assert.equal(r2.source, 'provider');
  // Adapter used when both empty
  const r3 = reg.resolveCapability('streaming', {}, {},
    { streaming: { state: 'supported', source: 'adapter' } });
  assert.equal(r3.source, 'adapter');
  // Unknown fallback for known capability
  const r4 = reg.resolveCapability('streaming');
  assert.equal(r4.state, 'unknown');
  assert.equal(r4.source, 'fallback');
});

// ---- CacheManager -----------------------------------------------------------

test('CacheManager: load returns null when no cache file', () => {
  const cm = new CacheManager();
  cm.configure('/nonexistent/path');
  assert.equal(cm.load(), null);
});

test('CacheManager: setProvider/getProvider round-trips', () => {
  const cm = new CacheManager();
  cm._initData();
  cm.setProvider('openai', { models: [{ id: 'gpt-4o' }], health: 'healthy' });
  const entry = cm.getProvider('openai');
  assert.ok(entry);
  assert.equal(entry.models[0].id, 'gpt-4o');
  assert.equal(entry.health, 'healthy');
  assert.ok(entry.updatedAt > 0);
});

test('CacheManager: isExpired checks TTL', () => {
  const cm = new CacheManager();
  cm._initData();
  cm.setProvider('openai', { models: [] });
  // Not expired with large TTL
  assert.equal(cm.isExpired('openai', 3600000), false);
  // Not expired with zero TTL (updatedAt === Date.now, so elapsed ≈ 0)
  // The entry was JUST set, so it cannot be expired yet even with TTL 0.
  // To test expiry, use a negative TTL (guarantees expiration).
  assert.equal(cm.isExpired('openai', -1), true);
});

test('CacheManager: invalidate removes provider entry', () => {
  const cm = new CacheManager();
  cm._initData();
  cm.setProvider('openai', { models: [] });
  cm.setProvider('anthropic', { models: [] });
  cm.invalidate('openai');
  assert.equal(cm.getProvider('openai'), null);
  assert.ok(cm.getProvider('anthropic'));
});

test('CacheManager: invalidate() clears all', () => {
  const cm = new CacheManager();
  cm._initData();
  cm.setProvider('openai', { models: [] });
  cm.invalidate();
  assert.equal(cm.getProvider('openai'), null);
});

test('CacheManager: incompatible version returns null from load', () => {
  const cm = new CacheManager();
  const old = { version: 0, providers: {} };
  assert.equal(cm.migrate(old), null);
});

// ---- ProviderRegistry -------------------------------------------------------

function fakePlugin(id, type = 'llm', order = 0) {
  return {
    id, displayName: id.toUpperCase(), description: id + ' provider',
    providerType: type, order,
    capabilities: { streaming: true },
    supportedModels: [],
    configurableSettings: [],
    defaultSettings: {},
    createEngine: () => ({ provider: id, ready: false, stream() {} }),
  };
}

test('ProviderRegistry: registerPlugin + getPlugin + listPlugins', () => {
  const bus = new EventBus();
  const reg = new ProviderRegistry(bus);
  reg.registerPlugin(fakePlugin('a'));
  reg.registerPlugin(fakePlugin('b', 'llm', 2));
  reg.registerPlugin(fakePlugin('c', 'stt', 1));
  assert.ok(reg.hasPlugin('llm', 'a'));
  assert.ok(reg.hasPlugin('llm', 'b'));
  assert.ok(reg.hasPlugin('stt', 'c'));
  assert.equal(reg.listPlugins('llm').length, 2);
  assert.equal(reg.listPlugins('stt').length, 1);
  // Sorted by order
  assert.equal(reg.listPlugins('llm')[0].id, 'a');
  assert.equal(reg.listPlugins('llm')[1].id, 'b');
});

test('ProviderRegistry: capabilities normalized to rich schema', () => {
  const reg = new ProviderRegistry();
  reg.registerPlugin(fakePlugin('a'));
  const a = reg.getPlugin('llm', 'a');
  assert.deepEqual(a.capabilities, { streaming: { state: 'supported', source: 'declared', confidence: 1 } });
});

test('ProviderRegistry: renderSafe strips functions and preserves capabilities', () => {
  const reg = new ProviderRegistry();
  reg.registerPlugin(fakePlugin('a'));
  const safe = reg.renderSafe(reg.getPlugin('llm', 'a'));
  assert.equal(typeof safe.createEngine, 'undefined');
  assert.ok(safe.capabilities.streaming);
  assert.ok(JSON.stringify(safe));
});

test('ProviderRegistry: _reset clears all', () => {
  const reg = new ProviderRegistry();
  reg.registerPlugin(fakePlugin('a'));
  assert.ok(reg.hasPlugin('llm', 'a'));
  reg._reset();
  assert.ok(!reg.hasPlugin('llm', 'a'));
});

// ---- ModelRegistry ----------------------------------------------------------

test('ModelRegistry: registerModels + listModels', () => {
  const reg = new ModelRegistry();
  const models = [
    new Model({ id: 'm1', name: 'Model 1', providerId: 'openai', providerType: 'llm' }),
    new Model({ id: 'm2', name: 'Model 2', providerId: 'openai', providerType: 'llm' }),
  ];
  reg.registerModels('openai', models);
  const list = reg.listModels('openai');
  assert.equal(list.length, 2);
  // Sorted by name
  assert.equal(list[0].name, 'Model 1');
});

test('ModelRegistry: getModel by provider + id', () => {
  const reg = new ModelRegistry();
  const m = new Model({ id: 'm1', providerId: 'openai', providerType: 'llm' });
  reg.registerModel('openai', m);
  assert.equal(reg.getModel('openai', 'm1').id, 'm1');
  assert.equal(reg.getModel('openai', 'nonexistent'), null);
});

test('ModelRegistry: setSelectedModel / getSelectedModel', () => {
  const reg = new ModelRegistry();
  reg.setSelectedModel('llm', 'openai', 'fast', 'gpt-4o-mini');
  assert.deepEqual(reg.getSelectedModel('llm', 'fast'), { providerId: 'openai', modelId: 'gpt-4o-mini' });
  assert.equal(reg.getSelectedModel('llm', 'smart'), null);
});

test('ModelRegistry: handleStaleModels detects missing models', () => {
  const reg = new ModelRegistry();
  // Register a model for openai
  reg.registerModel('openai', new Model({ id: 'gpt-4o', providerId: 'openai', providerType: 'llm' }));
  // Set selection to a model that doesn't exist
  reg.setSelectedModel('llm', 'openai', 'fast', 'nonexistent');
  const result = reg.handleStaleModels();
  assert.ok(result.stale.length > 0 || result.warnings.length > 0);
});

test('ModelRegistry: _reset clears all', () => {
  const reg = new ModelRegistry();
  reg.registerModel('openai', new Model({ id: 'm1', providerId: 'openai', providerType: 'llm' }));
  reg.setSelectedModel('llm', 'openai', 'fast', 'm1');
  reg._reset();
  assert.equal(reg.listModels('openai').length, 0);
  assert.equal(reg.getSelectedModel('llm', 'fast'), null);
});

// ---- HealthMonitor ----------------------------------------------------------

test('HealthMonitor: setProviderState / getProviderHealth', () => {
  const bus = new EventBus();
  const hm = new HealthMonitor(bus);
  hm.setProviderState('openai', P_HEALTH.HEALTHY);
  const h = hm.getProviderHealth('openai');
  assert.equal(h.state, P_HEALTH.HEALTHY);
  assert.ok(h.lastCheck > 0);
});

test('HealthMonitor: emits event on state change', () => {
  const bus = new EventBus();
  const hm = new HealthMonitor(bus);
  let emitted = null;
  bus.on('health:provider', (data) => { emitted = data; });
  // Set initial state first so the second set has a previousState
  hm.setProviderState('openai', P_HEALTH.DISCOVERING);
  emitted = null;
  hm.setProviderState('openai', P_HEALTH.HEALTHY);
  assert.equal(emitted.providerId, 'openai');
  assert.equal(emitted.state, P_HEALTH.HEALTHY);
  assert.equal(emitted.previousState, P_HEALTH.DISCOVERING);
});

test('HealthMonitor: setModelState / getModelHealth', () => {
  const hm = new HealthMonitor();
  hm.setModelState('openai', 'gpt-4o', MODEL_HEALTH.AVAILABLE);
  const h = hm.getModelHealth('openai', 'gpt-4o');
  assert.equal(h.state, MODEL_HEALTH.AVAILABLE);
});

test('HealthMonitor: _reset clears all', () => {
  const hm = new HealthMonitor();
  hm.setProviderState('openai', P_HEALTH.HEALTHY);
  hm._reset();
  assert.equal(hm.getProviderHealth('openai').state, P_HEALTH.UNAVAILABLE);
});

// ---- Core index -------------------------------------------------------------

test('core: defines all expected exports', () => {
  assert.ok(core.bus);
  assert.ok(core.providerRegistry);
  assert.ok(core.modelRegistry);
  assert.ok(core.capabilityRegistry);
  assert.ok(core.healthMonitor);
  assert.ok(core.cacheManager);
  assert.ok(core.discoveryEngine);
  assert.equal(typeof core.definePlugin, 'function');
  assert.equal(typeof core.defineProvider, 'function');
  assert.equal(typeof core.start, 'function');
  assert.equal(typeof core.stop, 'function');
});

test('core: definePlugin registers and healthMonitor tracks', () => {
  core._reset();
  const unsub = core.definePlugin(fakePlugin('test-core'));
  assert.ok(core.providerRegistry.hasPlugin('llm', 'test-core'));
  const health = core.healthMonitor.getProviderHealth('test-core');
  assert.equal(health.state, P_HEALTH.DISCOVERING);
  unsub();
  core._reset();
});
