// Int16 linear interpolation resampler. No dependencies.
//
// Used as a safety net when AudioContext({sampleRate:16000}) falls back to 44100/48000Hz
// on some platforms. All STT sessions assume 16kHz PCM — this ensures the sample rate
// matches regardless of the AudioContext's actual output rate.
//
// Dual-format: works in both browser (renderer, loaded via <script>, exposes global
// `resampleToInt16`) and Node.js (main/tests, via module.exports). Pure math, no APIs.

/**
 * Resample an Int16 PCM buffer from one sample rate to another using linear interpolation.
 * @param {Int16Array|ArrayBuffer|Buffer} input - Input PCM samples. Accepts Int16Array
 *   (each element is one sample), or raw ArrayBuffer/Buffer (2 bytes per sample, LE).
 * @param {number} fromRate - Source sample rate in Hz (e.g. 44100)
 * @param {number} toRate - Target sample rate in Hz (e.g. 16000)
 * @returns {Int16Array} Resampled buffer at the target rate
 */
function resampleToInt16(input, fromRate, toRate) {
  // Normalize to Int16Array view for uniform sample access
  let samples;
  if (input instanceof Int16Array) {
    samples = input;
  } else {
    // ArrayBuffer or Buffer (Uint8Array) — view as Int16Array
    const ab = input instanceof ArrayBuffer ? input : input.buffer;
    samples = new Int16Array(ab);
  }

  // Passthrough — no resampling needed
  if (fromRate === toRate) return samples;

  const inputLength = samples.length;
  if (inputLength === 0) return new Int16Array(0);

  const ratio = fromRate / toRate;
  // At least 1 sample out for any non-empty input (a non-empty chunk producing empty output
  // would be silently dropped downstream). 1 input sample at 44.1kHz ≈ 0.36 samples at 16kHz,
  // so clamp the round-up to a minimum of 1.
  const outputLength = Math.max(1, Math.round(inputLength / ratio));
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, inputLength - 1);
    const frac = srcPos - idx0;

    // Linear interpolation between adjacent samples
    const s0 = samples[idx0];
    const s1 = samples[idx1];
    const interp = s0 + (s1 - s0) * frac;

    // Clamp to Int16 range
    output[i] = interp < -32768 ? -32768 : interp > 32767 ? 32767 : Math.round(interp);
  }

  return output;
}

// Browser/Node dual export: browser <script> uses the global; Node require uses module.exports.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resampleToInt16 };
}
if (typeof window !== 'undefined') {
  window.resampleToInt16 = resampleToInt16;
}
