// LLM factory — delegates to the provider registry (src/registry.js, populated by
// src/registry-loader.js from src/providers/llm/<id>/index.js). Each provider descriptor owns its
// own createEngine, which returns { provider, model, apiKey, ready, stream(params) }.
//
// R1c removed the per-provider if/else switch that lived here (streamOpenAI/streamAnthropic/
// streamGemini + the nvidia/ollama OpenAI-clone branches). Those streaming implementations moved
// verbatim into the provider folders:
//   - openai / nvidia / ollama → src/providers/llm/openai-compat.js (one shared OpenAI-compatible
//     path, diverging only by baseURL + apiKey sentinel)
//   - anthropic                → src/providers/llm/anthropic/index.js (messages.create stream loop)
//   - gemini                   → src/providers/llm/gemini/index.js (generateContentStream)
// stripDataUrl + the lazy child('llm') logger guard moved to src/providers/llm/shared.js (kept
// BELOW src/llm.js in the require graph so providers never pull this module and close a cycle).
//
// createLLM stays the single entry main.js (and the summary/memory seams) call. It resolves the
// descriptor for settings.provider and asks it for an engine; an unknown provider yields a
// not-ready engine so main.js surfaces the usual "add your key" prompt instead of throwing.

const { getProvider } = require('./registry');

function createLLM(settings) {
  const desc = getProvider('llm', settings.provider);
  if (!desc) {
    // No registered descriptor for this provider id. With the shipped providers loaded this is
    // unreachable, but a corrupt/missing providers tree must degrade to "not ready" rather than
    // crash the runFeature/summary path — main.js checks llm.ready and shows the key prompt.
    return {
      provider: settings.provider,
      model: null,
      apiKey: null,
      ready: false,
      stream() { throw new Error('unknown provider: ' + settings.provider); },
    };
  }
  return desc.createEngine({ settings });
}

module.exports = { createLLM };
