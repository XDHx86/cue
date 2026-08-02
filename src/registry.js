// Provider registry — the single capability/metadata spine for cue's LLM and STT providers.
//
// This file is now a thin backward-compatible facade over the plugin-centric discovery
// system in src/providers/core/. The core owns the singleton services (ProviderRegistry,
// ModelRegistry, HealthMonitor, etc.); this module preserves the legacy API surface so
// existing consumers (src/llm.js, src/stt.js, src/store.js, src/registry-loader.js,
// main.js, provider modules, and the test suite) keep working unchanged.
//
// R3 architecture note: the descriptor shape here has grown into the plugin contract
// (PluginInterface.js). Providers now self-describe discovery (discoverModels), health
// (healthCheck), capabilities (rich schema), configurableSettings with settingsPath, and
// createEngine — all orchestrated by the core services. This facade delegates every
// operation to the core singleton registries.

const core = require('./providers/core')
const { PROVIDER_TYPES, FIELD_KINDS } = require('./providers/core/PluginInterface')

// Register a provider descriptor. Returns an unsubscribe so tests can roll a provider
// back; the app itself loads providers once at startup and never unsubscribes.
// Re-defining the same (type,id) replaces the prior descriptor.
function defineProvider(desc) {
  return core.definePlugin(desc)
}

// All descriptors of a type, sorted by `order` ascending (STT fallback chain = ordered;
// LLM order is only used for Settings display ordering). Returns the live descriptor
// objects (with functions) — main-process callers only.
function listProviders(type) {
  return core.providerRegistry.listPlugins(type)
}

// One descriptor by (type, id), or null.
function getProvider(type, id) {
  return core.providerRegistry.getPlugin(type, id)
}

function hasProvider(type, id) {
  return core.providerRegistry.hasPlugin(type, id)
}

// Strip the function values so the descriptor is JSON-safe for the renderer.
function renderSafe(desc) {
  return core.providerRegistry.renderSafe(desc)
}

function listProvidersSafe(type) {
  return core.providerRegistry.listPluginsSafe(type)
}

// Resolve the effective supportedModels for a provider at runtime. `supportedModels` may
// be a static array or a function(ctx) → array|Promise<array>.
async function resolveSupportedModels(desc, ctx) {
  return core.providerRegistry.resolveSupportedModels(desc, ctx)
}

// Test escape hatch: clear every registered descriptor and registered model.
function _resetProviders() {
  core.providerRegistry._reset()
  core.modelRegistry._reset()
}

module.exports = {
  PROVIDER_TYPES, FIELD_KINDS,
  defineProvider, listProviders, getProvider, hasProvider,
  renderSafe, listProvidersSafe, resolveSupportedModels,
  _resetProviders,
}
