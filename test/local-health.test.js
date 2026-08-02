const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const { httpGet, checkAll, isReady, startPeriodicCheck, stopPeriodicCheck, _resetCache } = require('../src/providers/local-health');

test.afterEach(() => { _resetCache(); });

// --- httpGet ---

test('httpGet resolves true for a 200 response', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await httpGet(`http://127.0.0.1:${port}/test`, 2000);
    assert.equal(ok, true);
  } finally { server.close(); }
});

test('httpGet resolves false for a 500 response', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(500); res.end('err'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await httpGet(`http://127.0.0.1:${port}/test`, 2000);
    assert.equal(ok, false);
  } finally { server.close(); }
});

test('httpGet resolves false for a connection error', async () => {
  const ok = await httpGet('http://127.0.0.1:1', 1000);
  assert.equal(ok, false);
});

test('httpGet resolves false for a timeout', async () => {
  // Server that never responds
  const server = http.createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await httpGet(`http://127.0.0.1:${port}/test`, 100);
    assert.equal(ok, false);
  } finally { server.close(); }
});

// --- isReady ---

test('isReady returns false for unknown ids (cold cache)', () => {
  assert.equal(isReady('omni'), false);
  assert.equal(isReady('ollama'), false);
  assert.equal(isReady('faster-whisper'), false);
});

// --- checkAll ---

test('checkAll populates cache with omni status', async () => {
  // Mock server that returns 200 on /models
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await checkAll({ omniroute: { baseURL: `http://127.0.0.1:${port}/v1` } });
    assert.equal(isReady('omni'), true);
  } finally { server.close(); }
});

test('checkAll reports omni not ready when server is down', async () => {
  await checkAll({ omniroute: { baseURL: 'http://127.0.0.1:1/v1' } });
  assert.equal(isReady('omni'), false);
});

test('checkAll populates ollama status', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await checkAll({ ollama: { baseURL: `http://127.0.0.1:${port}/v1` } });
    assert.equal(isReady('ollama'), true);
  } finally { server.close(); }
});

test('checkAll uses localManagerReady for faster-whisper', async () => {
  let fwReady = false;
  await checkAll({}, { localManagerReady: (id) => id === 'faster-whisper' ? fwReady : false });
  assert.equal(isReady('faster-whisper'), false);
  fwReady = true;
  await checkAll({}, { localManagerReady: (id) => id === 'faster-whisper' ? fwReady : false });
  assert.equal(isReady('faster-whisper'), true);
});

// --- periodic check ---

test('startPeriodicCheck re-polls periodically', async () => {
  let callCount = 0;
  const server = http.createServer((_req, res) => { callCount++; res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const settings = { omniroute: { baseURL: `http://127.0.0.1:${port}/v1` } };
  try {
    await checkAll(settings); // initial
    assert.equal(isReady('omni'), true);
    const prevCount = callCount;
    startPeriodicCheck(() => settings, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 150));
    stopPeriodicCheck();
    assert.ok(callCount > prevCount, 'periodic check re-pollled');
  } finally { server.close(); }
});

test('stopPeriodicCheck clears the interval', async () => {
  let callCount = 0;
  const server = http.createServer((_req, res) => { callCount++; res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const settings = { omniroute: { baseURL: `http://127.0.0.1:${port}/v1` } };
  try {
    startPeriodicCheck(() => settings, { intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 100));
    stopPeriodicCheck();
    const countAfterStop = callCount;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(callCount, countAfterStop, 'no more polls after stop');
  } finally { server.close(); }
});
