// Health Monitor — provider + model health tracking.
//
// Tracks health states for both providers and individual models. Provider states:
// healthy, discovering, offline, invalid_config, rate_limited, unavailable.
// Model states: available, deprecated, unavailable, quota_exceeded, installing.
//
// Health checks run periodically for each provider that declares a healthCheck function.
// The monitor emits events on state changes so the UI can update reactively.

const HEALTH = {
  // Provider health states
  HEALTHY: 'healthy',
  DISCOVERING: 'discovering',
  OFFLINE: 'offline',
  INVALID_CONFIG: 'invalid_config',
  RATE_LIMITED: 'rate_limited',
  UNAVAILABLE: 'unavailable',
}

const MODEL_HEALTH = {
  AVAILABLE: 'available',
  DEPRECATED: 'deprecated',
  UNAVAILABLE: 'unavailable',
  QUOTA_EXCEEDED: 'quota_exceeded',
  INSTALLING: 'installing',
}

class HealthMonitor {
  constructor(bus) {
    this._bus = bus
    this._providerHealth = new Map() // providerId → { state, previousState, lastCheck, reason, details }
    this._modelHealth = new Map()    // 'providerId:modelId' → { state, previousState, lastCheck, reason }
    this._checkIntervals = new Map() // providerId → intervalId
    this._plugins = new Map()        // providerId → plugin descriptor (set by DiscoveryEngine)
  }

  // Register a plugin for health monitoring.
  registerPlugin(providerId, plugin) {
    this._plugins.set(providerId, plugin)
    // Set initial state to discovering
    this.setProviderState(providerId, HEALTH.DISCOVERING)
  }

  // Unregister a plugin (stop its health checks).
  unregisterPlugin(providerId) {
    this._plugins.delete(providerId)
    this._stopCheck(providerId)
    this._providerHealth.delete(providerId)
  }

  // Set provider health state. Emits 'health:provider' on state change.
  setProviderState(providerId, state, reason, details) {
    const prev = this._providerHealth.get(providerId)
    const previousState = prev?.state || null
    if (previousState === state && prev?.reason === reason) return // no change
    this._providerHealth.set(providerId, {
      state,
      previousState,
      lastCheck: Date.now(),
      reason: reason || null,
      details: details || null,
    })
    if (this._bus) {
      this._bus.emit('health:provider', {
        providerId,
        state,
        previousState,
        timestamp: Date.now(),
      })
    }
  }

  // Set model health state. Emits 'health:model' on state change.
  setModelState(providerId, modelId, state, reason) {
    const k = providerId + ':' + modelId
    const prev = this._modelHealth.get(k)
    const previousState = prev?.state || null
    if (previousState === state) return
    this._modelHealth.set(k, {
      state,
      previousState,
      lastCheck: Date.now(),
      reason: reason || null,
    })
    if (this._bus) {
      this._bus.emit('health:model', {
        providerId,
        modelId,
        state,
        previousState,
        timestamp: Date.now(),
      })
    }
  }

  // Get provider health state.
  getProviderHealth(providerId) {
    return this._providerHealth.get(providerId) || { state: HEALTH.UNAVAILABLE, lastCheck: null }
  }

  // Get model health state.
  getModelHealth(providerId, modelId) {
    return this._modelHealth.get(providerId + ':' + modelId) || { state: MODEL_HEALTH.AVAILABLE, lastCheck: null }
  }

  // Get all provider health states.
  getAllProviderHealth() {
    const result = {}
    for (const [id, health] of this._providerHealth) {
      result[id] = health
    }
    return result
  }

  // Run a health check for one provider. Calls the plugin's healthCheck function
  // if available, otherwise sets state to HEALTHY (assumed healthy).
  async checkProvider(providerId) {
    const plugin = this._plugins.get(providerId)
    if (!plugin) return
    if (typeof plugin.healthCheck !== 'function') {
      // No health check function — assume healthy if configured
      this.setProviderState(providerId, HEALTH.HEALTHY)
      return
    }
    try {
      const result = await plugin.healthCheck({
        apiKey: null,  // passed by the discovery engine with actual settings
        baseURL: null,
        signal: AbortSignal.timeout(plugin.healthConfig?.timeoutMs || 5000),
      })
      if (result && typeof result === 'object') {
        this.setProviderState(providerId, result.state || HEALTH.HEALTHY, result.reason, result.details)
      } else {
        this.setProviderState(providerId, HEALTH.HEALTHY)
      }
    } catch (err) {
      this.setProviderState(providerId, HEALTH.UNAVAILABLE, err.message)
    }
  }

  // Start periodic health checks for all registered plugins.
  startChecking(defaultIntervalMs = 300000) {
    for (const [providerId, plugin] of this._plugins) {
      const interval = plugin.healthConfig?.intervalMs || defaultIntervalMs
      this._startCheck(providerId, interval)
    }
  }

  // Stop all periodic health checks.
  stopChecking() {
    for (const providerId of this._checkIntervals.keys()) {
      this._stopCheck(providerId)
    }
  }

  // Stop health checks for one provider.
  _stopCheck(providerId) {
    const id = this._checkIntervals.get(providerId)
    if (id != null) {
      clearInterval(id)
      this._checkIntervals.delete(providerId)
    }
  }

  _startCheck(providerId, intervalMs) {
    this._stopCheck(providerId) // clear any existing
    const id = setInterval(() => this.checkProvider(providerId), intervalMs)
    // Don't keep the process alive for health check intervals
    if (id.unref) id.unref()
    this._checkIntervals.set(providerId, id)
  }

  // Test escape hatch: reset all state.
  _reset() {
    this.stopChecking()
    this._providerHealth.clear()
    this._modelHealth.clear()
    this._plugins.clear()
  }
}

module.exports = { HealthMonitor, HEALTH, MODEL_HEALTH }
