// Discovery Engine — concurrent discovery orchestrator with startup/background/manual paths.
//
// Coordinates provider registration, model discovery, health checks, and cache updates.
// Discovery is async and never blocks the UI: it loads cached data immediately, then
// refreshes in the background. Individual provider failures never block other providers.

const { Model, MODEL_SOURCES } = require('./Model')
const { HEALTH } = require('./HealthMonitor')

const DEFAULT_CONFIG = {
  concurrency: 4,              // max concurrent provider discoveries
  startupTimeout: 30000,       // max time for startup discovery
  providerTimeout: 10000,      // max time per provider discovery
  backgroundInterval: 300000,  // 5 min for local providers
  remoteInterval: 3600000,     // 1 hour for remote providers
}

class DiscoveryEngine {
  constructor(bus, providerRegistry, modelRegistry, healthMonitor, cacheManager, config = {}) {
    this._bus = bus
    this._providers = providerRegistry
    this._models = modelRegistry
    this._health = healthMonitor
    this._cache = cacheManager
    this._config = { ...DEFAULT_CONFIG, ...config }
    this._running = false
    this._abortController = null
    this._bgTimers = new Map()
  }

  // Start the discovery lifecycle:
  // 1. Load cache (instant)
  // 2. Emit cached data to subscribers
  // 3. Background: concurrent provider + model discovery
  // 4. Each provider's discovery runs independently
  // 5. Emit events as each completes
  async start() {
    if (this._running) return
    this._running = true
    this._abortController = new AbortController()

    // 1. Load cache
    const cached = this._cache.load()

    // 2. Emit cached data for immediate UI display
    if (cached && cached.providers) {
      for (const [providerId, data] of Object.entries(cached.providers)) {
        if (data.models && data.models.length) {
          const models = data.models.map(m => m instanceof Model ? m : Model.fromJSON(m)).filter(Boolean)
          this._models.registerModels(providerId, models)
        }
        if (data.health) {
          this._health.setProviderState(providerId, data.health)
        }
      }
      if (this._bus) {
        this._bus.emit('cache:loaded', { fromDisk: true, age: cached.createdAt ? Date.now() - cached.createdAt : 0 })
      }
    }

    // 3. Background: discover all providers concurrently
    this._discoverAll()
  }

  // Discover all providers concurrently with a concurrency limit.
  async _discoverAll() {
    if (this._bus) {
      this._bus.emit('discovery:start', { providerType: 'all' })
    }

    const allPlugins = [
      ...this._providers.listPlugins('llm'),
      ...this._providers.listPlugins('stt'),
    ]

    let succeeded = 0
    let failed = 0

    // Process in batches respecting concurrency limit
    for (let i = 0; i < allPlugins.length; i += this._config.concurrency) {
      if (!this._running) break
      const batch = allPlugins.slice(i, i + this._config.concurrency)
      const results = await Promise.allSettled(
        batch.map(plugin => this._discoverProvider(plugin))
      )
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) succeeded++
        else failed++
      }
    }

    if (this._bus) {
      this._bus.emit('discovery:complete', {
        providerType: 'all',
        total: allPlugins.length,
        succeeded,
        failed,
      })
    }

    // Start background refresh timers
    this._startBackgroundRefresh()

    // Start periodic health checks
    this._health.startChecking(this._config.backgroundInterval)
  }

  // Discover models for a single provider. Handles timeout, normalization, and caching.
  async _discoverProvider(plugin) {
    const providerId = plugin.id
    const providerType = plugin.providerType

    this._health.setProviderState(providerId, HEALTH.DISCOVERING)

    try {
      let models = []

      // Try async discovery first
      if (typeof plugin.discoverModels === 'function') {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this._config.providerTimeout)

        try {
          const raw = await plugin.discoverModels({ signal: controller.signal })
          clearTimeout(timeout)

          if (raw && Array.isArray(raw) && raw.length > 0) {
            // Normalize via adapter
            const normalize = plugin.normalizeModels || defaultNormalize
            models = raw.map(m => {
              const fields = typeof normalize === 'function' ? normalize(m) : defaultNormalize(m)
              return new Model({
                ...fields,
                providerId,
                providerType,
                source: MODEL_SOURCES.DISCOVERED,
                discoveredAt: Date.now(),
                metadata: m,
              })
            }).filter(Boolean)
          }
        } catch (err) {
          clearTimeout(timeout)
          if (err.name === 'AbortError') {
            // Timeout — fall back to static
          } else {
            throw err
          }
        }
      }

      // Fall back to static supportedModels if discovery returned nothing
      if (models.length === 0) {
        const staticModels = await this._providers.resolveSupportedModels(plugin, {})
        if (staticModels && Array.isArray(staticModels)) {
          models = staticModels.map(m => {
            const id = typeof m === 'string' ? m : m.id
            const name = typeof m === 'string' ? m : (m.label || m.name || m.id)
            return new Model({
              id,
              name,
              providerId,
              providerType,
              capabilities: plugin.capabilities || {},
              source: MODEL_SOURCES.STATIC,
              discoveredAt: Date.now(),
            })
          }).filter(Boolean)
        }
      }

      // Register models
      if (models.length > 0) {
        this._models.registerModels(providerId, models)
      }

      // Set health to healthy
      this._health.setProviderState(providerId, HEALTH.HEALTHY)

      // Update cache
      this._cache.setProvider(providerId, {
        models: models.map(m => m.toJSON(true)),
        capabilities: plugin.capabilities || {},
        health: HEALTH.HEALTHY,
      })

      // Emit events
      if (this._bus) {
        this._bus.emit('discovery:provider:done', {
          providerId,
          providerType,
          modelCount: models.length,
        })
      }

      return true
    } catch (err) {
      // Discovery failed — determine health state
      const state = err.status === 429 ? HEALTH.RATE_LIMITED :
                    err.status === 401 || err.status === 403 ? HEALTH.INVALID_CONFIG :
                    HEALTH.UNAVAILABLE
      this._health.setProviderState(providerId, state, err.message)

      if (this._bus) {
        this._bus.emit('discovery:error', { providerId, error: err.message })
        this._bus.emit('discovery:provider:done', {
          providerId,
          providerType,
          modelCount: 0,
          error: err.message,
        })
      }

      return false
    }
  }

  // Re-discover a single provider.
  async refreshProvider(providerId) {
    const plugin = this._providers.getPlugin('llm', providerId) ||
                   this._providers.getPlugin('stt', providerId)
    if (!plugin) return false
    return this._discoverProvider(plugin)
  }

  // Re-discover all providers.
  async refreshAll() {
    this._stopBackgroundRefresh()
    await this._discoverAll()
  }

  // Stop all discovery and background refresh.
  stop() {
    this._running = false
    if (this._abortController) {
      this._abortController.abort()
      this._abortController = null
    }
    this._stopBackgroundRefresh()
    this._health.stopChecking()
  }

  // Start background refresh timers for each provider.
  _startBackgroundRefresh() {
    for (const plugin of [...this._providers.listPlugins('llm'), ...this._providers.listPlugins('stt')]) {
      const interval = plugin.healthConfig?.intervalMs ||
                       (plugin.skipAutoSwitch ? this._config.backgroundInterval : this._config.remoteInterval)
      const timer = setInterval(() => {
        if (this._running) this._discoverProvider(plugin)
      }, interval)
      if (timer.unref) timer.unref()
      this._bgTimers.set(plugin.id, timer)
    }
  }

  _stopBackgroundRefresh() {
    for (const timer of this._bgTimers.values()) {
      clearInterval(timer)
    }
    this._bgTimers.clear()
  }
}

// Default normalizer — handles common { id, name } shapes
function defaultNormalize(raw) {
  return {
    id: String(raw.id || raw.name || ''),
    name: String(raw.name || raw.id || raw.displayName || ''),
    capabilities: {},
    contextWindow: raw.context_window || raw.contextWindow || null,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
    status: 'available',
    deprecation: raw.deprecation || null,
  }
}

module.exports = { DiscoveryEngine, DEFAULT_CONFIG }
