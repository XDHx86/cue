// Lightweight health-check cache for local services (OmniRoute, Ollama).
//
// `createEngine` returns a synchronous `ready` boolean, so providers cannot do an HTTP
// health check at engine-creation time. This module maintains a cache that is populated
// asynchronously at startup, on settings change, and via a periodic poll. Providers read
// `isReady(id)` synchronously — the cache defaults to false (cold start = not ready until
// the first async check completes).
//
// Uses Node's built-in http/https (no deps, works in the pure-Node test suite).

const http = require('http');
const https = require('https');

const TIMEOUT_MS = 2000;

// Cache: id -> { ready: boolean, ts: number }
const cache = new Map();

let _interval = null;

// GET a URL; resolves true if 2xx, false on error/timeout.
// Pure Node — no fetch, no external deps.
function httpGet(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    let settled = false;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if (settled) return;
      settled = true;
      res.resume(); // drain response body
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => { if (!settled) { settled = true; resolve(false); } });
    req.on('timeout', () => { if (!settled) { settled = true; req.destroy(); resolve(false); } });
  });
}

// Async health check for all known local services. Populates the cache.
// `settings` is the live store settings (reads omniroute.baseURL + ollama.baseURL).
// `localManagerReady` is an optional injected function (defaults to false) so callers
// can inject the stt-managers dependency without creating a cycle.
async function checkAll(settings, { localManagerReady } = {}) {
  const omniURL = ((settings && settings.omniroute && settings.omniroute.baseURL) || 'http://localhost:20128/v1') + '/models';
  const omniOk = await httpGet(omniURL);
  cache.set('omni', { ready: omniOk, ts: Date.now() });

  // Ollama serve (OpenAI-compatible /v1/models)
  const ollamaURL = ((settings && settings.ollama && settings.ollama.baseURL) || 'http://localhost:11434/v1') + '/models';
  const ollamaOk = await httpGet(ollamaURL);
  cache.set('ollama', { ready: ollamaOk, ts: Date.now() });

  // faster-whisper local engine readiness (venv + process alive)
  const fwReady = typeof localManagerReady === 'function' ? !!localManagerReady('faster-whisper') : false;
  cache.set('faster-whisper', { ready: fwReady, ts: Date.now() });
}

// Synchronous read from the cache. Returns false for unknown or never-checked ids.
function isReady(id) {
  const entry = cache.get(id);
  return entry ? entry.ready : false;
}

// Periodically re-check so services started after cue are detected.
// `getSettings` is a thunk (avoids import cycles). Returns a stop function.
function startPeriodicCheck(getSettings, { intervalMs = 15000, localManagerReady } = {}) {
  stopPeriodicCheck();
  _interval = setInterval(() => {
    try { checkAll(getSettings(), { localManagerReady }); } catch { /* best-effort */ }
  }, intervalMs);
  return stopPeriodicCheck;
}

function stopPeriodicCheck() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Test helper: reset the cache (mirrors _resetProviders / _resetLocalManagers).
function _resetCache() {
  cache.clear();
  stopPeriodicCheck();
}

module.exports = {
  httpGet,
  checkAll,
  isReady,
  startPeriodicCheck,
  stopPeriodicCheck,
  _resetCache,
};
