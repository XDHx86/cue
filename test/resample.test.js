// Unit tests for src/resample.js — Int16 linear interpolation resampler.
// Pure Node, no electron import. Run: node --test test/resample.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resampleToInt16 } = require('../src/resample');

describe('resampleToInt16', () => {
  it('passthrough — same rate returns identical buffer', () => {
    const input = new Int16Array([100, -200, 300, -400]);
    const out = resampleToInt16(input, 16000, 16000);
    assert.deepEqual(out, input);
    // Should return the same reference (no copy)
    assert.equal(out, input);
  });

  it('passthrough — accepts Buffer input', () => {
    const arr = new Int16Array([100, -200]);
    const buf = Buffer.from(arr.buffer);
    const out = resampleToInt16(buf, 16000, 16000);
    assert.deepEqual(out, arr);
  });

  it('passthrough — accepts ArrayBuffer input', () => {
    const arr = new Int16Array([100, -200]);
    const out = resampleToInt16(arr.buffer, 16000, 16000);
    assert.deepEqual(out, arr);
  });

  it('empty buffer returns empty', () => {
    const input = new Int16Array(0);
    const out = resampleToInt16(input, 44100, 16000);
    assert.equal(out.length, 0);
  });

  it('single sample returns single sample', () => {
    const input = new Int16Array([1000]);
    const out = resampleToInt16(input, 44100, 16000);
    assert.equal(out.length, 1);
    assert.equal(out[0], 1000);
  });

  it('downsample 44100→16000 — correct output length', () => {
    // 44100 samples at 44100Hz = 1 second of audio
    // 1 second at 16000Hz = 16000 samples
    const input = new Int16Array(44100).fill(1000);
    const out = resampleToInt16(input, 44100, 16000);
    // Should be approximately 16000 samples (within rounding)
    assert.ok(Math.abs(out.length - 16000) <= 1,
      `Expected ~16000 samples, got ${out.length}`);
  });

  it('downsample 44100→16000 — amplitude preserved', () => {
    // Constant signal should remain constant after resampling
    const input = new Int16Array(44100).fill(2000);
    const out = resampleToInt16(input, 44100, 16000);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i], 2000, `Sample ${i} should be 2000, got ${out[i]}`);
    }
  });

  it('downsample 48000→16000 — correct output length', () => {
    const input = new Int16Array(48000).fill(500);
    const out = resampleToInt16(input, 48000, 16000);
    assert.ok(Math.abs(out.length - 16000) <= 1,
      `Expected ~16000 samples, got ${out.length}`);
  });

  it('upsample 8000→16000 — doubles sample count', () => {
    const input = new Int16Array([100, 200, 300, 400]);
    const out = resampleToInt16(input, 8000, 16000);
    assert.ok(Math.abs(out.length - 8) <= 1,
      `Expected ~8 samples, got ${out.length}`);
    // First sample should match
    assert.equal(out[0], 100);
  });

  it('interpolates between samples', () => {
    // Non-integer ratio (1.5:1) lands on fractional positions — tests linear interpolation.
    // input = [0,100,200,300,400,500] at 6kHz → 4kHz (ratio 1.5) → 4 output samples
    // sampled at srcPos 0, 1.5, 3, 4.5 → [0, 150, 300, 450]
    const input = new Int16Array([0, 100, 200, 300, 400, 500]);
    const out = resampleToInt16(input, 6000, 4000);
    assert.equal(out.length, 4);
    assert.equal(out[0], 0);
    assert.ok(Math.abs(out[1] - 150) <= 1, `Expected ~150, got ${out[1]}`);  // midpoint
    assert.equal(out[2], 300);
    assert.ok(Math.abs(out[3] - 450) <= 1, `Expected ~450, got ${out[3]}`);  // midpoint
  });

  it('clamps to Int16 range', () => {
    const input = new Int16Array([32767, -32768]);
    const out = resampleToInt16(input, 16000, 16000);
    assert.equal(out[0], 32767);
    assert.equal(out[1], -32768);
  });
});
