// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  resumeContext: '',
  shortcuts: { assist: 'CommandOrControl+Return' },
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', nvidia: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function load() {
  if (data) return data;
  try { data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { data = deepMerge(DEFAULTS, {}); }

  // Apply CUE_* env-var overrides (populated by src/env.js before this require resolves).
  // Runtime-only: these are never saved to cue-data.json. The auto-switch below still runs
  // after, so an env-supplied key can make a provider ready without flipping the persisted
  // provider away from the user's choice.
  applyEnvOverrides(data);

  // Auto-switch provider if the current one has no key, but another one does.
  if (!data.apiKeys[data.provider]) {
    const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia'];
    const active = validProviders.find(p => data.apiKeys[p]);
    if (active) {
      data.provider = active;
      // We don't save() here so we don't spam disk, it will persist on next save.
    }
  }

  return data;
}

// Schema-aware mapping of CUE_* env vars into settings paths. Run-time-only overrides —
// the auto-switch and persisted cue-data.json both see the overridden values, but setSettings
// never writes them to disk because they live in env, not in the patch.
const ENV_OVERRIDES = {
  CUE_OPENAI_API_KEY: ['apiKeys', 'openai'],
  CUE_ANTHROPIC_API_KEY: ['apiKeys', 'anthropic'],
  CUE_GEMINI_API_KEY: ['apiKeys', 'gemini'],
  CUE_NVIDIA_API_KEY: ['apiKeys', 'nvidia'],
  CUE_DEEPGRAM_API_KEY: ['apiKeys', 'deepgram'],
  CUE_OLLAMA_API_KEY: ['apiKeys', 'ollama'],
  CUE_OLLAMA_BASE_URL: ['ollama', 'baseURL'],
  CUE_STT_PROVIDER: ['stt', 'provider'],
  CUE_FASTER_WHISPER_URL: ['stt', 'fasterWhisperURL'],
  CUE_DEEPGRAM_URL: ['stt', 'deepgramURL']
};

function applyEnvOverrides(data) {
  for (const [envName, path] of Object.entries(ENV_OVERRIDES)) {
    const val = process.env[envName];
    if (val === undefined) continue;
    // Walk the path; only set the leaf if every intermediate node already exists in data,
    // so overrides for not-yet-present sub-objects (ollama/stt added by later commits) are
    // silent no-ops rather than creating stray keys.
    let node = data;
    for (let i = 0; i < path.length - 1; i++) {
      if (node[path[i]] == null || typeof node[path[i]] !== 'object') { node = null; break; }
      node = node[path[i]];
    }
    if (node) node[path[path.length - 1]] = val;
  }
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; }
};
