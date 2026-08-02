// Drift guard: JS model list must match Python.
// Run only when Python is reachable (this test reads a Python source file
// and extracts the MODELS list — same shape as test/stt-models.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FUNASR_MODEL_IDS } = require("../src/stt-funasr-models");

const PY_SRC = path.join(__dirname, "..", "python", "cue_stt_funasr_service.py");

// Reads the MODELS list from the Python source by looking for the assignment
// `MODELS = list(...)` in the file and extracting the elements. This is
// intentionally a simple extract — it doesn't import or exec Python.
function extractPythonModelList(src) {
  // Match the MODELS = list(_MODELSCOPE_REPOS.keys()) assignment
  const match = src.match(/_MODELSCOPE_REPOS\s*=\s*\{([^}]+)\}/s);
  if (!match) return [];

  const content = match[1];
  const keys = [];
  // extract quoted string keys from a Python dict literal
  const re = /["']([\w-]+)["']\s*:/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

test("stt-funasr-models JS list equals Python source list", () => {
  const src = fs.readFileSync(PY_SRC, "utf8");
  const pyList = extractPythonModelList(src);
  assert.equal(pyList.length > 0, true, "should extract at least one model from Python source");
  assert.deepEqual(FUNASR_MODEL_IDS.slice().sort(), pyList.slice().sort());
});