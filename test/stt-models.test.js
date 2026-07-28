const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  STT_MODEL_SIZES, STT_MODEL_ORG, hfCacheDirName, hfCacheDir, scanCachedModels,
} = require('../src/stt-models');

// The candidate list is PAIRED with python/cue_stt_service.py:MODELS — one source
// of truth for what the Settings panel and CLI offer. This guards drift: if either
// list changes without the other, a model would appear (or vanish) only on one side.
test('STT_MODEL_SIZES matches python/cue_stt_service.py MODELS (paired source of truth)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'python', 'cue_stt_service.py'), 'utf8');
  const m = /MODELS\s*=\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'MODELS list found in the Python service');
  const py = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(py, STT_MODEL_SIZES, 'Node candidate list drifted from the Python service');
});

test('hfCacheDirName / hfCacheDir use the HuggingFace hub layout under the org', () => {
  assert.equal(STT_MODEL_ORG, 'Systran');
  assert.equal(hfCacheDirName('small'), 'models--Systran--faster-whisper-small');
  assert.equal(
    hfCacheDir('/data/stt-models', 'base'),
    path.join('/data/stt-models', 'models--Systran--faster-whisper-base')
  );
});

test('scanCachedModels flags only present cache dirs (pure, fake fs)', () => {
  const dirs = new Set([
    path.join('/m', 'models--Systran--faster-whisper-tiny'),
    path.join('/m', 'models--Systran--faster-whisper-large-v3'),
  ]);
  const fakeFs = { existsSync: (p) => dirs.has(p) };
  const rows = scanCachedModels('/m', fakeFs);
  assert.equal(rows.length, STT_MODEL_SIZES.length);
  const map = Object.fromEntries(rows.map((r) => [r.name, r.cached]));
  assert.equal(map.tiny, true);
  assert.equal(map['large-v3'], true);
  assert.equal(map.base, false);
  assert.equal(map['medium-large-v3'], false);
});

test('scanCachedModels is defensive against a null/fs-less arg (cached=false for all)', () => {
  const rows = scanCachedModels('/m', null);
  assert.equal(rows.length, STT_MODEL_SIZES.length);
  assert.ok(rows.every((r) => r.cached === false));
});

test('every candidate size round-trips through scanCachedModels with a stable name', () => {
  // No existence check from the HF layout surprises — names come back unchanged, in order.
  const rows = scanCachedModels('/m', { existsSync: () => false });
  assert.deepEqual(rows.map((r) => r.name), STT_MODEL_SIZES);
});
