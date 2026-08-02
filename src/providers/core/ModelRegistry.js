// Model Registry — model entity management, selection, normalization.
//
// Stores discovered models per provider, manages model selection (which model the
// user has chosen for each provider/tier), handles stale model detection, and
// integrates with the cache and capability registry.

const { Model, HEALTH } = require('./Model')

class ModelRegistry {
  constructor(bus, capabilityRegistry) {
    this._bus = bus
    this._caps = capabilityRegistry
    this._models = new Map()  // providerId → Map<modelId, Model>
    this._selections = {}     // { llm: { fast: { providerId, modelId }, smart: { ... } }, stt: { ... } }
  }

  // Register models for a provider. Emits 'models:update'.
  registerModels(providerId, models) {
    if (!Array.isArray(models) || models.length === 0) return
    const map = new Map()
    for (const m of models) {
      if (m instanceof Model) {
        map.set(m.id, m)
      } else if (m && typeof m === 'object') {
        const model = m.id ? m : null // already a Model-like object
        if (model) map.set(model.id, model instanceof Model ? model : new Model(model))
      }
    }
    this._models.set(providerId, map)
    if (this._bus) {
      this._bus.emit('models:update', {
        providerId,
        models: [...map.values()].map(m => m.toJSON()),
      })
    }
  }

  // Register a single model for a provider.
  registerModel(providerId, model) {
    if (!(model instanceof Model)) return
    if (!this._models.has(providerId)) this._models.set(providerId, new Map())
    this._models.get(providerId).set(model.id, model)
  }

  // Unregister all models for a provider.
  unregisterModels(providerId) {
    this._models.delete(providerId)
  }

  // Get a specific model by provider and model id.
  getModel(providerId, modelId) {
    return this._models.get(providerId)?.get(modelId) || null
  }

  // List all models for a provider, or all models across all providers.
  listModels(providerId) {
    if (providerId) {
      const map = this._models.get(providerId)
      return map ? [...map.values()].sort((a, b) => a.name.localeCompare(b.name)) : []
    }
    const all = []
    for (const map of this._models.values()) {
      all.push(...map.values())
    }
    return all.sort((a, b) => a.name.localeCompare(b.name))
  }

  // Search models by query string (matches id or name, case-insensitive).
  searchModels(query) {
    if (!query) return this.listModels()
    const q = query.toLowerCase()
    return this.listModels().filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    )
  }

  // Set the selected model for a provider/tier combination.
  // tier is 'fast' or 'smart' for LLM, or 'model' for STT.
  setSelectedModel(providerType, providerId, tier, modelId) {
    if (!this._selections[providerType]) this._selections[providerType] = {}
    this._selections[providerType][tier] = { providerId, modelId }
    if (this._bus) {
      this._bus.emit('models:selected', { providerType, providerId, tier, modelId })
    }
  }

  // Get the selected model for a provider/tier.
  getSelectedModel(providerType, tier) {
    return this._selections[providerType]?.[tier] || null
  }

  // Get all selections.
  getSelections() {
    return { ...this._selections }
  }

  // Load selections from settings (backward-compatible migration).
  migrateSelection(settings) {
    if (!settings) return
    // New format: settings.model = { llm: { fast, smart }, stt: { model } }
    if (settings.model && typeof settings.model === 'object') {
      if (settings.model.llm) {
        const llm = settings.model.llm
        if (llm.provider && llm.fast) {
          this.setSelectedModel('llm', llm.provider, 'fast', llm.fast)
        }
        if (llm.provider && llm.smart) {
          this.setSelectedModel('llm', llm.provider, 'smart', llm.smart)
        }
      }
      if (settings.model.stt) {
        const stt = settings.model.stt
        if (stt.provider && stt.model) {
          this.setSelectedModel('stt', stt.provider, 'model', stt.model)
        }
      }
    }
    // Legacy format: settings.models[provider] = { fast, smart }
    if (settings.models && typeof settings.models === 'object' && settings.provider) {
      const m = settings.models[settings.provider]
      if (m && typeof m === 'object') {
        if (m.fast && !this.getSelectedModel('llm', 'fast')) {
          this.setSelectedModel('llm', settings.provider, 'fast', m.fast)
        }
        if (m.smart && !this.getSelectedModel('llm', 'smart')) {
          this.setSelectedModel('llm', settings.provider, 'smart', m.smart)
        }
      }
    }
    // STT model from settings.stt.model
    if (settings.stt && settings.stt.model && settings.stt.provider) {
      if (!this.getSelectedModel('stt', 'model')) {
        this.setSelectedModel('stt', settings.stt.provider, 'model', settings.stt.model)
      }
    }
  }

  // Detect and handle stale models (selected model no longer in discovered list).
  // Returns { stale: [{ providerId, modelId, replacement? }], warnings: string[] }.
  handleStaleModels() {
    const result = { stale: [], warnings: [] }
    for (const [providerType, tiers] of Object.entries(this._selections)) {
      for (const [tier, sel] of Object.entries(tiers)) {
        if (!sel || !sel.providerId || !sel.modelId) continue
        const model = this.getModel(sel.providerId, sel.modelId)
        if (!model) {
          // Model not in discovered list — find a replacement
          const replacement = this._findReplacement(sel.providerId, sel.modelId)
          if (replacement) {
            this.setSelectedModel(providerType, sel.providerId, tier, replacement.id)
            result.stale.push({
              providerId: sel.providerId,
              modelId: sel.modelId,
              replacement: replacement.id,
            })
          } else {
            result.warnings.push(`Model "${sel.modelId}" for ${sel.providerId}/${tier} is no longer available`)
            if (this._bus) {
              this._bus.emit('models:unavailable', {
                providerId: sel.providerId,
                modelId: sel.modelId,
                reason: 'Model no longer available',
              })
            }
          }
        } else if (model.status === HEALTH.DEPRECATED) {
          result.warnings.push(`Model "${sel.modelId}" is deprecated${model.deprecation?.replacement ? ` — use ${model.deprecation.replacement}` : ''}`)
          if (this._bus) {
            this._bus.emit('models:deprecated', {
              providerId: sel.providerId,
              modelId: sel.modelId,
              replacement: model.deprecation?.replacement || null,
            })
          }
        }
      }
    }
    return result
  }

  // Find a replacement model by name similarity or provider defaults.
  _findReplacement(providerId, oldModelId) {
    const models = this.listModels(providerId).filter(m => m.isUsable())
    if (models.length === 0) return null
    // Try exact prefix match (e.g. "gpt-4o" → "gpt-4o-mini")
    const prefix = oldModelId.split('-').slice(0, -1).join('-')
    const prefixMatch = models.find(m => m.id.startsWith(prefix))
    if (prefixMatch) return prefixMatch
    // Fall back to first available model
    return models[0]
  }

  // Test escape hatch: clear all models.
  _reset() {
    this._models.clear()
    this._selections = {}
  }
}

module.exports = { ModelRegistry }
