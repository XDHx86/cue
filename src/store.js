// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  resumeContext: '',
  // Two-tier résumé (profile-context.js). resumeSummary is the auto-generated ≤1500-char career
  // digest that résumé-enabled *small* modes send instead of the full ~12k résumé. Regenerated
  // by main.js when resumeContext changes (settings:set); empty until then → summary tier falls
  // back to the full résumé.
  resumeSummary: '',
  // System-prompt composition (src/prompt-compose.js). prePrompt is free-form custom instructions
  // (set when the "Custom" template is selected); prePromptTemplate picks a built-in when it isn't.
  prePrompt: '',
  prePromptTemplate: 'concise',
  // Skills (src/skills.js): .claude/skills/*.md under skillDir, applied as behavioral guidance.
  // skillEnabled is the secondary gate — no skillDir set means no skills injected regardless.
  skillDir: '',
  skillEnabled: true,
  // Conversation memory. Rolling summary lives in cue-memory.json (src/memory.js), NOT here; only
  // the user's hand-edited notes persist in settings so they survive across sessions.
  memory: { notes: '' },
  shortcuts: { assist: 'CommandOrControl+Return' },
  // ollama's key is a non-empty sentinel ('ollama'), NOT a real key: the OpenAI SDK constructor
  // requires a non-empty apiKey, Ollama ignores it, and a non-empty value stops the auto-switch
  // below from flipping away from a user-selected ollama just because the key isn't "real".
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', nvidia: '', ollama: 'ollama' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    nvidia: { fast: 'meta/llama-3.2-11b-vision-instruct', smart: 'meta/llama-3.2-90b-vision-instruct' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' }
  },
  // Ollama base URL — `ollama serve` exposes an OpenAI-compatible /v1 endpoint. Empty falls
  // back to http://localhost:11434/v1 in llm.js. Set via Settings or CUE_OLLAMA_BASE_URL.
  ollama: { baseURL: '' },
  // Speech-to-text streaming/lifecycle config. `provider` is 'auto' (pick the first streaming
  // provider whose URL/key is configured, else fall back to batch createSTT), 'faster-whisper'
  // (force the local WS server), or 'batch' (force the legacy flush loop). fasterWhisperURL
  // defaults to '' (NOT a localhost URL) so 'auto' resolves to batch for the majority of users
  // who don't run a local server — otherwise every capture would burn 3 connect failures before
  // latching. Users who run faster-whisper enable it via Settings or CUE_FASTER_WHISPER_URL.
  stt: {
    provider: 'auto',
    fasterWhisperURL: '',
    deepgramURL: 'wss://api.deepgram.com/v1/listen',
    model: '' // OpenAI Whisper model name for the batch path (default 'whisper-1' in stt.js)
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

  // One-time migration: older cue stored the OpenAI Whisper model at top-level `sttModel`. Move
  // it into the new `stt.model` home (only if the new slot is empty, so a user's explicit
  // stt.model wins). Runs before env overrides so a CUE_* value still wins over the migrated one.
  if (data.sttModel !== undefined) {
    if (!data.stt || !data.stt.model) {
      data.stt = data.stt || { provider: 'auto', fasterWhisperURL: '', deepgramURL: '', model: '' };
      data.stt.model = data.sttModel;
    }
    delete data.sttModel;
  }

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
