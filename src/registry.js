// Provider registry — the single capability/metadata spine for cue's LLM and STT providers.
//
// cue has TWO provider domains that are deliberately decoupled (CLAUDE.md invariant: "LLM and
// STT are decoupled because Anthropic has no audio API; STT builds its own fallback chain"). This
// module respects that by keeping ONE descriptor shape but TWO type buckets ('llm' | 'stt'), so the
// runtime paths never merge even though Settings can build both from the same self-describing spec.
//
// Every provider self-describes: id, displayName, description, providerType, capabilities,
// supportedModels, configurableSettings, defaultSettings, order, and createEngine (plus, for STT
// engines that can stream live, createStreamSession). The rest of the app never names a specific
// provider — it asks the registry. Adding a provider = one folder under src/providers/<type>/<id>/
// whose index.js calls defineProvider (loaded by src/registry-loader.js). No switch statements, no
// Settings UI edits, no DEFAULTS fan-out: the descriptor's configurableSettings/defaultSettings drive
// Settings generation and store defaults automatically (ADR for the shared-descriptor/two-registry
// choice in .claude/docs/decisions.md).
//
// Pure JS: no electron, no eager SDK require. Provider modules lazy-require their SDK INSIDE
// createEngine so store can fold defaultSettings without pulling SDKs, and the pure-Node test suite
// can load the registry without the network SDKs (conventions.md: tests stay electron- and dep-free).
//
// IDs are namespaced by type, NOT global — 'openai' is both an LLM and an STT provider, so get/list
// always take a type. A descriptor is keyed `${type}:${id}` internally.

const PROVIDER_TYPES = ['llm', 'stt'];

// Field "type" values the Settings renderer knows how to render (src/registry → providers:spec IPC
// → renderer buildProviderFields). 'secret' renders as a password input. 'select'/'seg' take an
// `options` list. Everything else is a plain text/number input. Adding a new control kind = extend
// the renderer's buildProviderFields switch (the one place field-types are enumerated), not the
// registry data.
const FIELD_KINDS = ['text', 'secret', 'number', 'select', 'seg', 'boolean'];

// Registered descriptors, keyed `${type}:${id}` so a same-named LLM and STT provider never collide.
const byKey = new Map();

function key(type, id) { return type + ':' + id; }

function coerceOrder(o) {
  const n = Number(o);
  return Number.isFinite(n) ? n : 0;
}

function assertString(v, who) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`provider ${who} must be a non-empty string`);
}

// Validate a field schema entry (configurableSettings[i]). Loose: extra keys are preserved verbatim so
// providers can attach renderer hints (placeholder, hint, min, max, options…) without the registry
// having to whitelist them. We only enforce the shape the Settings UI relies on.
function validateField(f) {
  if (!f || typeof f !== 'object') throw new Error('configurableSettings entries must be objects');
  assertString(f.id, 'field id');
  if (typeof f.label !== 'string') throw new Error(`field "${f.id}" label must be a string`);
  if (!FIELD_KINDS.includes(f.type)) {
    throw new Error(`field "${f.id}" type "${f.type}" is not one of ${FIELD_KINDS.join(', ')}`);
  }
  if ((f.type === 'select' || f.type === 'seg') && !f.options) {
    throw new Error(`field "${f.id}" of type ${f.type} needs an "options" list`);
  }
}

// Validate the descriptor envelope. Throws on a malformed provider so a bad plugin fails loud at load
// instead of silently producing an empty Settings page. Function values (createEngine/
// createStreamSession) are checked for typeof but never invoked here.
function validateDescriptor(desc) {
  if (!desc || typeof desc !== 'object') throw new Error('provider descriptor must be an object');
  if (!PROVIDER_TYPES.includes(desc.providerType)) {
    throw new Error(`providerType must be one of ${PROVIDER_TYPES.join(', ')} (got "${desc.providerType}")`);
  }
  assertString(desc.id, 'id');
  assertString(desc.displayName, 'displayName');
  if (typeof desc.createEngine !== 'function') {
    throw new Error(`provider "${desc.id}": createEngine must be a function`);
  }
  if (!Array.isArray(desc.configurableSettings)) {
    throw new Error(`provider "${desc.id}": configurableSettings must be an array`);
  }
  desc.configurableSettings.forEach(validateField);
  if (desc.defaultSettings && typeof desc.defaultSettings !== 'object') {
    throw new Error(`provider "${desc.id}": defaultSettings must be an object if present`);
  }
  if (desc.capabilities && typeof desc.capabilities !== 'object') {
    throw new Error(`provider "${desc.id}": capabilities must be an object if present`);
  }
  if (desc.providerType === 'stt' && typeof desc.createStreamSession === 'function') {
    // ok — STT provider that can stream live
  } else if (desc.createStreamSession !== undefined && typeof desc.createStreamSession !== 'function') {
    throw new Error(`provider "${desc.id}": createStreamSession must be a function if present (STT only)`);
  }
  if (desc.supportgedModels !== undefined) { /* common typo guard; the field is `supportedModels` */ }
  if (desc.supportedModels != null && !Array.isArray(desc.supportedModels) && typeof desc.supportedModels !== 'function') {
    throw new Error(`provider "${desc.id}": supportedModels must be an array, a function, or null`);
  }
  if (desc.modelSettingsPath !== undefined && desc.modelSettingsPath !== null && typeof desc.modelSettingsPath !== 'string') {
    throw new Error(`provider "${desc.id}": modelSettingsPath must be a string, null, or absent`);
  }
}

// Register a provider descriptor. Returns an unsubscribe so tests can roll a provider back; the app
// itself loads providers once at startup and never unsubscribes. Re-defining the same (type,id)
// replaces the prior descriptor (a provider hot-reload during development should not throw).
function defineProvider(desc) {
  const d = desc && typeof desc === 'object' ? { ...desc } : desc;
  validateDescriptor(d);
  d.order = coerceOrder(d.order);
  const k = key(d.providerType, d.id);
  byKey.set(k, d);
  return () => byKey.delete(k);
}

// All descriptors of a type, sorted by `order` ascending (STT fallback chain = ordered; LLM order is
// only used for Settings display ordering). Returns the live descriptor objects (with functions) —
// main-process callers only. The renderer gets listProvidersSafe() instead.
function listProviders(type) {
  if (type && !PROVIDER_TYPES.includes(type)) return [];
  const out = [];
  for (const d of byKey.values()) if (!type || d.providerType === type) out.push(d);
  out.sort((a, b) => (a.order || 0) - (b.order || 0));
  return out;
}

// One descriptor by (type, id), or null. The createLLM/createSTT callers know their type.
function getProvider(type, id) {
  const d = byKey.get(key(type, id));
  return d || null;
}

function hasProvider(type, id) { return byKey.has(key(type, id)); }

// Strip the function values so the descriptor is JSON-safe for the renderer (providers:spec IPC).
// Returns a shallow copy with only the data fields the UI needs — capabilities, supportedModels,
// configurableSettings, defaultSettings, order, ids/labels. createEngine/createStreamSession never
// cross the IPC boundary (they live in the main process).
function renderSafe(desc) {
  if (!desc) return null;
  return {
    id: desc.id,
    displayName: desc.displayName,
    description: desc.description || '',
    providerType: desc.providerType,
    capabilities: desc.capabilities || {},
    supportedModels: desc.supportedModels || null,
    modelSettingsPath: desc.modelSettingsPath || null,
    configurableSettings: desc.configurableSettings || [],
    defaultSettings: desc.defaultSettings || {},
    order: desc.order || 0,
  };
}

function listProvidersSafe(type) { return listProviders(type).map(renderSafe); }

// Resolve the effective supportedModels for a provider at runtime. `supportedModels` may be a static
// array (most providers) or a function(ctx) → array|Promise<array> (the local STT provider scans the
// HF cache; a future provider could fetch a remote list). Returns null when the provider declares no
// model list (free-text only). The ctx is whatever the caller threads (manager/fs/settings).
async function resolveSupportedModels(desc, ctx) {
  if (desc == null) return null;
  const sm = desc.supportedModels;
  if (sm == null) return null;
  if (typeof sm === 'function') {
    const out = await sm(ctx);
    return Array.isArray(out) ? out : null;
  }
  return Array.isArray(sm) ? sm : null;
}

// Test escape hatch: clear every registered descriptor. Mirrors src/logger.js _resetSttLogger so a
// test can install throwaway providers without leaking into the next case.
function _resetProviders() { byKey.clear(); }

module.exports = {
  PROVIDER_TYPES, FIELD_KINDS,
  defineProvider, listProviders, getProvider, hasProvider,
  renderSafe, listProvidersSafe, resolveSupportedModels,
  _resetProviders,
};
