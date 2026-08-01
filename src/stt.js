// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable path is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
//
// This is the BATCH path (one WAV -> one transcription). Streaming STT (the managed
// Python engine or the external faster-whisper WS server) lives in src/stt-stream.js;
// when a streaming provider is configured and active, main.js sends live PCM to a
// streaming session instead of this loop, and only uses createSTT() as a
// degrade-to-batch fallback (when a streaming session latches, or capture runs with
// no session at all).
//
// Provider abstraction (R2): createSTT() reads STT providers from the registry
// (src/registry.js, loaded by src/registry-loader.js). Each provider's
// createEngine({settings, manager, log}) returns { provider, ready, transcribe(wav) }.
// The chain is built from batch-capable providers sorted by order; each provider owns
// its own readiness check. Adding a new STT provider = one folder under
// src/providers/stt/<id>/index.js. No switch edits, no chain.push fan-out.

const { pcmToWav } = require('./wav');
const { noopLogger } = require('./logger');
const { listProviders } = require('./registry');
// Ensure STT providers are loaded (idempotent — mirrors store.js pattern).
const { loadProviders } = require('./registry-loader');
loadProviders({ _require: require });

// `settings` is the live store settings (reads stt.model + the local engine block via
// localLoadParams). `opts.manager` is the shared createSttProcessManager singleton —
// passed only when the local engine applies (provider 'local'/'auto'), so cloud-only
// and external-WS users never spin Python. `opts.logger` is the app Pino logger; absent
// in tests -> noopLogger (the param-injection invariant, .claude/docs/conventions.md).
function createSTT(settings, { manager, logger } = {}) {
  const log = (logger && logger.child) ? logger.child({ module: 'stt' }) : (logger || noopLogger);

  // Build the batch chain from the registry: each batch-capable provider creates an
  // engine; ready ones join in order (first success wins on transcribe).
  const sttProviders = listProviders('stt');
  const chain = [];
  for (const desc of sttProviders) {
    if (!desc.capabilities || !desc.capabilities.batch) continue;
    const engine = desc.createEngine({ settings, manager, log });
    if (engine && engine.ready) {
      chain.push({ p: engine.provider, fn: engine.transcribe });
    }
  }

  log.debug({
    providers: chain.map((c) => c.p),
    openai: !!((settings.apiKeys || {}).openai),
    gemini: !!((settings.apiKeys || {}).gemini),
  }, 'STT providers registered');

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        const tStart = Date.now();
        try {
          const text = await c.fn(wav);
          log.debug({ provider: c.p, elapsedMs: Date.now() - tStart, chars: (text || '').length },
            'STT transcription finished');
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
          log.warn({ provider: c.p, error: lastErr.message, elapsedMs: Date.now() - tStart },
            'STT provider failed; trying next');
        }
      }
      return { text: '', error: lastErr };
    },
  };
}

module.exports = { createSTT };
