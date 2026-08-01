// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
// Default assistant-style option id (src/prompt-registry.js owns the templates now); needed here
// only for the one-time legacy prePrompt migration fallback. The registry is the live source.
const { DEFAULT_PRE_PROMPT_TEMPLATE } = require('./prompt-registry');
// Provider registry (R1c). LLM providers self-describe their defaultSettings (apiKeys slots, model
// tiers, ollama baseURL); folding them into DEFAULTS makes the providers the ONE source for those
// defaults — no per-provider fan-out here. loadProviders() is pure at load time (provider modules
// lazy-require their network SDK INSIDE createEngine, and the logger spawns no transport on
// require), so calling it while building DEFAULTS pulls no SDK and no Electron. STT providers
// aren't registered yet (no src/providers/stt tree — R2), so only LLM defaults fold in; the STT-
// owned apiKeys.deepgram seed stays a literal here until R2's deepgram provider contributes it.
const registry = require('./registry');
const { loadProviders } = require('./registry-loader');
loadProviders({ _require: require });
// Schema-driven config (central registry of every configurable runtime value). Supplies defaults,
// validation, env-var mappings, and the renderer's Advanced Settings UI spec — all from one
// source of truth. Requires registry-loader to have run first (foldLlmDefaults reads the registry).
const { schemaDefaults, validate } = require('./config-schema');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

// BASE_DEFAULTS holds the non-provider-owned skeleton: top-level toggles, shortcuts, skills,
// memory, the STT block, and the STT-owned deepgram apiKeys seed. The LLM providers' apiKeys/
// models/ollama defaults are folded in AFTER this literal (see foldLlmDefaults below) so the
// provider descriptors are the single source for those. `deepMerge` is defined further down but
// is a function declaration (hoisted), so the fold call below can reference it.
const BASE_DEFAULTS = {
  provider: 'openai',
  smart: false,
  resumeContext: '',
  // Two-tier résumé (profile-context.js). resumeSummary is the auto-generated ≤1500-char career
  // digest that résumé-enabled *small* modes send instead of the full ~12k résumé. Regenerated
  // by main.js when resumeContext changes (settings:set); empty until then → summary tier falls
  // back to the full résumé.
  resumeSummary: '',
  // System-prompt overrides (src/prompt-registry.js). settings.promptOverrides[id] holds the
  // user's DELTA over the registry defaults — resolveField(id, settings) picks override-or-default.
  // Restore-default writes the empty sentinel ('' for 'text', { option, text:'' } for 'select'),
  // NOT a key deletion: deepMerge never deletes, so the sentinel is how "back to default" persists.
  promptOverrides: {},
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
  // below from flipping away from a user-selected ollama just because the key isn't "real". The
  // LLM provider descriptors (src/providers/llm/*/index.js) contribute every apiKeys/models slot
  // for the 5 LLM providers via foldLlmDefaults() below; deepgram is an STT key (R2 wires it) and
  // stays a literal seed here so ENV override CUE_DEEPGRAM_API_KEY has a node to land on today.
  apiKeys: { deepgram: '' },
  models: {},
  // Ollama base URL — `ollama serve` exposes an OpenAI-compatible /v1 endpoint. Empty falls
  // back to http://localhost:11434/v1 in the ollama provider. Set via Settings or
  // CUE_OLLAMA_BASE_URL. Folded in by the ollama provider's defaultSettings below.
  ollama: {},
  // Speech-to-text streaming/lifecycle config. `provider` is the TRANSPORT selector:
  //   'auto' (prefer the managed local engine when ready, else the external WS server if a
  //   URL is set, else batch), 'local' (force the managed Python engine), 'faster-whisper'
  // (the external WS server the user runs themselves), or 'batch' (the legacy flush loop).
  // Provider-owned STT keys (engine, local.*, fasterWhisperURL, model) are folded in by the
  // STT providers' defaultSettings via foldSttDefaults() below — single source of truth.
  stt: {
    provider: 'auto',
    enabled: true,                 // master STT toggle (Settings)
    deepgramURL: 'wss://api.deepgram.com/v1/listen',
    // Structured STT logging (Pino on the Node side, Loguru in the spawned Python
    // service — src/logger.js / python/cue_stt_logging.py, ADR-014). `logDir` '' →
    // userData/logs (resolved lazily by the logger, so store.load() needs no Electron).
    // Rotation: size-based when sizeBytes is set, else daily; count keeps N rotated
    // files. All fields have CUE_STT_LOG_* runtime overrides (never persisted to disk).
    logging: {
      level: 'debug',            // debug|info|warn|error|fatal (maps to Python too)
      logDir: '',               // '' → userData/logs (relative resolves under userData)
      console: true,            // console logging on/off
      file: true,               // rotating file on/off
      pretty: true,             // pretty console (false → compact JSON stdout)
      rotate: { sizeBytes: 5_242_880, count: 5 },  // size-based when sizeBytes set; else daily
    },
  }
};

// Fold every registered LLM provider's defaultSettings into the DEFAULTS skeleton above (apiKeys,
// models, ollama baseURL). This makes the provider descriptors the single source for those values:
// adding an LLM provider = one folder whose defaultSettings fill these slots automatically, with no
// edit to DEFAULTS. deepMerge (defined below; hoisted) unions disjoint provider keys; order is
// immaterial since each provider contributes a disjoint slice. The folded result is byte-identical
// to the pre-R1c literals — test/providers.test.js asserts the equivalence, and the store-defaults
// suite stays green. Pure at load: provider modules lazy-require SDKs inside createEngine (never
// called here), so nothing pulls a network dependency or spawns a transport.
function foldLlmDefaults() {
  let acc = {};
  for (const d of registry.listProviders('llm')) {
    if (d.defaultSettings) acc = deepMerge(acc, d.defaultSettings);
  }
  return acc;
}

// Fold every registered STT provider's defaultSettings into the DEFAULTS skeleton above. STT
// providers own: stt.engine, stt.local.*, stt.fasterWhisperURL, stt.model. This makes the
// STT provider descriptors the single source for those values — adding an STT provider = one
// folder whose defaultSettings fill these slots automatically. The folded result must equal
// today's literal stt: block — test/store-defaults.test.js and test/providers.test.js assert
// this. Pure at load (same safety as foldLlmDefaults).
function foldSttDefaults() {
  let acc = {};
  for (const d of registry.listProviders('stt')) {
    if (d.defaultSettings) acc = deepMerge(acc, d.defaultSettings);
  }
  return acc;
}

// DEFAULTS merges four layers: BASE_DEFAULTS (the non-provider skeleton) → LLM provider
// defaultSettings → STT provider defaultSettings → schemaDefaults (from config-schema.js,
// which holds every configurable runtime value). The schema layer adds nested keys like
// llm.maxTokens, memory.minNewTurns, stt.maxSpawnFailures, ui.zoomMin, etc. that the
// BASE_DEFAULTS skeleton doesn't declare — deepMerge creates them. Existing keys in
// BASE_DEFAULTS are preserved; only new paths are added.
const DEFAULTS = deepMerge(deepMerge(deepMerge(BASE_DEFAULTS, foldLlmDefaults()), foldSttDefaults()), schemaDefaults());

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

  // One-time migration: older cue stored the assistant-style selection at top-level `prePrompt`
  // (custom text) + `prePromptTemplate` (selected built-in id, or 'custom'). Move both into the
  // new `promptOverrides.prePrompt` home used by src/prompt-registry.js, only synthesizing a value
  // when the new slot is empty (a hand-set override wins). The legacy keys are scrubbed either way
  // so there is a single source after the next save. Runs before env overrides (none of these are
  // env-controlled). Idempotent: on a migrated-on-disk install the legacy keys are already gone.
  if (data.prePrompt !== undefined || data.prePromptTemplate !== undefined) {
    const po = data.promptOverrides || (data.promptOverrides = {});
    if (!po.prePrompt) {
      const tpl = data.prePromptTemplate;
      const custom = typeof data.prePrompt === 'string' ? data.prePrompt : '';
      po.prePrompt = { option: tpl || DEFAULT_PRE_PROMPT_TEMPLATE, text: custom };
    }
    delete data.prePrompt;
    delete data.prePromptTemplate;
  }

  // Auto-switch provider if the current one has no key, but another one does.
  if (!data.apiKeys[data.provider]) {
    const validProviders = ['openai', 'anthropic', 'gemini', 'nvidia'];
    const active = validProviders.find(p => data.apiKeys[p]);
    if (active) {
      data.provider = active;
      // We don't save() here so we don't spam disk, it will persist on next save.
    }
  }

  // Validate and coerce all schema-managed settings. This runs once on first load:
  // out-of-range values are clamped, NaN/defaulted, and corrupt data is repaired.
  validate(data);

  return data;
}

function save() { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

// Validate a settings patch before merging. Returns an array of error strings (empty = valid).
// Runs schema validation (type coercion, clamping) plus semantic checks on provider-specific
// fields. Semantic errors are warnings (logged, not blocked) to avoid breaking the app when
// a new provider is added; schema errors are corrective (values clamped/defaulted).
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object') return [];
  const errors = [];

  // Schema validation: coerce types, clamp numerics to min/max.
  // validate() mutates in place — safe because we apply it to a temporary copy.
  try { validate(patch); } catch (e) {
    errors.push('schema: ' + ((e && e.message) || 'validation failed'));
  }

  // API key format checks (advisory — log but don't block save)
  const keys = patch.apiKeys || {};
  if (keys.openai && typeof keys.openai === 'string' && !/^sk-/.test(keys.openai)) {
    errors.push('OpenAI key should start with "sk-"');
  }
  if (keys.anthropic && typeof keys.anthropic === 'string' && !/^sk-ant-/.test(keys.anthropic)) {
    errors.push('Anthropic key should start with "sk-ant-"');
  }
  if (keys.gemini && typeof keys.gemini === 'string' && !/^AIza/.test(keys.gemini)) {
    errors.push('Gemini key should start with "AIza"');
  }
  if (keys.nvidia && typeof keys.nvidia === 'string' && !/^nvapi-/.test(keys.nvidia)) {
    errors.push('Nvidia key should start with "nvapi-"');
  }
  if (keys.assemblyai && typeof keys.assemblyai === 'string' && keys.assemblyai.length < 20) {
    errors.push('AssemblyAI key seems too short (expected ~40+ chars)');
  }
  if (keys.groq && typeof keys.groq === 'string' && !/^gsk_/.test(keys.groq)) {
    errors.push('Groq key should start with "gsk_"');
  }

  // STT provider validation
  if (patch.stt && patch.stt.provider) {
    const validProviders = ['auto', 'local', 'faster-whisper', 'batch', 'assemblyai', 'groq'];
    if (!validProviders.includes(patch.stt.provider)) {
      errors.push('Unknown STT provider: ' + patch.stt.provider);
    }
  }

  // LLM provider validation
  if (patch.provider) {
    const validLlm = ['openai', 'anthropic', 'gemini', 'nvidia', 'ollama'];
    if (!validLlm.includes(patch.provider)) {
      errors.push('Unknown LLM provider: ' + patch.provider);
    }
  }

  return errors;
}

module.exports = {
  getSettings() { return load(); },
  validatePatch,
  setSettings(patch) {
    load();
    const errors = validatePatch(patch);
    // Log validation warnings (non-blocking — save proceeds even with advisory errors)
    if (errors.length) {
      try { appLog().warn({ errors }, 'settings validation warnings'); } catch {}
    }
    data = deepMerge(data, patch || {});
    save();
    return data;
  },
};
