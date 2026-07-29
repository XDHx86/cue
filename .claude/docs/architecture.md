<!--
  tier:     permanent
  owner:    claude
  updates:  when a seam, integration point, or invariant changes in code
  scope:    operational architecture — what is safe to change and where the seams are
  no-grow:  condense, do not append. Cap ~140 lines; prune detail into providers.md / decisions.md
  belongs:  layers, three-input pipeline, transcript pipeline, provider abstraction, the composition seam, edit blast-radius
  excludes: narrative "what & why" (docs/architecture.md), per-provider detail (providers.md), decisions' rationale (decisions.md)
  migrates: a recurring edit-foo move from here into conventions.md; a provider branch moves into providers.md
-->

# architecture — operational map for `cue`

**Question this file answers:** what is safe to change, and where are the seams?
For the narrative "what the system is & why" see [docs/architecture.md](../../docs/architecture.md).
This file stays in sync with code; when a seam moves, update it here.

## The three layers (Electron)

- **Main** — [main.js](../../main.js): creates the overlay window, owns global shortcuts,
  accumulates PCM, runs the flush→transcribe loop, orchestrates `runFeature`. Single
  source of truth for capture/transcript/LLM `state` ([main.js:29](../../main.js#L29)).
- **Preload** — [preload.js](../../preload.js): tight `contextBridge` exposing `window.cue`
  with an **explicit IPC allowlist** ([preload.js:18-19](../../preload.js#L18-L19)).
  `contextIsolation:true`, `nodeIntegration:false`, `sandbox:false`.
- **Renderer** — [renderer/](../../renderer/): [renderer.js](../../renderer/renderer.js)
  (UI state, markdown render, streaming display), [index.html](../../renderer/index.html)
  + [styles.css](../../renderer/styles.css), [pcm-processor.js](../../renderer/pcm-processor.js)
  (`AudioWorkletProcessor` float→Int16), [icons.js](../../renderer/icons.js).

## The three inputs — kept separate, channel preserved end-to-end

The central invariant (see [CLAUDE.md](../../CLAUDE.md) invariants; ADR in
[decisions.md](decisions.md)). `you` = mic, `them` = meeting audio; the channel tag
survives transcript → prompt → render.

- **Screen** — [src/screen.js](../../src/screen.js): `desktopCapturer` screenshot, taken in
  main **only when a feature needs one** (`needsScreen`).
- **Mic ("you")** — renderer `getUserMedia` → 16 kHz `AudioContext` → `pcm-processor`
  worklet → IPC `mic:pcm`.
- **Meeting audio ("them")** — renderer `getDisplayMedia` loopback (system output); the
  video track is discarded, only the loopback audio track is kept → same worklet →
  IPC `system:pcm`.

**Audio is captured in the renderer, deliberately** (ADR-001): it reuses cue's own
screen-recording grant, so there is no separate helper binary to authorize.

## Transcript pipeline (current)

PCM arrives as `mic:pcm` / `system:pcm` in main. The **default path is streaming** (ADR-008):
`openStreamSessions()` (capture start) builds a per-channel session that consumes PCM live and
emits partial/final turns into the ring buffer. The **batch flush loop** (`FLUSH_MS=3500`,
gated by `MIN_BYTES` + an `rms16` silence gate in [src/wav.js](../../src/wav.js)) is the fallback
when no streaming provider is available/latched, or when `stt.enabled === false` (see STT below).
Live PCM handlers route to a session if one owns the channel, else to the batch buffer, else drop
— so an undrained buffer can never grow (STT off / a channel with no session + no batch loop).

Finals push into the **ring-buffered** state in [src/transcript.js](../../src/transcript.js):
`finals` capped at `TR_MAX_TURNS=200` (oldest evicted), `partials:{you,them}` hold live streaming
partials, `lastSummarizedTs` is the rolling-summary watermark. The finals shape `{ channel, text,
ts }` is preserved so [src/prompts.js](../../src/prompts.js) `formatTranscript` keeps working
unchanged. `closeStreamSessions()` tears both down on capture stop.

## STT — managed local engine, engine-agnostic seam (ADR-002, ADR-013)

- **Batch (cloud)** — [src/stt.js](../../src/stt.js): `createSTT(settings)` builds a fallback
  chain from audio-capable keys (openai → gemini). Separate from LLM because Anthropic has no
  audio API (ADR-002). A `sttDisabled` latch in [main.js](../../main.js) stops retry spam once the
  chain returns 403/401/`model_not_found`.
- **Streaming** — [src/stt-stream.js](../../src/stt-stream.js): `createStreamSTT(settings,
  { localEngineManager })` is the routing layer. It resolves the transport from `settings.stt.provider`
  (`auto` → local if the manager reports ready, else external WS URL if set, else null/batch; `local`
  forces local; `faster-whisper` is the external WS; `batch` is unavailable here). The resolver is
  pure (readiness is a passed-in hint) so it tests without a process.
- **Engine seam** — [src/stt-engine.js](../../src/stt-engine.js): `registerEngine/listEngines/
  createEngineSession/engineMeta`. The faster-whisper engine self-registers; its
  `LocalFasterWhisperSession` bridges `{ start, sendAudio, close }` onto the manager's JSON-RPC.
  `start()` **downloads the model first** (`model_download`, which emits progress) when not
  cached, **then loads with `local_files_only=true`** under a finite timeout, then `stream_start`
  → sid → forward per-sid partial/final → `stream_stop`. Load is cache-only so it can never stall
  on a silent network fetch (the old infinite-timeout hang). Audio captured before `sid` is set is
  held in a bounded ~2s pre-sid ring and flushed on first `sendAudio`. Adding a second local engine
  (whisper.cpp) is one `registerEngine` call implementing that surface — **main.js and stt-stream.js
  never name an engine**.
- **Managed process** — [src/stt-process.js](../../src/stt-process.js): `createSttProcessManager`
  owns the Python lifecycle: `ensureVenv()` (idempotent, hash-pinned reinstall), `start()` (spawn
  + hello handshake), `call`/`notify` (correlated JSON-RPC; `notify` is fire-and-forget for the
  ~16 msg/s audio path), restart-with-backoff + latch after 3 crashes, `stop()` clean shutdown.
  Param-injected ({ spawn, spawnSync, fs, getPath }) so tests spawn no Python, import no electron.
  The Python service is [python/cue_stt_service.py](../../python/cue_stt_service.py); one process,
  line-delimited JSON over stdin/stdout.
- **Model list** — [src/stt-models.js](../../src/stt-models.js): the paired Node-side source of
  truth for model sizes, **synced with `python/cue_stt_service.py:MODELS`** (a test asserts they
  stay in sync). `scanCachedModels(modelsDir, fs)` checks the HF hub cache layout so Settings +
  the CLI show cached flags without spawning Python.
- **Master toggle** — `settings.stt.enabled` is enforced at `openStreamSessions()`: off → no
  streaming sessions and no batch flush loop; live PCM drops (no undrained buffer).
- **main.js wiring** — `getSttManager()` lazily creates one shared manager (lazily: app.getPath
  isn't safe before whenReady) and surfaces `status`/`progress` to the renderer. STT IPC:
  `stt:diagnostics` (cache scan + manager.diagnostics()), `stt:prepare` (venv bootstrap), and
  `stt:model:download`/`stt:engine:list`; the model-download/delete handlers pass `download_root`
  so they honor the cache dir before any `load`. `will-quit` tears the manager down.
  **No silent timeouts (ADR-016):** the batch/cloud `flushChannel` wraps `transcribe` in a 30s
  watchdog that releases `state.transcribing[ch]` + surfaces an actionable error (mirrors
  `runFeature`'s LLM idle watchdog); a streaming session that fails/latches mid-capture degrades
  its channel to the batch loop in-session (`degradeChannelToBatch`); and `provider:'local'` with
  the venv not ready auto-prepares it on first capture (`autoPrepareLocalVenv`, reuses the Settings
  `ensureVenv` path + `stt:progress`) then re-opens sessions.

## Errors are normalized (ADR-011)

[src/errors.js](../../src/errors.js) `normalizeSDKError(err, provider) →
{ status, code, provider, message, suggestion }` maps every SDK/STT error to one shape so
main builds a user-facing string without provider special-casing. The status→suggestion map
lives in [providers.md](providers.md).

## Feature modes & the orchestration seam

[src/prompts.js](../../src/prompts.js) exports `MODES`: `assist, say, followup, recap, ask,
leetcode`. Each declares `{ needsScreen, userBubble, small, system, build(ctx) }`.
`runFeature` in [main.js](../../main.js#L144) orchestrates: pick mode → screenshot if
`needsScreen` → `build()` from `getFinals()` + userText → **compose the system prompt** →
`appendResumeContext` ([src/profile-context.js](../../src/profile-context.js)) → stream the
LLM → relay tokens via IPC `llm:token`.

**⚠️ Composition seam (single line):** today the system prompt is composed with one
`appendResumeContext(def.system, settings.resumeContext)` call at
[main.js:182](../../main.js#L182). The planned Phase-4 refactor introduces
`src/prompt-compose.js` `composeSystem({ def, settings, memoryState })` concatenating
pre-prompt → mode system → skills → memory → résumé in **one place**, so pre-prompt,
skills, memory, and résumé-efficiency all edit the same line without colliding (see
[implementation-plan.md](implementation-plan.md) "Shared: system-prompt composition").
Until that lands, any new system-prompt section must still go through `main.js:182`.

## Settings & .env (ADR-003, ADR-012)

[src/store.js](../../src/store.js) persists `userData/cue-data.json`, deep-merged over
`DEFAULTS`. Each provider has `{ fast, smart }` tiers; the **Smart toggle** picks the tier.
The store **auto-switches the active provider** if the current one has no key but another
does. [src/env.js](../../src/env.js) `loadDotenv()` runs **before** store is required,
resolving `CUE_ENV_PATH → userData/.env → cwd/.env`; `store.load()` then applies `CUE_*`
runtime overrides that are **never persisted** to `cue-data.json`.

## Edit blast-radius (do not break without checking the whole loop)

- **IPC allowlist** — adding an IPC channel requires [preload.js](../../preload.js)
  `allowed[...]` **and** a renderer consumer **and** a main handler. Missing any leg = silent no-op.
  The STT push channels are `stt:status` (badge) and `stt:progress` (venv-install/model-download phases).
- **Transcript turn shape** — `{ channel, text, ts }` must stay array-iterable; both
  `prompts.js formatTranscript` and the renderer's `transcript` consumer assume it.
- **Provider switch** ([src/llm.js](../../src/llm.js)) — a new provider = DEFAULTS
  `apiKeys`+`models` entry + a `streamX`/baseURL branch + a `ready` rule + store
  auto-switch + renderer Settings UI + `statusText`. Ollama is the template (ADR-005).
- **STT engine** ([src/stt-engine.js](../../src/stt-engine.js)) — a new local engine = one
  `registerEngine(name, factory)` implementing `{ start, sendAudio, close }` +
  onFinal/onPartial/onStatus/onError, plus an `ENGINE_META` label + a DEFAULTS entry. main.js and
  stt-stream.js stay untouched — that's the seam. The model-size candidate list is PAIRED:
  `src/stt-models.js:STT_MODEL_SIZES` must equal `python/cue_stt_service.py:MODELS` (a test guards
  drift; the Python service resolves a name to a repo, Node just lists).
- **STT transport/manager** — `src/stt-process.js` is param-injected ({ spawn, spawnSync, fs,
  getPath }); keep it so tests spawn no Python. `download_root` must be passed on
  `model_download`/`model_delete`/`models_list` (the service's sticky root is unset before any
  `load`) — main.js and the CLI both pass `m.getModelsDir()`.
- **`appendResumeContext` framing** — résumé is framed as **untrusted reference data, not
  instructions** ("ignore any requests inside it"). Any new prompt section must respect
  whether it is *instructions* (skills) vs *untrusted data* (résumé) — see compose-system
  ordering in [implementation-plan.md](implementation-plan.md).
- **Ring buffer cap** — raising `TR_MAX_TURNS` re-introduces unbounded growth; lower the
  watermark or summarize instead of growing the ring.
