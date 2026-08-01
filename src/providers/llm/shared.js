// Shared helpers for LLM provider descriptors. These live HERE, under src/providers/llm/,
// rather than in src/llm.js, deliberately: src/llm.js (after R1c) requires the registry, and the
// registry's loader requires these provider folders — so pulling src/llm.js into a provider
// module would close a load-time cycle. Keeping stripDataUrl + the lazy logger BELOW src/llm.js
// in the dependency graph (providers → shared → logger/errors, never providers → llm) avoids it.
//
// Tests: pure-Node and electron-free. The lazy logger guard never builds a Pino root outside the
// app (getLogger() can't resolve app.getPath in tests → throws → caught → noopLogger), and the
// provider modules never require a network SDK at load (only inside createEngine), so loading the
// LLM provider tree in a test registers descriptors with no transports spawned and no SDKs pulled.

const { child, noopLogger, getLogger } = require('../../logger');

// Module-scoped logger for the LLM subsystem — lazily resolved + guarded, the exact pattern the
// pre-refactor src/llm.js used. child('llm') is only built once the app's root logger exists
// (main.js builds it from persisted settings at startup); elsewhere we fall back to noopLogger so
// a build never spawns a Pino worker transport and never needs Electron.
let _log = null;
function log() {
  if (_log) return _log;
  try { _log = (getLogger() && child('llm')) || noopLogger; }
  catch { _log = noopLogger; }
  return _log;
}

// Split a `data:<mime>;base64,<b64>` URL into { mime, b64 } for the providers whose SDKs take
// raw base64 + an explicit media type (Anthropic source.base64, Gemini inlineData). The OpenAI-
// compatible path passes the full data URL through as image_url, so it does not call this.
function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

module.exports = { log, stripDataUrl };
