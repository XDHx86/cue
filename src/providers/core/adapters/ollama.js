// Ollama adapter — normalizes Ollama API model responses.
// Ollama /api/tags returns: { name: 'llama3.2', model: 'llama3.2', size, digest, details }.
// The `name` field is the model id. All Ollama models are local.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'ollama', providerType = 'llm') {
  const id = String(raw.name || raw.model || '')
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // All Ollama models run locally
  mergeCapabilities(caps, { local: { state: 'supported', source: 'known', confidence: 1 } })
  return {
    id,
    name: id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || null,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: null, // local models have no per-token cost
  }
}

function normalizeModels(rawList, providerId = 'ollama', providerType = 'llm') {
  if (!Array.isArray(rawList)) return []
  return rawList.map(m => normalizeModel(m, providerId, providerType)).filter(Boolean)
}

function providerCapabilities() {
  return {
    streaming: { state: 'supported', source: 'known', confidence: 1 },
    local: { state: 'supported', source: 'known', confidence: 1 },
  }
}

module.exports = { normalizeModel, normalizeModels, providerCapabilities }
