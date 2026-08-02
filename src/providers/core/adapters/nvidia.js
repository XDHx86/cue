// Nvidia adapter — normalizes Nvidia integrate API model responses.
// Nvidia integrate API is OpenAI-compatible: /v1/models returns OpenAI-shaped { id, object, created }.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'nvidia', providerType = 'llm') {
  const id = String(raw.id || '')
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // Nvidia-hosted models are mostly Llama vision-instruct checkpoints
  if (id.includes('vision')) {
    mergeCapabilities(caps, { vision: { state: 'supported', source: 'known', confidence: 0.95 } })
  }
  if (id.includes('instruct')) {
    mergeCapabilities(caps, { streaming: { state: 'supported', source: 'known', confidence: 0.9 } })
  }
  return {
    id,
    name: raw.displayName || raw.display_name || id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || 128000,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'nvidia', providerType = 'llm') {
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
