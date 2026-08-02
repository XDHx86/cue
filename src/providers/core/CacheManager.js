// Cache Manager — versioned persistent cache with TTL, migration, and invalidation.
//
// Stores discovered providers, models, capabilities, and health states to disk so
// the app can display provider information instantly on startup while background
// refresh runs. The cache is versioned: incompatible schema changes trigger automatic
// invalidation and re-discovery.
//
// Cache location: <userData>/cue-provider-cache.json
// Pure given an injected fs/path (testable without Electron).

const CACHE_VERSION = 1
const DEFAULT_REMOTE_TTL_MS = 3600000  // 1 hour
const DEFAULT_LOCAL_TTL_MS = 300000    // 5 minutes

class CacheManager {
  constructor({ fs, path, cachePath } = {}) {
    this._fs = fs || require('fs')
    this._path = path || require('path')
    this._cachePath = cachePath || null // set lazily via configure()
    this._data = null                   // in-memory cache (loaded from disk)
  }

  // Set the cache file path (called by core/index.js with userData path).
  configure(userDataPath) {
    this._cachePath = this._path.join(userDataPath, 'cue-provider-cache.json')
  }

  // Load cache from disk. Returns the in-memory data or null.
  // Validates version — incompatible versions return null (triggers re-discovery).
  load() {
    if (this._data) return this._data
    if (!this._cachePath) return null
    try {
      const raw = this._fs.readFileSync(this._cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.version === CACHE_VERSION) {
        this._data = parsed
        return this._data
      }
      // Incompatible version — discard
      this._data = null
      return null
    } catch {
      // No cache file or parse error — cold start
      this._data = null
      return null
    }
  }

  // Save cache to disk (async, fire-and-forget).
  save() {
    if (!this._cachePath || !this._data) return
    const data = { ...this._data, version: CACHE_VERSION }
    try {
      this._fs.writeFileSync(this._cachePath, JSON.stringify(data, null, 2))
    } catch { /* disk errors are non-fatal */ }
  }

  // Get cached data for a provider.
  getProvider(providerId) {
    return this._data?.providers?.[providerId] || null
  }

  // Set cached data for a provider. Includes models, capabilities, health.
  setProvider(providerId, data) {
    if (!this._data) this._initData()
    this._data.providers[providerId] = {
      ...data,
      updatedAt: Date.now(),
    }
  }

  // Check if a provider's cache entry is expired based on TTL.
  isExpired(providerId, ttlMs) {
    const entry = this.getProvider(providerId)
    if (!entry || !entry.updatedAt) return true
    return (Date.now() - entry.updatedAt) > ttlMs
  }

  // Get the age of a cache entry in ms, or null if not cached.
  getAge(providerId) {
    const entry = this.getProvider(providerId)
    if (!entry || !entry.updatedAt) return null
    return Date.now() - entry.updatedAt
  }

  // Invalidate (remove) one provider's cache, or all if providerId is omitted.
  invalidate(providerId) {
    if (!this._data) return
    if (providerId) {
      delete this._data.providers[providerId]
    } else {
      this._data.providers = {}
    }
  }

  // Get the appropriate TTL for a provider based on its type.
  getTTL(providerType) {
    return providerType === 'llm' ? DEFAULT_REMOTE_TTL_MS : DEFAULT_LOCAL_TTL_MS
  }

  // Migrate an old cache schema to the current version.
  // Returns null if the cache is too old to migrate.
  migrate(oldCache) {
    if (!oldCache || typeof oldCache !== 'object') return null
    if (oldCache.version === CACHE_VERSION) return oldCache
    // Future: add migration logic for version bumps here
    // For now, any version mismatch → null (triggers full re-discovery)
    return null
  }

  // Get the full in-memory cache data.
  getData() {
    return this._data
  }

  // Test escape hatch: reset in-memory state.
  _reset() {
    this._data = null
  }

  _initData() {
    this._data = {
      version: CACHE_VERSION,
      createdAt: Date.now(),
      providers: {},
    }
  }
}

module.exports = { CacheManager, CACHE_VERSION, DEFAULT_REMOTE_TTL_MS, DEFAULT_LOCAL_TTL_MS }
