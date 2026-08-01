// Shared engine factory for the OpenAI-compatible providers: OpenAI itself, Nvidia's
// integrate API (same SDK, fixed baseURL), and Ollama (same SDK, the local /v1 endpoint).
// They share one streaming path — chat.completions.create with stream:true, message shape, and
// image_url attachment — diverging only in baseURL and the apiKey used to satisfy the SDK
// constructor. Factored here so each provider folder is a thin descriptor + a one-line engine.
//
// This is a verbatim port of the pre-refactor streamOpenAI (src/llm.js), preserving the exact
// request shape, the maxTokens=4096 pin (Anthropic needs it; harmless here), and the per-provider
// ready logic: ollama is ready with just a model (the 'ollama' sentinel satisfies the SDK
// constructor but never gates readiness); every other OpenAI-compatible needs apiKey + model.

const { log } = require('./shared');
const { normalizeSDKError } = require('../../errors');

// Provider-id → log label suffix (one-line, tests never assert these strings; distinct labels
// make nvidia/ollama streams distinguishable in logs without changing any behavior).
function label(id) {
  if (id === 'openai') return 'streamOpenAI';
  if (id === 'nvidia') return 'streamNvidia';
  if (id === 'ollama') return 'streamOllama';
  return 'stream' + id;
}

// Build an OpenAI-compatible engine from { id, settings, baseURL, apiKey }.
//   id      provider id (also the apiKeys/models key)
//   baseURL passed straight to the SDK constructor (undefined → SDK default, i.e. plain OpenAI)
//   apiKey  the key the SDK constructor demands (the 'ollama' sentinel for ollama; the real key
//           otherwise)
function makeOpenAICompatEngine({ id, settings, baseURL, apiKey }) {
  const model = ((settings.models || {})[id] || {})[settings.smart ? 'smart' : 'fast'];
  const ready = id === 'ollama' ? !!model : (!!apiKey && !!model);
  const maxTokens = (settings.llm && settings.llm.maxTokens) || 4096;
  return {
    provider: id,
    model,
    apiKey,
    ready,
    async stream({ system, turns, imageDataUrl, onToken }) {
      const l = label(id);
      log().debug({ model, baseURL, hasImage: !!imageDataUrl, maxTokens }, l + ' called');
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey, baseURL });
      const messages = [{ role: 'system', content: system }];
      turns.forEach((t, i) => {
        const last = i === turns.length - 1;
        if (last && imageDataUrl && t.role === 'user') {
          messages.push({ role: 'user', content: [
            { type: 'text', text: t.text },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ] });
        } else {
          messages.push({ role: t.role, content: t.text });
        }
      });
      log().debug({ model, messages: messages.length }, l + ' sending request');
      try {
        const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
        let full = '';
        for await (const part of stream) {
          const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
          if (d) { full += d; onToken(d); }
        }
        log().debug({ chars: full.length }, l + ' finished');
        return full;
      } catch (err) {
        log().warn({ error: err && err.message }, l + ' error');
        throw normalizeSDKError(err, id);
      }
    },
  };
}

module.exports = { makeOpenAICompatEngine };
