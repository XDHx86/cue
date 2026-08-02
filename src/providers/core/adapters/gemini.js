// Gemini adapter — normalizes Google Gemini API model responses.
// Gemini /v1/models returns: { name: 'models/gemini-2.5-flash', displayName, supportedGenerationMethods }.
// The name field is 'models/<model-id>'; strip the 'models/' prefix for the model id.

const { inferCapabilities, mergeCapabilities } = require('./base')

function normalizeModel(raw, providerId = 'gemini', providerType = 'llm') {
  // Gemini returns name as 'models/<id>'
  const rawName = String(raw.name || '')
  const id = rawName.startsWith('models/') ? rawName.slice(7) : rawName
  if (!id) return null
  const caps = inferCapabilities(id, providerId)
  // Gemini supports vision broadly
  if (id.includes('gemini')) {
    mergeCapabilities(caps, {
      vision: { state: 'supported', source: 'known', confidence: 0.9 },
      streaming: { state: 'supported', source: 'known', confidence: 0.9 },
    })
  }
  return {
    id,
    name: raw.displayName || raw.display_name || id,
    capabilities: caps,
    contextWindow: raw.context_window || raw.contextWindow || 1000000, // Gemini default 1M
    maxOutputTokens: raw.max_output_tokens || raw.maxOutputTokens || 8192,
    pricing: raw.pricing || null,
  }
}

function normalizeModels(rawList, providerId = 'gemini', providerType = 'llm') {
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
