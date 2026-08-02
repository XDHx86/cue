// Streaming speech-to-text resolver. Picks the streaming STT provider from the
// registry (src/registry.js) and creates per-channel sessions.
//
// createStreamSTT(settings) -> { available, provider, createSession(...) }
//   - 'auto'   -> first ready streaming provider (local preferred, then external-ws)
//   - 'local'  -> local managed engine only (available iff venv ready)
//   - 'faster-whisper' -> external WS server only (available iff URL set)
//   - 'batch'  -> unavailable (the main process falls back to the batch flush loop)
//
// Provider folders (src/providers/stt/<id>/) own their readiness checks. This module
// is provider-agnostic — it reads capabilities.streaming and streamingReady from the
// registry, and delegates to createStreamSession for session creation.

const { listProviders } = require('./registry');
const { loadProviders } = require('./registry-loader');
const { noopLogger } = require('./logger');
// Ensure STT providers are loaded (idempotent).
loadProviders({ _require: require });

// Re-export WS framing utilities from the external-ws provider for backwards
// compatibility (tests and external consumers).
const extWs = require('./providers/stt/external-ws/session');
const {
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader, parseWsUrl,
  WsClient, FasterWhisperStreamSession,
  OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG,
} = extWs;

// Resolve which streaming provider (if any) applies, per settings.stt.provider.
// Reads from the registry — provider-agnostic. The localReady hint is passed in
// (not read from disk) so this resolver stays pure and testable without a live
// process; defaults to false so 'auto' with no setup stays null->batch.
function resolveProvider(settings, { localReady = false } = {}) {
  const cfg = settings.stt || {};
  const want = cfg.provider || 'auto';
  // Handle both rich capability objects ({ state: 'supported' }) from the R3 plugin system
  // and legacy boolean `true` for backward-compat. Rich objects are truthy even when
  // state is 'unsupported', so we must check the state field explicitly.
  const streaming = listProviders('stt').filter((p) => {
    const c = p.capabilities && p.capabilities.streaming;
    return c && (c === true || c.state === 'supported');
  });

  if (want === 'batch') return { provider: 'batch', available: false };

  for (const desc of streaming) {
    // For explicit transport names (not 'auto' or legacy aliases), only match by exact id.
    // This prevents e.g. 'assemblyai' from accidentally matching the local faster-whisper
    // provider when localReady is true and local happens to be first in the order.
    const LEGACY_ALIASES = ['auto', 'batch', 'local', 'faster-whisper'];
    if (!LEGACY_ALIASES.includes(want) && desc.id !== want) continue;
    // Legacy capability-based matching for 'local' and 'faster-whisper'
    if (want === 'local' && !desc.capabilities.local) continue;
    if (want === 'faster-whisper' && desc.capabilities.local) continue;
    if (typeof desc.streamingReady === 'function' && !desc.streamingReady(settings, { localReady })) continue;
    return { provider: desc.id, available: true };
  }
  return { provider: null, available: false };
}

function createStreamSTT(settings, { localEngineManager, logger } = {}) {
  const log = (logger && logger.child) ? logger.child({ module: 'stt-stream' }) : (logger || noopLogger);
  const localReady = !!(localEngineManager && localEngineManager.isVenvReady && localEngineManager.isVenvReady());
  const { provider, available } = resolveProvider(settings, { localReady });

  // Find the selected provider descriptor from the registry
  const desc = available ? listProviders('stt').find((p) => p.id === provider) : null;

  return {
    available,
    provider,
    createSession({ channel, language, onFinal, onPartial, onError, onStatus } = {}) {
      if (!available || !desc) return null;
      if (typeof desc.createStreamSession !== 'function') return null;
      return desc.createStreamSession({
        settings, manager: localEngineManager, channel, language,
        onFinal, onPartial, onError, onStatus, log,
      });
    },
  };
}

module.exports = {
  createStreamSTT,
  encodeFrame, decodeFrame, makeHandshakeKey, expectedAccept, extractHeader, parseWsUrl,
  resolveProvider, WsClient, FasterWhisperStreamSession,
  OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG,
};
