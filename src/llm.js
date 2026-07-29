// LLM factory — OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText
//
// Structured logging via the app Pino singleton (src/logger.js, ADR-014). Lazily resolved + guarded:
// outside the app process (pure-Node tests, no Electron) getLogger() can't resolve app.getPath, so
// a build failure falls back to noopLogger — tests never spawn a Pino transport and never need
// Electron. Inside the app, main.js has already built the root with persisted settings, so child('llm')
// just derives a module-scoped child. Traces are debug-level (silent at the default info level, the
// equivalent of the old `DEBUG = false`).

const { child, noopLogger, getLogger } = require('./logger');
const { normalizeSDKError } = require('./errors');

let _log = null;
function log() {
  if (_log) return _log;
  try { _log = (getLogger() && child('llm')) || noopLogger; }
  catch { _log = noopLogger; }
  return _log;
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, provider, system, turns, imageDataUrl, maxTokens, onToken, baseURL }) {
  log().debug({ model, baseURL, hasImage: !!imageDataUrl, maxTokens }, 'streamOpenAI called');
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
  log().debug({ model, messages: messages.length }, 'streamOpenAI sending request');
  try {
    const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
    let full = '';
    for await (const part of stream) {
      const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
      if (d) { full += d; onToken(d); }
    }
    log().debug({ chars: full.length }, 'streamOpenAI finished');
    return full;
  } catch (err) {
    log().warn({ error: err && err.message }, 'streamOpenAI error');
    throw normalizeSDKError(err, provider || 'openai');
  }
}

async function streamAnthropic({ apiKey, model, provider, system, turns, imageDataUrl, maxTokens, onToken }) {
  log().debug({ model, hasImage: !!imageDataUrl, maxTokens }, 'streamAnthropic called');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  log().debug({ model, messages: messages.length }, 'streamAnthropic sending request');
  try {
    const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
    let full = '';
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    }
    log().debug({ chars: full.length }, 'streamAnthropic finished');
    return full;
  } catch (err) {
    log().warn({ error: err && err.message }, 'streamAnthropic error');
    throw normalizeSDKError(err, provider || 'anthropic');
  }
}

async function streamGemini({ apiKey, model, provider, system, turns, imageDataUrl, maxTokens, onToken }) {
  log().debug({ model, hasImage: !!imageDataUrl, maxTokens }, 'streamGemini called');
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  log().debug({ model, contents: contents.length }, 'streamGemini sending request');
  try {
    const stream = await ai.models.generateContentStream({
      model, contents, config: { systemInstruction: system }
    });
    let full = '';
    let lastFinishReason = 'UNKNOWN';
    for await (const chunk of stream) {
      const t = chunk && chunk.text;
      if (t) { full += t; onToken(t); }
      if (chunk && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason) {
        lastFinishReason = chunk.candidates[0].finishReason;
      }
    }
    log().debug({ chars: full.length, finishReason: lastFinishReason }, 'streamGemini finished');
    return full;
  } catch (err) {
    log().warn({ error: err && err.message }, 'streamGemini error');
    throw normalizeSDKError(err, provider || 'gemini');
  }
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  const model = (settings.models[provider] || {})[tier];

  // Set to 4096 (effectively unlimited for a single response)
  // since some SDKs like Anthropic require a maxTokens value.
  const maxTokens = 4096;

  const ready = provider === 'ollama' ? !!model : (!!apiKey && !!model);
  log().debug({ provider, model, ready }, 'createLLM initialized');

  return {
    provider, model, apiKey,
    // Ollama has no real key — the 'ollama' sentinel satisfies the OpenAI SDK constructor but
    // should not gate readiness. Ollama is ready as long as a model is configured.
    ready,
    async stream(params) {
      log().debug({ provider }, 'stream() invoked');
      const args = { apiKey, model, provider, maxTokens, ...params };
      if (provider === 'openai') return streamOpenAI(args);
      if (provider === 'nvidia') return streamOpenAI({ ...args, baseURL: 'https://integrate.api.nvidia.com/v1' });
      // Ollama reuses the OpenAI SDK against ollama serve's OpenAI-compatible /v1 endpoint.
      // apiKey is the 'ollama' sentinel (Ollama ignores it; the SDK constructor needs non-empty).
      if (provider === 'ollama') return streamOpenAI({
        ...args,
        apiKey: 'ollama',
        baseURL: (settings.ollama && settings.ollama.baseURL) || 'http://localhost:11434/v1'
      });
      if (provider === 'anthropic') return streamAnthropic(args);
      if (provider === 'gemini') return streamGemini(args);
      throw new Error('unknown provider: ' + provider);
    }
  };
}

module.exports = { createLLM };
