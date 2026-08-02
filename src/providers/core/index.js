// Core — public API + startup orchestrator for the provider discovery system.
//
// Owns the singleton services: event bus, provider registry, model registry,
// capability registry, health monitor, cache manager, and discovery engine.
// Provider plugin modules call definePlugin() (alias defineProvider for the legacy
// path). main.js calls configure({ userDataPath }) then start().
//
// Pure JS: no electron require here. The cache path is configured lazily by main.js
// so the pure-Node test suite can load this module without electron.

const { EventBus } = require('./EventBus')
const { Model, HEALTH, MODEL_SOURCES } = require('./Model')
const { CapabilityRegistry, CAPABILITY_SCHEMA } = require('./CapabilityRegistry')
const { CacheManager, CACHE_VERSION } = require('./CacheManager')
const { ProviderRegistry } = require('./ProviderRegistry')
const { ModelRegistry } = require('./ModelRegistry')
const { HealthMonitor, HEALTH: PROVIDER_HEALTH, MODEL_HEALTH } = require('./HealthMonitor')
const { DiscoveryEngine, DEFAULT_CONFIG } = require('./DiscoveryEngine')
const {
  PROVIDER_TYPES, FIELD_KINDS,
  validatePlugin, validateField, normalizeCapability, normalizeCapabilities, coerceOrder,
} = require('./PluginInterface')

// ---- Singleton services -----------------------------------------------------
const bus = new EventBus()
const capabilityRegistry = new CapabilityRegistry()
const providerRegistry = new ProviderRegistry(bus)
const modelRegistry = new ModelRegistry(bus, capabilityRegistry)
const healthMonitor = new HealthMonitor(bus)
const cacheManager = new CacheManager()
const discoveryEngine = new DiscoveryEngine(bus, providerRegistry, modelRegistry, healthMonitor, cacheManager)

// ---- Registration entry point ----------------------------------------------
// Provider plugin modules call this to self-register. Returns an unsubscribe so
// tests can roll a plugin back. Re-defining the same (type,id) replaces it.
function definePlugin(desc) {
  const unsubscribe = providerRegistry.registerPlugin(desc)
  healthMonitor.registerPlugin(desc.id, desc)
  return unsubscribe
}

// Backward-compatible alias for the legacy defineProvider name.
function defineProvider(desc) {
  return definePlugin(desc)
}

// ---- Startup ----------------------------------------------------------------
// Configure the cache path. Called by main.js with the userData directory.
function configure({ userDataPath } = {}) {
  if (userDataPath) cacheManager.configure(userDataPath)
  return core
}

// Start the discovery lifecycle (cache load → display → background refresh).
function start() {
  discoveryEngine.start()
  return core
}

// Stop all discovery, background refresh, and health checks.
function stop() {
  discoveryEngine.stop()
  return core
}

// The public API object.
const core = {
  // Services
  bus,
  providerRegistry,
  modelRegistry,
  capabilityRegistry,
  healthMonitor,
  cacheManager,
  discoveryEngine,

  // Registration
  definePlugin,
  defineProvider,

  // Startup
  configure,
  start,
  stop,

  // Types / constants
  Model, HEALTH, MODEL_SOURCES,
  PROVIDER_HEALTH, MODEL_HEALTH,
  PROVIDER_TYPES, FIELD_KINDS,
  CAPABILITY_SCHEMA, CACHE_VERSION, DEFAULT_CONFIG,

  // Plugin interface helpers (for provider authors / tests)
  validatePlugin, validateField, normalizeCapability, normalizeCapabilities, coerceOrder,

  // Test escape hatch: reset all services.
  _reset() {
    providerRegistry._reset()
    modelRegistry._reset()
    healthMonitor._reset()
    capabilityRegistry._restoreDefaults()
    cacheManager._reset()
  },
}

module.exports = core
