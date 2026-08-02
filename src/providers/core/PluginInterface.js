// Plugin Interface — defines the contract every provider plugin must satisfy.
//
// Validation happens at registration time so a bad plugin fails loud at load instead
// of silently producing an empty Settings page. The contract is intentionally loose:
// extra keys are preserved so providers can attach renderer hints (placeholder, hint,
// min, max, options…) without the interface having to whitelist them.
//
// The Plugin Interface extends the existing Provider Registry's descriptor shape with
// new fields for discovery, health, and model management. Existing provider descriptors
// that call definePlugin() are backward-compatible with the old defineProvider() shape.

const PROVIDER_TYPES = ['llm', 'stt']
const FIELD_KINDS = ['text', 'secret', 'number', 'select', 'seg', 'boolean']

function assertString(v, who) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`plugin ${who} must be a non-empty string`)
}

// Validate a field schema entry (configurableSettings[i]).
function validateField(f) {
  if (!f || typeof f !== 'object') throw new Error('configurableSettings entries must be objects')
  assertString(f.id, 'field id')
  if (typeof f.label !== 'string') throw new Error(`field "${f.id}" label must be a string`)
  if (!FIELD_KINDS.includes(f.type)) {
    throw new Error(`field "${f.id}" type "${f.type}" is not one of ${FIELD_KINDS.join(', ')}`)
  }
  if ((f.type === 'select' || f.type === 'seg') && !f.options) {
    throw new Error(`field "${f.id}" of type ${f.type} needs an "options" list`)
  }
  // settingsPath is optional but must be a string if present
  if (f.settingsPath != null && typeof f.settingsPath !== 'string') {
    throw new Error(`field "${f.id}" settingsPath must be a string if present`)
  }
  // group is optional but must be a string if present
  if (f.group != null && typeof f.group !== 'string') {
    throw new Error(`field "${f.id}" group must be a string if present`)
  }
}

// Validate a rich capability entry.
// Rich capabilities have { state, source, confidence } shape.
// Legacy boolean capabilities { streaming: true } are auto-coerced.
function normalizeCapability(name, cap) {
  if (cap == null) return null
  // Boolean → rich coercion
  if (typeof cap === 'boolean') {
    return { state: cap ? 'supported' : 'unsupported', source: 'declared', confidence: 1.0 }
  }
  // Already rich
  if (typeof cap === 'object' && typeof cap.state === 'string') {
    return cap
  }
  // Unknown shape — wrap as unknown
  return { state: 'unknown', source: 'declared', confidence: 0.5 }
}

// Normalize all capabilities in a descriptor to the rich schema.
function normalizeCapabilities(caps) {
  if (!caps || typeof caps !== 'object') return {}
  const out = {}
  for (const [name, cap] of Object.entries(caps)) {
    const normalized = normalizeCapability(name, cap)
    if (normalized) out[name] = normalized
  }
  return out
}

// Validate the full plugin descriptor envelope. Throws on a malformed plugin.
function validatePlugin(desc) {
  if (!desc || typeof desc !== 'object') throw new Error('plugin descriptor must be an object')
  if (!PROVIDER_TYPES.includes(desc.providerType)) {
    throw new Error(`providerType must be one of ${PROVIDER_TYPES.join(', ')} (got "${desc.providerType}")`)
  }
  assertString(desc.id, 'id')
  assertString(desc.displayName, 'displayName')
  if (typeof desc.createEngine !== 'function') {
    throw new Error(`plugin "${desc.id}": createEngine must be a function`)
  }
  if (!Array.isArray(desc.configurableSettings)) {
    throw new Error(`plugin "${desc.id}": configurableSettings must be an array`)
  }
  desc.configurableSettings.forEach(validateField)
  if (desc.defaultSettings && typeof desc.defaultSettings !== 'object') {
    throw new Error(`plugin "${desc.id}": defaultSettings must be an object if present`)
  }
  if (desc.capabilities && typeof desc.capabilities !== 'object') {
    throw new Error(`plugin "${desc.id}": capabilities must be an object if present`)
  }
  // Optional fields type checks
  if (desc.supportedModels != null && !Array.isArray(desc.supportedModels) && typeof desc.supportedModels !== 'function') {
    throw new Error(`plugin "${desc.id}": supportedModels must be an array, a function, or null`)
  }
  if (desc.discoverModels != null && typeof desc.discoverModels !== 'function') {
    throw new Error(`plugin "${desc.id}": discoverModels must be a function if present`)
  }
  if (desc.normalizeModels != null && typeof desc.normalizeModels !== 'function') {
    throw new Error(`plugin "${desc.id}": normalizeModels must be a function if present`)
  }
  if (desc.healthCheck != null && typeof desc.healthCheck !== 'function') {
    throw new Error(`plugin "${desc.id}": healthCheck must be a function if present`)
  }
  if (desc.healthConfig != null && typeof desc.healthConfig !== 'object') {
    throw new Error(`plugin "${desc.id}": healthConfig must be an object if present`)
  }
  if (desc.validateConfig != null && typeof desc.validateConfig !== 'function') {
    throw new Error(`plugin "${desc.id}": validateConfig must be a function if present`)
  }
  if (desc.modelSettingsPath != null && desc.modelSettingsPath !== null && typeof desc.modelSettingsPath !== 'string') {
    throw new Error(`plugin "${desc.id}": modelSettingsPath must be a string, null, or absent`)
  }
  if (desc.createStreamSession != null && typeof desc.createStreamSession !== 'function') {
    throw new Error(`plugin "${desc.id}": createStreamSession must be a function if present`)
  }
}

// Coerce order to a finite number (default 0).
function coerceOrder(o) {
  const n = Number(o)
  return Number.isFinite(n) ? n : 0
}

module.exports = {
  PROVIDER_TYPES, FIELD_KINDS,
  validatePlugin, validateField, coerceOrder,
  normalizeCapability, normalizeCapabilities,
}
