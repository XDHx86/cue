// Groq adapter — normalizes Groq API model responses.
// Groq is OpenAI-compatible: /v1/models returns OpenAI-shaped { id, object, created, owned_by }.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'groq', providerType = 'llm') {
  const id = String(raw.id || '')
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // Groq models are mostly Llama checkpoints — text-focused, no vision
  mergeCapabilities(caps, { streaming: { state: 'supported', source: 'known', confidence: 0.95 } })
  return {
    id,
    name: raw.displayName || raw.display_name || id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || 131072, // Groq default 128k
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'groq', providerType = 'llm') {
  if (!Array.isArray(rawList)) return []
  return rawList.map(m => normalizeModel(m, providerId, providerType)).filter(Boolean)
}

function providerCapabilities() {
  return {
    streaming: { state: 'supported', source: 'known', confidence: 1 },
  }
}

module.exports = { normalizeModel, normalizeModels, providerCapabilities }
