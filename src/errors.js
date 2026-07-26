// Normalize SDK (OpenAI / Anthropic / Gemini) and STT errors into one shape so main.js can
// build a user-facing string without special-casing each provider's error envelope.
//
// normalizeSDKError(err, provider) → { status, code, provider, message, suggestion }
//   status:     number HTTP status, or 0 for network/no-status errors
//   code:       provider/SDK code string ('model_not_found', 'ECONNREFUSED', ...) or ''
//   provider:   the name we were called with ('openai' | 'anthropic' | 'gemini' | 'nvidia' | 'ollama' | ...)
//   message:    the underlying error's human message (for diagnostics/logs)
//   suggestion: the one-line user-facing hint ("re-paste your key in Settings", etc.)

function num(v) { return typeof v === 'number' ? v : (v != null && !Number.isNaN(Number(v)) ? Number(v) : undefined); }

function extract(err) {
  if (!err || typeof err !== 'object') return { status: 0, code: '', message: String(err || 'Unknown error') };
  const status = num(err.status) || num(err.statusCode) || 0;
  const code = String(err.code || (err.error && err.error.code) || '');
  const message = String(err.message || (err.error && err.error.message) || String(err));
  // Network-level errors (Node fetch / undici) carry err.code like 'ECONNREFUSED','ENOTFOUND','ETIMEDOUT'.
  return { status, code, message };
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

function suggestionFor({ status, code }) {
  if (status === 401) return 'Invalid API key — re-paste it in Settings (gear icon).';
  if (status === 403) return 'This key lacks access to that model — check provider permissions or pick another provider in Settings.';
  if (status === 429) return 'Rate limit hit — wait a moment, or switch provider in Settings.';
  if (status >= 500) return 'The provider is having trouble (upstream error) — try again shortly or switch provider.';
  if (code === 'model_not_found' || /model_not_found|does not exist|not found/i.test(code)) return 'Model name not recognized — fix the model name in Settings.';
  if (NETWORK_CODES.has(code) || status === 0) return 'Could not reach the provider — check your internet connection or the provider endpoint.';
  return 'Something went wrong with the provider request — try again or check Settings.';
}

function normalizeSDKError(err, provider) {
  const { status, code, message } = extract(err);
  return { status: status || 0, code: code || '', provider: provider || '', message, suggestion: suggestionFor({ status, code }) };
}

// Build the single user-facing string main.js puts on the llm:error bubble from a normalized error.
// Falls back to a bare message if the normalized object is missing (for non-SDK throw sites).
function userMessage(e) {
  if (!e || typeof e !== 'object') return 'Error: ' + String(e || '');
  const parts = [];
  if (e.provider) parts.push(e.provider);
  if (e.suggestion) parts.push(e.suggestion);
  return parts.length ? parts.join(' — ') : ('Error: ' + (e.message || String(e)));
}

module.exports = { normalizeSDKError, userMessage, NETWORK_CODES };
