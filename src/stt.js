// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable path is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
//
// This is the BATCH path (one WAV → one transcription). Streaming STT (the managed
// Python engine or the external faster-whisper WS server) lives in src/stt-stream.js;
// when a streaming provider is configured and active, main.js sends live PCM to a
// streaming session instead of this loop, and only uses createSTT() as a
// degrade-to-batch fallback (when a streaming session latches, or capture runs with
// no session at all).
//
// Provider abstraction: createSTT() builds an ordered chain of `{ p, fn }` entries.
// The local managed faster-whisper provider sits first (free, low-latency) when the
// Python service is bootstrapped — it reuses the SAME process manager + JSON-RPC
// client (src/stt-process.js) as the streaming engine (src/stt-engine.js) and calls the
// service's `transcribe` method directly over stdin/stdout. No HTTP server, no
// fasterWhisperURL — the obsolete HTTP batch path (POST WAV to /transcribe) is gone;
// the fasterWhisperURL field now only selects the EXTERNAL user-run WS server in the
// streaming resolver (src/stt-stream.js).

const { pcmToWav } = require('./wav');
const { noopLogger } = require('./logger');
const { localLoadParams, MODEL_LOAD_TIMEOUT_MS } = require('./stt-engine');

// The local provider's transcribe RPC timeout. Matches STT_TRANSCRIBE_TIMEOUT_MS in
// main.js (the outer watchdog that races every provider) so the local provider gets the
// same budget cloud providers enjoy (their SDKs aren't inner-bounded at the manager's
// 15s default). The outer watchdog still governs the whole chain.
const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;

async function transcribeOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: model || 'whisper-1' });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user', parts: [
        { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
      ]
    }]
  });
  return ((res && res.text) || '').trim();
}

// Local faster-whisper batch transcription via the managed Python service's JSON-RPC
// `transcribe` method (python/cue_stt_service.py). `wav` is a 44-byte-header WAV; the
// Python side strips the RIFF header and decodes Int16 @16kHz. The model must be
// loaded before transcribe(): if the streaming engine has already loaded it
// (manager.getLastLoad set, the common degrade-after-streaming case) we go straight
// through; otherwise we load — cache-only (local_files_only), never downloading in
// band — mirroring the engine's never-stall-on-a-silent-fetch contract (ADR-013). A
// missing model raises FAST and the chain falls back to the next provider.
async function transcribeFasterWhisperLocal(manager, settings, wav, log) {
  if (!(await manager.ensureRunning())) throw new Error('STT service not running');
  const params = localLoadParams(settings, manager, null); // null language → matches streaming's lastLoad
  const sttCfg = (settings && settings.stt) || {};
  const loadTimeout = sttCfg.modelLoadTimeoutMs || MODEL_LOAD_TIMEOUT_MS;
  const transcribeTimeout = sttCfg.transcribeTimeoutMs || LOCAL_TRANSCRIBE_TIMEOUT_MS;
  const last = manager.getLastLoad();
  if (!last || JSON.stringify(last) !== JSON.stringify(params)) {
    log.debug({ model: params.name, device: params.device, compute_type: params.compute_type },
      'STT rpc → load (cache only; model not loaded)');
    await manager.call('load', params, { timeout: loadTimeout });
    manager.setLastLoad(params);
    log.debug({ model: params.name }, 'STT rpc ← load');
  }
  log.debug({ method: 'transcribe', bytes: wav.length, model: params.name }, 'STT rpc → transcribe');
  const t0 = Date.now();
  const res = await manager.call('transcribe', { wav_b64: wav.toString('base64'), language: params.language },
    { timeout: transcribeTimeout });
  const text = ((res && typeof res.text === 'string') ? res.text : '').trim();
  log.debug({ method: 'transcribe', elapsedMs: Date.now() - t0, chars: text.length }, 'STT rpc ← transcribe');
  return text;
}

// `settings` is the live store settings (reads stt.model + the local engine block via
// localLoadParams). `opts.manager` is the shared createSttProcessManager singleton —
// passed only when the local engine applies (provider 'local'/'auto'), so cloud-only
// and external-WS users never spin Python. `opts.logger` is the app Pino logger; absent
// in tests → noopLogger (the param-injection invariant, .claude/docs/conventions.md).
function createSTT(settings, { manager, logger } = {}) {
  const log = (logger && logger.child) ? logger.child({ module: 'stt' }) : (logger || noopLogger);
  const keys = (settings && settings.apiKeys) || {};
  const sttCfg = (settings && settings.stt) || {};
  const whisperModel = sttCfg.model || settings.sttModel || 'whisper-1'; // sttModel: legacy (pre-Phase-3)

  // Don't register the local provider until the manager's venv is bootstrapped — same
  // readiness hint the streaming resolver uses (isVenvReady), so a user without Python
  // set up isn't promised a transcription that just errors, and `available` stays
  // cloud-driven. ensureVenv() flips this lazily; once true, the provider warms the
  // model on first batch call (cache-only load, above).
  const localReady = !!(manager && manager.isVenvReady && manager.isVenvReady());

  const chain = [];
  // Local managed faster-whisper first (free, low-latency) when the Python service is
  // bootstrapped — same local-first order the streaming path prefers (src/stt-stream.js).
  if (localReady) chain.push({ p: 'faster-whisper', fn: (wav) => transcribeFasterWhisperLocal(manager, settings, wav, log) });
  if (keys.openai) chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, whisperModel) });
  if (keys.gemini) chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });

  log.debug({
    providers: chain.map((c) => c.p),
    localReady, openai: !!keys.openai, gemini: !!keys.gemini,
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
    }
  };
}

module.exports = { createSTT };
