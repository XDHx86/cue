// Local STT-engine manager registry.
//
// cue runs TWO independent offline STT engines behind separate managed Python services —
// faster-whisper (python/cue_stt_service.py) and FunASR (python/cue_stt_funasr_service.py)
// — each with its own isolated venv, spawned and torn down by a `createSttProcessManager`
// instance (src/stt-process.js). The orchestrators (src/stt.js batch chain,
// src/stt-stream.js streaming resolver) pass a SINGLE manager into every provider's
// createEngine/createStreamSession, which works for the single-engine world but cannot
// hand a second engine its own manager without growing the orchestrator signatures.
//
// This registry is the seam that fixes the manager-handoff without touching the
// orchestrators: each LOCAL provider knows its own id, so it reaches its own manager with
// a one-liner — `getLocalManager('funasr')`. The orchestrator-passed `manager` /
// `localEngineManager` args keep working for faster-whisper (untouched) and are simply
// ignored by any provider that owns its manager here.
//
// Managers register LAZY factories (a thunk that builds the manager) so a second engine's
// venv/Python is never created unless the user actually selects that engine — preserving
// the "users never run pip" friction for users who only ever use faster-whisper
// (see .claude/docs/decisions.md — multi-manager ADR).
//
// Pure Node (no electron, no spawn) so the test suite requires nothing but a fake factory.

const LOCAL_MANAGERS = new Map(); // engineId -> { factory, instance }

function registerLocalManager(engineId, factory) {
  if (typeof engineId !== 'string' || !engineId) throw new TypeError('engineId required');
  if (typeof factory !== 'function') throw new TypeError('factory must be a function');
  LOCAL_MANAGERS.set(engineId, { factory, instance: null });
}

function unregisterLocalManager(engineId) {
  LOCAL_MANAGERS.delete(engineId);
}

// Lazily build + cache the manager for an engine. Returns null if the engine was never
// registered or the factory threw. The factory is invoked at most once per registry slot
// (the cached instance is returned on subsequent calls).
function getLocalManager(engineId) {
  const slot = LOCAL_MANAGERS.get(engineId);
  if (!slot) return null;
  if (!slot.instance) {
    try { slot.instance = slot.factory(); }
    catch { slot.instance = null; }
  }
  return slot.instance || null;
}

// True iff the engine's manager exists AND reports its venv ready. A missing/unregistered
// engine (or a factory that returned nothing) reports false — the resolver treats that as
// "not available", so `auto` falls through to the next engine.
function localManagerReady(engineId) {
  const mgr = getLocalManager(engineId);
  return !!(mgr && typeof mgr.isVenvReady === 'function' && mgr.isVenvReady());
}

// Best-effort teardown of every built manager. Called from the `before-quit` handler so a
// capture-while-quitting doesn't orphan a Python process. A manager without a `stop`
// (e.g. a partial fake in tests) is skipped.
async function stopAllLocalManagers() {
  const stops = [];
  for (const slot of LOCAL_MANAGERS.values()) {
    const mgr = slot.instance;
    if (mgr && typeof mgr.stop === 'function') {
      try { const r = mgr.stop(); if (r && typeof r.then === 'function') stops.push(r); }
      catch { /* best-effort */ }
    }
  }
  if (stops.length) await Promise.all(stops);
}

function _resetLocalManagers() {
  LOCAL_MANAGERS.clear();
}

module.exports = {
  registerLocalManager, unregisterLocalManager,
  getLocalManager, localManagerReady, stopAllLocalManagers,
  _resetLocalManagers,
};
