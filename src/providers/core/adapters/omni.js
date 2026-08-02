// OmniRoute adapter — normalizes OmniRoute AI gateway model responses.
// OmniRoute is OpenAI-compatible: /v1/models returns OpenAI-shaped { id, object, created }.
// The gateway routes to 290+ providers; models are prefixed like 'openai/gpt-4o'.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'omni', providerType = 'llm') {
  const id = String(raw.id || '')
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // OmniRoute models run via the local gateway
  mergeCapabilities(caps, { local: { state: 'supported', source: 'known', confidence: 0.9 } })
  // Infer upstream provider capabilities from the model id prefix
  if (id.startsWith('anthropic/')) {
    mergeCapabilities(caps, { vision: { state: 'supported', source: 'inferred', confidence: 0.8 } })
  }
  if (id.startsWith('openai/') || id.startsWith('google/')) {
    mergeCapabilities(caps, { vision: { state: 'supported', source: 'inferred', confidence: 0.8 } })
  }
  return {
    id,
    name: raw.displayName || raw.display_name || id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || null,
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || null,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'omni', providerType = 'llm') {
  if (!Array.isArray(rawList)) return []
  return rawList.map(m => normalizeModel(m, providerId, providerType)).filter(Boolean)
}

function providerCapabilities() {
  return {
    streaming: { state: 'supported', source: 'known', confidence: 1 },
    local: { state: 'supported', source: 'known', confidence: 0.9 },
  }
}

module.exports = { normalizeModel, normalizeModels, providerCapabilities }
