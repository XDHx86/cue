// OpenAI adapter — normalizes OpenAI API model responses to the common Model schema.
// OpenAI /v1/models returns: { id, object, created, owned_by } — no context/pricing.
// Known capability inference supplements the sparse API data.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'openai', providerType = 'llm') {
  const id = String(raw.id || '')
  if (!id) return null
  // OpenAI responses carry owned_by (e.g. 'system', 'openai') and object type
  const caps = inferCapabilities(id, providerId)
  // gpt-4o and 4o-mini support vision; o-series support reasoning
  if (id.includes('4o')) mergeCapabilities(caps, { vision: { state: 'supported', source: 'inferred', confidence: 0.85 } })
  if (id.includes('o1') || id.includes('o3')) {
    mergeCapabilities(caps, { reasoning: { state: 'supported', source: 'inferred', confidence: 0.9 } })
  }
  return {
    id,
    name: id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || null,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'openai', providerType = 'llm') {
  if (!Array.isArray(rawList)) return []
  return rawList.map(m => normalizeModel(m, providerId, providerType)).filter(Boolean)
}

// Provider-level capabilities for OpenAI (used as fallback when model data is sparse)
function providerCapabilities() {
  return {
    streaming: { state: 'supported', source: 'known', confidence: 1 },
    vision: { state: 'supported', source: 'known', confidence: 1 },
  }
}

module.exports = { normalizeModel, normalizeModels, providerCapabilities }
