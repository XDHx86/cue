// Source of truth (Node side) for the faster-whisper model sizes offered in the
// Settings Speech-to-Text panel and by the model-management CLI
// (scripts/stt-cli.js). This list is PAIRED with `MODELS` in
// python/cue_stt_service.py: every size here must also be a size there (and
// resolve to a real HuggingFace repo under `ORG`), because the Python service —
// not Node — actually resolves a name to a repo and downloads it. Tests assert
// the two lists stay in sync so a rename can't drift them apart silently.
//
// "No native modules by design": a model-list scan is a plain `fs.existsSync`
// over the HuggingFace hub cache layout, so Settings can show cached/downloaded
// flags before the Python service has even started, and the CLI can manage the
// cache without spawning Python. Pure (takes an `fs`) so it tests with a fake.

const path = require('path');

// Candidate model sizes. Kept in sync with python/cue_stt_service.py:MODELS.
// NOTE: only the six sizes below are offered. The Python service resolves every name with a naive
// `Systran/faster-whisper-<name>` repo map (hf_repo), so a wider catalog (distil-*, large, turbo,
// the *.en variants) cannot be added HERE without either 404'd downloads or a repo-map change on
// the Python side. This list and Python's MODELS are paired by test/stt-models.test.js — change both.
const STT_MODEL_SIZES = ['tiny', 'base', 'small', 'medium', 'medium-large-v3', 'large-v3'];
const STT_MODEL_ORG = 'Systran'; // {org}/faster-whisper-<name>

// HuggingFace hub cache layout that faster-whisper writes under download_root:
// `models--{org}--faster-whisper-{name}/snapshots/...`. Existence of the top
// dir is enough to call a model "cached" (a half download still leaves it, but
// that is rare and re-running Download repairs it).
function hfCacheDirName(name) { return `models--${STT_MODEL_ORG}--faster-whisper-${name}`; }
function hfCacheDir(modelsDir, name) { return path.join(modelsDir, hfCacheDirName(name)); }

// Pure given an fs: returns [{name, cached}] for every candidate size. `cached`
// is a directory-existence check against the HF layout above. Works before the
// service starts — the Settings panel refreshes this on open and after every
// download/delete. A null/missing fs yields all-cached=false (defensive).
function scanCachedModels(modelsDir, fs) {
  return STT_MODEL_SIZES.map((name) => {
    const dir = hfCacheDir(modelsDir, name);
    return { name, cached: !!(fs && fs.existsSync && fs.existsSync(dir)) };
  });
}

module.exports = { STT_MODEL_SIZES, STT_MODEL_ORG, hfCacheDirName, hfCacheDir, scanCachedModels };
