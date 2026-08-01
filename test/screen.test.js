const assert = require('node:assert/strict');
const test = require('node:test');
const { scaleToMaxEdge, cacheFresh, clearCache, MAX_EDGE, JPEG_QUALITY, CACHE_TTL_MS } = require('../src/screen');

// captureScreenshot() is Electron-coupled (desktopCapturer/screen) and verified by the manual
// pipeline-smoke step per the plan; the dimension + cache logic it depends on is pure and tested
// here. screen.js requires 'electron' at module load but only CALLS it inside captureScreenshot,
// so the pure helpers load fine under plain `node --test`.

// aspect-ratio comparison tolerant of integer rounding after the downscale
function approxEq(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 0.02, `${msg}: ${actual} ≈ ${expected}`);
}

// ---- scaleToMaxEdge: the ≤1568 longest-edge invariant ----

test('landscape image downscaled so the longest edge is exactly MAX_EDGE, aspect preserved', () => {
  const out = scaleToMaxEdge(3840, 2160, MAX_EDGE); // 4K UHD → 1568×882
  assert.equal(out.width, MAX_EDGE, 'longest edge capped to MAX_EDGE');
  assert.ok(out.height < MAX_EDGE && out.height > 0);
  approxEq(out.width / out.height, 3840 / 2160, 'aspect ratio preserved');
});

test('portrait image downscaled so the HEIGHT (longest edge) is MAX_EDGE', () => {
  const out = scaleToMaxEdge(1440, 2880, MAX_EDGE); // tall phone screenshot
  assert.equal(out.height, MAX_EDGE, 'longest (height) edge capped');
  assert.ok(out.width < MAX_EDGE && out.width > 0);
  approxEq(out.width / out.height, 1440 / 2880, 'aspect ratio preserved');
});

test('an image already within the cap is returned unchanged (no upscale)', () => {
  // longest edge 1000 < 1568 → no resize, dims pass through
  assert.deepEqual(scaleToMaxEdge(1000, 600, MAX_EDGE), { width: 1000, height: 600 });
  // exactly MAX_EDGE on the longest side → no resize
  assert.deepEqual(scaleToMaxEdge(MAX_EDGE, 800, MAX_EDGE), { width: MAX_EDGE, height: 800 });
  assert.deepEqual(scaleToMaxEdge(800, MAX_EDGE, MAX_EDGE), { width: 800, height: MAX_EDGE });
});

test('zero or missing dims pass through untouched (no NaN, no Infinity)', () => {
  assert.deepEqual(scaleToMaxEdge(0, 0, MAX_EDGE), { width: 0, height: 0 });
  assert.deepEqual(scaleToMaxEdge(0, 1080, MAX_EDGE), { width: 0, height: 1080 });
  assert.deepEqual(scaleToMaxEdge(1920, 0, MAX_EDGE), { width: 1920, height: 0 });
  assert.deepEqual(scaleToMaxEdge(NaN, NaN, MAX_EDGE), { width: NaN, height: NaN }, 'NaN dims: !w falsy → passthrough');
});

test('scaleToMaxEdge respects a custom maxEdge, not just the module constant', () => {
  assert.deepEqual(scaleToMaxEdge(4000, 2000, 2000), { width: 2000, height: 1000 });
  assert.deepEqual(scaleToMaxEdge(4000, 2000, 1000), { width: 1000, height: 500 });
});

test('MAX_EDGE / JPEG_QUALITY / CACHE_TTL_MS match the plan (1568 / 85 / 1500)', () => {
  // JPEG_QUALITY is Electron nativeImage.toJPEG's integer quality factor (0–100),
  // not a 0–1 ratio — 85 is "visually clean for screen text at KB, not MB" (src/screen.js).
  assert.equal(MAX_EDGE, 1568);
  assert.equal(JPEG_QUALITY, 85);
  assert.equal(CACHE_TTL_MS, 1500);
});

// ---- cacheFresh: the 1.5 s reuse window ----

test('true within the TTL window and false at/after it', () => {
  const at = 10000;
  assert.equal(cacheFresh(10000, at, 1500), true, 'same instant: within');
  assert.equal(cacheFresh(11499, at, 1500), true, '1.499s later: within');
  assert.equal(cacheFresh(11500, at, 1500), false, 'exactly TTL: not within (strict <)');
});

test('rejects a missing or non-numeric cachedAt', () => {
  assert.equal(cacheFresh(10000, null, 1500), false, 'null cachedAt: no cache');
  assert.equal(cacheFresh(10000, undefined, 1500), false, 'undefined cachedAt: no cache');
  assert.equal(cacheFresh(10000, NaN, 1500), false, 'NaN cachedAt: not fresh');
});

test('guards non-numeric now / ttlMs', () => {
  assert.equal(cacheFresh(NaN, 10000, 1500), false);
  assert.equal(cacheFresh(10000, 10000, NaN), false);
});

// ---- clearCache is a safe no-op callable (the exported surface is complete) ----

test('clearCache is callable and does not throw', () => {
  assert.equal(typeof clearCache, 'function');
  assert.doesNotThrow(() => clearCache());
});
