// Model — first-class entity representing a discoverable model.
//
// Every model in the system is a Model instance with a normalized schema. Providers discover
// models via async discoverModels() and normalize the raw response through an adapter into
// Model instances. The ModelRegistry stores them; the renderer consumes them; the cache
// persists them.
//
// Models carry rich capability data (not just booleans) with state, source, and confidence.
// The precedence chain for capabilities is: model-level → provider-level → adapter-level →
// static fallback → unknown.

const HEALTH = {
  AVAILABLE: 'available',
  DEPRECATED: 'deprecated',
  UNAVAILABLE: 'unavailable',
  QUOTA_EXCEEDED: 'quota_exceeded',
  INSTALLING: 'installing',
}

const MODEL_SOURCES = {
  DISCOVERED: 'discovered',
  STATIC: 'static',
  CACHE: 'cache',
}

class Model {
  constructor({
    id,
    name,
    providerId,
    providerType,             // 'llm' | 'stt'
    capabilities = {},        // rich: { streaming: { state, source, confidence }, ... }
    contextWindow = null,     // number or null
    maxOutputTokens = null,   // number or null
    pricing = null,           // { input: number, output: number } per 1k tokens or null
    metadata = {},            // raw provider-specific payload (opaque)
    status = HEALTH.AVAILABLE,
    deprecation = null,       // { date, replacement, message } or null
    discoveredAt = null,      // timestamp ms
    source = MODEL_SOURCES.STATIC,
  }) {
    if (!id || typeof id !== 'string') throw new Error('Model: id must be a non-empty string');
    if (!providerId || typeof providerId !== 'string') throw new Error('Model: providerId must be a non-empty string');
    if (!providerType || !['llm', 'stt'].includes(providerType)) {
      throw new Error('Model: providerType must be "llm" or "stt"');
    }
    this.id = id
    this.name = name || id
    this.providerId = providerId
    this.providerType = providerType
    this.capabilities = capabilities
    this.contextWindow = contextWindow
    this.maxOutputTokens = maxOutputTokens
    this.pricing = pricing
    this.metadata = metadata
    this.status = status
    this.deprecation = deprecation
    this.discoveredAt = discoveredAt || Date.now()
    this.source = source
  }

  // Check if this model is usable (available + not deprecated/unavailable)
  isUsable() {
    return this.status === HEALTH.AVAILABLE || this.status === HEALTH.INSTALLING
  }

  // Get a capability with the precedence chain:
  // model-level → provider-level → adapter-level → static fallback → unknown
  getCapability(name, providerCaps = {}, adapterCaps = {}) {
    // 1. Model-level capability (most specific)
    const modelCap = this.capabilities[name]
    if (modelCap != null) return modelCap
    // 2. Provider-level capability
    const provCap = providerCaps[name]
    if (provCap != null) return provCap
    // 3. Adapter-level capability
    const adaptCap = adapterCaps[name]
    if (adaptCap != null) return adaptCap
    // 4. Unknown (no fallback boolean — return a structured unknown)
    return { state: 'unknown', source: 'none', confidence: 0 }
  }

  // Serialize to a plain object (safe for JSON / IPC).
  // Strips metadata to keep payloads small; includeMetadata for cache.
  toJSON(includeMetadata = false) {
    const obj = {
      id: this.id,
      name: this.name,
      providerId: this.providerId,
      providerType: this.providerType,
      capabilities: this.capabilities,
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      pricing: this.pricing,
      status: this.status,
      deprecation: this.deprecation,
      discoveredAt: this.discoveredAt,
      source: this.source,
    }
    if (includeMetadata) obj.metadata = this.metadata
    return obj
  }

  // Deserialize from a plain object (e.g. loaded from cache).
  static fromJSON(obj) {
    if (!obj || typeof obj !== 'object') return null
    return new Model({
      id: obj.id,
      name: obj.name,
      providerId: obj.providerId,
      providerType: obj.providerType,
      capabilities: obj.capabilities || {},
      contextWindow: obj.contextWindow || null,
      maxOutputTokens: obj.maxOutputTokens || null,
      pricing: obj.pricing || null,
      metadata: obj.metadata || {},
      status: obj.status || HEALTH.AVAILABLE,
      deprecation: obj.deprecation || null,
      discoveredAt: obj.discoveredAt || null,
      source: obj.source || MODEL_SOURCES.STATIC,
    })
  }

  // Normalize a raw provider-specific model object into a Model instance.
  // The adapter provides provider-specific normalization logic.
  static fromRaw(raw, providerId, providerType, adapter = {}) {
    if (!raw || typeof raw !== 'object') return null
    const normalize = adapter.normalizeModel || defaultNormalize
    const fields = normalize(raw, providerId, providerType)
    return new Model({
      ...fields,
      providerId,
      providerType,
      source: MODEL_SOURCES.DISCOVERED,
      discoveredAt: Date.now(),
      metadata: raw,
    })
  }
}

// Default normalizer — handles common { id, name } or { id } shapes
function defaultNormalize(raw, providerId, providerType) {
  return {
    id: String(raw.id || raw.name || ''),
    name: String(raw.name || raw.id || raw.displayName || ''),
    capabilities: {},
    contextWindow: raw.context_window || raw.contextWindow || null,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
    status: HEALTH.AVAILABLE,
    deprecation: raw.deprecation || null,
  }
}

module.exports = { Model, HEALTH, MODEL_SOURCES, defaultNormalize }
