// FunASR model sizes — kept in sync with python/cue_stt_funasr_service.py:MODELS.
// A drift guard in test/stt-funasr-models.test.js asserts the JS and Python lists
// are identical, matching the pattern of test/stt-models.test.js for faster-whisper.
//
// These are keys into the _MODELSCOPE_REPOS dict in the Python service (the actual
// modelscope repo ids live in Python only — the Node side passes the short name).

const FUNASR_MODEL_IDS = ["paraformer-large-zh", "paraformer-large-en", "paraformer-zh"];

// Scan a modelscope download-root directory for cached FunASR models.
// modelscope stores each under `{downloadRoot}/{repo_id_sanitized}/` where the
// standard sanitization replaces '/' with '__'.

function scanCachedFunasrModels(downloadRoot, fs) {
  const results = [];
  if (!downloadRoot || !fs || typeof fs.existsSync !== "function") return results;

  const REPOS = {
    "paraformer-large-zh": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1",
    "paraformer-large-en": "iic/speech_paraformer-large_asr_nat-en-16k-common-vocab10028-tensorflow1",
    "paraformer-zh": "iic/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1",
  };

  for (const id of FUNASR_MODEL_IDS) {
    const repo = REPOS[id];
    if (!repo) continue;
    const dirName = repo.replace(/\//g, "__").replace(/:/g, "__");
    const full = require("path").join(downloadRoot, dirName);
    results.push({ id, repo, cached: fs.existsSync(full) });
  }
  return results;
}

module.exports = { FUNASR_MODEL_IDS, scanCachedFunasrModels };