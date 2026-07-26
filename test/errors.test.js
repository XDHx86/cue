const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSDKError, userMessage, NETWORK_CODES } = require('../src/errors');

test('normalizeSDKError preserves the provider name', () => {
  assert.equal(normalizeSDKError({ status: 401, message: 'x' }, 'anthropic').provider, 'anthropic');
  assert.equal(normalizeSDKError({ status: 401, message: 'x' }, 'openai').provider, 'openai');
});

test('401 → invalid key suggestion', () => {
  const ne = normalizeSDKError({ status: 401, message: 'Unauthorized' }, 'openai');
  assert.match(ne.suggestion, /re-paste/i);
  assert.match(ne.suggestion, /Settings/i);
  assert.equal(ne.status, 401);
  assert.equal(ne.message, 'Unauthorized');
});

test('403 → lacks access suggestion', () => {
  const ne = normalizeSDKError({ status: 403, message: 'Forbidden' }, 'gemini');
  assert.match(ne.suggestion, /access/i);
});

test('429 → rate limit suggestion', () => {
  const ne = normalizeSDKError({ status: 429, message: 'Too Many Requests' }, 'openai');
  assert.match(ne.suggestion, /rate limit/i);
});

test('5xx → upstream down suggestion', () => {
  const ne = normalizeSDKError({ status: 503, message: 'Service Unavailable' }, 'anthropic');
  assert.match(ne.suggestion, /upstream/i);
});

test('model_not_found code → model name suggestion regardless of status', () => {
  const ne = normalizeSDKError({ status: 404, code: 'model_not_found', message: 'no such model' }, 'nvidia');
  assert.match(ne.suggestion, /model name/i);
});

test('network error code → reachability suggestion with status 0', () => {
  const ne = normalizeSDKError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, 'ollama');
  assert.equal(ne.status, 0);
  assert.match(ne.suggestion, /reach|connection|endpoint/i);
  assert.ok(NETWORK_CODES.has('ECONNREFUSED'));
});

test('extracts status/code from nested SDK envelope shapes', () => {
  // OpenAI SDK throws { status, error: { code, message } }
  const ne = normalizeSDKError({ status: 401, error: { code: 'invalid_api_key', message: 'Incorrect API key' } }, 'openai');
  assert.equal(ne.status, 401);
  assert.equal(ne.code, 'invalid_api_key');
  assert.match(ne.suggestion, /re-paste/i);
});

test('non-object / null errors degrade gracefully to status 0', () => {
  const ne = normalizeSDKError(null, 'openai');
  assert.equal(ne.status, 0);
  assert.equal(ne.provider, 'openai');
  assert.ok(ne.message.length > 0);
  assert.ok(ne.suggestion.length > 0);
});

test('userMessage combines provider + suggestion for a normalized error', () => {
  const ne = normalizeSDKError({ status: 401, message: 'bad key' }, 'openai');
  const msg = userMessage(ne);
  assert.match(msg, /openai/i);
  assert.match(msg, /re-paste/i);
  assert.ok(!/Error:/.test(msg), 'normalized errors do not get the generic "Error:" prefix');
});

test('userMessage falls back to "Error: <message>" for bare throws', () => {
  assert.match(userMessage(new Error('boom')), /^Error: boom$/);
  assert.match(userMessage('a string'), /^Error: a string$/);
});
