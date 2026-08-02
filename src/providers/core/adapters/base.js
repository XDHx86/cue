// Base adapter utilities — shared functions for provider-specific normalization adapters.
//
// These helpers are used by the per-provider adapters in adapters/*.js to convert
// provider-specific API responses into the common Model schema. They provide:
//   - Pattern-based capability inference from model IDs
//   - Context window parsing from text/numbers
//   - Deep capability merging with precedence

const { HEALTH } = require('../Model')

// Pattern-based capability inference from model ID and provider ID.
// Returns a rich capabilities object with { state, source, confidence } entries.
function inferCapabilities(modelId, providerId = '') {
  const id = String(modelId).toLowerCase()
  const caps = {}

  // Streaming: almost all modern models support it
  caps.streaming = { state: 'supported', source: 'inferred', confidence: 0.9 }

  // Vision: check for vision-related keywords
  if (id.includes('vision') || id.includes('4o') || id.includes('gemini') ||
      id.includes('claude-3') || id.includes('gpt-4')) {
    caps.vision = { state: 'supported', source: 'inferred', confidence: 0.8 }
  }

  // Reasoning: o1, o3, deepseek-r1, etc.
  if (id.includes('o1') || id.includes('o3') || id.includes('reasoning') ||
      id.includes('deepseek-r1') || id.includes('thinking')) {
    caps.reasoning = { state: 'supported', source: 'inferred', confidence: 0.9 }
  }

  // Local: known local provider patterns
  if (providerId === 'ollama' || providerId === 'omni' ||
      id.includes('gguf') || id.includes('local')) {
    caps.local = { state: 'supported', source: 'inferred', confidence: 0.95 }
  }

  return caps
}

// Parse a context window from various input formats (number, string like "128k", etc.)
function parseContextWindow(value) {
  if (value == null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const str = String(value).toLowerCase().trim()
  // "128k" → 128000, "1m" → 1000000, etc.
  const m = str.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/)
  if (m) {
    const num = parseFloat(m[1])
    const suffix = m[2]
    if (suffix === 'k') return Math.round(num * 1000)
    if (suffix === 'm') return Math.round(num * 1000000)
    if (suffix === 'b') return Math.round(num * 1000000000)
    return Math.round(num)
  }
  return null
}

// Deep merge two capability objects. Override values take precedence.
// Both inputs use the rich { state, source, confidence } shape.
function mergeCapabilities(base = {}, override = {}) {
  const out = { ...base }
  for (const [name, cap] of Object.entries(override)) {
    if (cap == null) continue
    const existing = out[name]
    if (existing && typeof existing === 'object' && typeof cap === 'object') {
      out[name] = { ...existing, ...cap }
    } else {
      out[name] = cap
    }
  }
  return out
}

// Build a Model fields object from common API response shapes.
// Adapters call this and then add provider-specific fields.
function buildModelFields({
  id, name, providerId, providerType,
  contextWindow, maxOutputTokens, pricing,
  capabilities, status, deprecation,
}) {
  return {
    id: String(id || ''),
    name: String(name || id || ''),
    capabilities: capabilities || inferCapabilities(id, providerId),
    contextWindow: parseContextWindow(contextWindow),
    maxOutputTokens: maxOutputTokens || null,
    pricing: pricing || null,
    status: status || HEALTH.AVAILABLE,
    deprecation: deprecation || null,
  }
}

module.exports = {
  inferCapabilities, parseContextWindow, mergeCapabilities, buildModelFields,
}
