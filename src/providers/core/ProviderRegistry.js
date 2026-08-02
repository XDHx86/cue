// Provider Registry — plugin CRUD, lookup, registration.
//
// Manages the lifecycle of provider plugins. Each plugin is a self-contained descriptor
// that encapsulates discovery, normalization, health checks, validation, and provider-
// specific logic. The registry only orchestrates plugins — it never implements provider-
// specific behavior.
//
// This module replaces the provider-focused parts of the legacy src/registry.js. The
// legacy module becomes a thin backward-compatible facade that delegates here.

const { validatePlugin, coerceOrder, normalizeCapabilities, PROVIDER_TYPES } = require('./PluginInterface')

class ProviderRegistry {
  constructor(bus) {
    this._bus = bus
    this._plugins = new Map() // 'type:id' → descriptor
  }

  // Register a plugin descriptor. Validates at registration time.
  // Returns an unsubscribe function so tests can roll back.
  registerPlugin(desc) {
    const d = desc && typeof desc === 'object' ? { ...desc } : desc
    validatePlugin(d)
    d.order = coerceOrder(d.order)
    // Normalize capabilities to rich schema (boolean → { state, source, confidence })
    d.capabilities = normalizeCapabilities(d.capabilities)
    const k = this._key(d.providerType, d.id)
    this._plugins.set(k, d)
    // Emit registration event
    if (this._bus) {
      this._bus.emit('discovery:provider:load', {
        providerId: d.id,
        providerType: d.providerType,
      })
      this._bus.emit('capabilities:update', {
        providerId: d.id,
        capabilities: d.capabilities,
      })
    }
    return () => this._plugins.delete(k)
  }

  // Unregister a plugin by type and id.
  unregisterPlugin(type, id) {
    const k = this._key(type, id)
    const existed = this._plugins.delete(k)
    if (existed && this._bus) {
      this._bus.emit('discovery:provider:done', {
        providerId: id,
        providerType: type,
        modelCount: 0,
      })
    }
    return existed
  }

  // Get a plugin descriptor by type and id (with functions).
  getPlugin(type, id) {
    return this._plugins.get(this._key(type, id)) || null
  }

  // Get all plugins of a type, sorted by order ascending.
  listPlugins(type) {
    if (type && !PROVIDER_TYPES.includes(type)) return []
    const out = []
    for (const d of this._plugins.values()) {
      if (!type || d.providerType === type) out.push(d)
    }
    out.sort((a, b) => (a.order || 0) - (b.order || 0))
    return out
  }

  // Check if a plugin exists.
  hasPlugin(type, id) {
    return this._plugins.has(this._key(type, id))
  }

  // Strip function values for JSON-safe IPC (renderer consumption).
  renderSafe(desc) {
    if (!desc) return null
    return {
      id: desc.id,
      displayName: desc.displayName,
      description: desc.description || '',
      providerType: desc.providerType,
      capabilities: desc.capabilities || {},
      supportedModels: desc.supportedModels || null,
      modelSettingsPath: desc.modelSettingsPath || null,
      configurableSettings: desc.configurableSettings || [],
      defaultSettings: desc.defaultSettings || {},
      order: desc.order || 0,
      skipAutoSwitch: !!desc.skipAutoSwitch,
      // New plugin fields
      healthConfig: desc.healthConfig || null,
    }
  }

  // Render-safe list for IPC.
  listPluginsSafe(type) {
    return this.listPlugins(type).map(d => this.renderSafe(d))
  }

  // Render-safe by type and id.
  getPluginSafe(type, id) {
    return this.renderSafe(this.getPlugin(type, id))
  }

  // Resolve the effective supportedModels for a plugin at runtime.
  // supportedModels may be a static array or a function(ctx) → array|Promise<array>.
  async resolveSupportedModels(desc, ctx) {
    if (desc == null) return null
    const sm = desc.supportedModels
    if (sm == null) return null
    if (typeof sm === 'function') {
      const out = await sm(ctx)
      return Array.isArray(out) ? out : null
    }
    return Array.isArray(sm) ? sm : null
  }

  // Test escape hatch: clear all registered plugins.
  _reset() {
    this._plugins.clear()
  }

  _key(type, id) {
    return type + ':' + id
  }
}

module.exports = { ProviderRegistry }
