// Anthropic adapter — normalizes Anthropic API model responses.
// Anthropic /v1/models returns: { id, type, display_name, created_at }.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'anthropic', providerType = 'llm') {
  const id = String(raw.id || '')
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // Claude 3/3.5/4 models support vision and streaming
  if (id.includes('claude')) {
    mergeCapabilities(caps, {
      vision: { state: 'supported', source: 'known', confidence: 0.9 },
      streaming: { state: 'supported', source: 'known', confidence: 0.95 },
    })
  }
  return {
    id,
    name: raw.display_name || raw.displayName || id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || 200000, // Claude default 200k
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || 4096,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'anthropic', providerType = 'llm') {
  if (!Array.isArray(rawList)) return []
  return rawList.map(m => normalizeModel(m, providerId, providerType)).filter(Boolean)
}

function providerCapabilities() {
  return {
    streaming: { state: 'supported', source: 'known', confidence: 1 },
    vision: { state: 'supported', source: 'known', confidence: 1 },
  }
}

module.exports = { normalizeModel, normalizeModels, providerCapabilities }
