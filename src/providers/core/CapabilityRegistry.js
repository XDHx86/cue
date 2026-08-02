// Capability Registry — data-only registry mapping capability names to metadata.
//
// This module stores metadata about capabilities (icons, labels, categories, priorities,
// hints). It never renders HTML — the renderer reads this data and builds its own UI.
// Adding a new capability requires only adding an entry here; the renderer generates
// badges dynamically.
//
// Capability resolution follows a precedence chain:
//   model-level → provider-level → adapter-level → static fallback → unknown
// This module provides the metadata layer; the Model.getCapability() method in Model.js
// implements the precedence chain.

const CAPABILITY_SCHEMA = {
  streaming: {
    label: 'Streaming',
    category: 'transport',
    priority: 1,
    icon: 'streaming',
    hint: 'Supports real-time streaming responses',
  },
  vision: {
    label: 'Vision',
    category: 'input',
    priority: 2,
    icon: 'vision',
    hint: 'Can process image inputs',
  },
  local: {
    label: 'Local',
    category: 'deployment',
    priority: 3,
    icon: 'local',
    hint: 'Runs on your machine',
  },
  batch: {
    label: 'Batch',
    category: 'transport',
    priority: 4,
    icon: 'batch',
    hint: 'Processes complete files',
  },
  reasoning: {
    label: 'Reasoning',
    category: 'intelligence',
    priority: 5,
    icon: 'reasoning',
    hint: 'Extended reasoning / chain-of-thought',
  },
  autoSwitch: {
    label: 'Auto-switch',
    category: 'behavior',
    priority: 6,
    icon: 'auto-switch',
    hint: 'Can be auto-selected when no other provider has a key',
  },
}

class CapabilityRegistry {
  constructor(schema = CAPABILITY_SCHEMA) {
    this._schema = { ...schema }
  }

  // Get metadata for a single capability name.
  // Returns { label, category, priority, icon, hint } or null if unknown.
  getCapabilityMeta(name) {
    return this._schema[name] || null
  }

  // Get all capability metadata entries, sorted by priority.
  getAll() {
    return Object.entries(this._schema)
      .map(([name, meta]) => ({ name, ...meta }))
      .sort((a, b) => (a.priority || 99) - (b.priority || 99))
  }

  // Get capabilities for a provider, resolved through the precedence chain.
  // providerCaps is the provider descriptor's capabilities object (rich or boolean).
  // Returns sorted list of { name, meta, capability }.
  getCapabilitiesForProvider(providerCaps = {}) {
    const result = []
    for (const [name, meta] of Object.entries(this._schema)) {
      const cap = providerCaps[name]
      if (cap != null) {
        result.push({ name, meta, capability: cap })
      }
    }
    return result.sort((a, b) => (a.meta.priority || 99) - (b.meta.priority || 99))
  }

  // Get capability groups organized by category.
  // Returns { transport: [...], input: [...], ... }
  getCategoryGroups() {
    const groups = {}
    for (const [name, meta] of Object.entries(this._schema)) {
      const cat = meta.category || 'other'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push({ name, ...meta })
    }
    // Sort within each group by priority
    for (const cat of Object.keys(groups)) {
      groups[cat].sort((a, b) => (a.priority || 99) - (b.priority || 99))
    }
    return groups
  }

  // Resolve a capability through the precedence chain:
  // model-level → provider-level → adapter-level → static fallback → unknown
  resolveCapability(name, modelCaps = {}, providerCaps = {}, adapterCaps = {}) {
    // 1. Model-level (most specific)
    if (modelCaps[name] != null) return modelCaps[name]
    // 2. Provider-level
    if (providerCaps[name] != null) return providerCaps[name]
    // 3. Adapter-level
    if (adapterCaps[name] != null) return adapterCaps[name]
    // 4. Static fallback — if we have schema metadata, return a default 'supported' state
    if (this._schema[name]) {
      return { state: 'unknown', source: 'fallback', confidence: 0 }
    }
    // 5. Unknown capability
    return { state: 'unknown', source: 'none', confidence: 0 }
  }

  // Register a new capability or override an existing one.
  register(name, meta) {
    this._schema[name] = { ...this._schema[name], ...meta }
  }

  // Test escape hatch: reset to empty schema.
  _reset() {
    this._schema = {}
  }

  // Restore the default schema (test helper).
  _restoreDefaults() {
    this._schema = { ...CAPABILITY_SCHEMA }
  }
}

module.exports = { CapabilityRegistry, CAPABILITY_SCHEMA }
