<!--
  tier:     long-term
  owner:    claude
  updates:  when a dev-facing pitfall recurs (not the first time — that's memory.md)
  scope:    DEV troubleshooting (code/build/runtime). User-facing troubleshooting is in README, not here
  no-grow:  ≤40 entries, terse cause→check→fix. Prune any entry folded into a convention or once the code removes the pitfall
  belongs:  how to diagnose a dev problem in this repo
  excludes: user setup steps (README), one-off lessons (memory.md), architecture (architecture.md)
  migrates: a 3rd recurrence of an entry → conventions.md as a hard rule
-->

# troubleshooting — developer pitfalls

**Dev-facing only.** End-user setup/troubleshooting lives in [README.md](../../README.md) — do
not duplicate it here. Format: symptom → check → fix.

## STT / transcription
- **Silent transcript / nothing transcribed** — check the transport first. With `local`/`auto`:
  `npm run stt:status` (or Settings → Speech-to-Text → Diagnostics) — "venv not created" →
  `npm run stt:setup`; a model missing → `npm run stt:download -- small`; `stt.enabled === false`
  short-circuits `openStreamSessions` (no sessions, no batch loop). With cloud: no audio-capable
  key (need OpenAI-Whisper or Gemini; Anthropic has no STT), macOS screen-recording grant missing,
  or an OpenAI project key restricted to chat-only → 403 on Whisper. From code: check
  `sttStreamDisabled` (stream latch) and `sttDisabled` (batch latch) in main.js, the
  `createStreamSTT` resolver in `src/stt-stream.js`, and `createSTT` in `src/stt.js`.
- **Model downloaded but Settings still shows it uncached** — the download didn't honor
  `download_root`; `model_download`/`model_delete` must pass `m.getModelsDir()` (the service's
  sticky root is unset before any `load`). `npm run stt:status` prints the cache dir.
- **`handleSttError` shows a vague message** — route through `normalizeSDKError` so
  the status branches to the right suggestion; do not hand-roll per-status strings.
- **STT tests spawn Python or import Electron** — `src/stt-process.js` / `src/stt-engine.js` must
  stay param-injected ({ spawn, spawnSync, fs, getPath }); the engine session tests use a fake
  manager answering JSON-RPC with canned results.
- **Node candidate model list ≠ Python `MODELS`** — `src/stt-models.js:STT_MODEL_SIZES` and
  `python/cue_stt_service.py:MODELS` drifted apart; `test/stt-models.test.js` should have caught
  it — update both sides to match.

## Tests
- **`npm test` fails or hangs on an `electron` import** — a tested module imported `electron`;
  param-inject like `src/profile-context.js`. Tests are pure-Node (`node --test`).
- **Adding a test for an electron-dependent module** — keep the logic in a pure module that
  takes injected deps; test the pure module. Mirror `test/transcript.test.js` / `test/env.test.js`.

## Streaming / UI
- **UI pins busy (`state.busy` forever) after a dropped/hung stream** — the Phase-0a 30 s
  watchdog should emit `llm:error` and release `state.busy`. Any new code path that
  short-circuits `runFeature`'s `finally` must still let the watchdog fire.
- **A new renderer surface doesn't receive clicks / or steals them everywhere** — add it to
  the `elementFromPoint` hit-test selector (the handler is rAF-throttled, don't regress to
  unthrottled).
- **Memory climbs during a long capture** — confirm the ring cap `TR_MAX_TURNS=200` is in
  effect; don't raise it — summarize instead (Phase 4 rolling summary).

## Windows / overlay
- **cue vanishes under Zoom's share overlay on Windows** — must use
  `setAlwaysOnTop(true,'screen-saver',1)` + all-workspaces; the default level sits below Zoom
  (Phase 0b fix).

## Config / env
- **`.env` key not applied** — `loadDotenv()` must run before `require('./src/store')`. Env
  overrides are runtime-only and never written to `cue-data.json`; a shell-set var wins over
  `.env`. Set `CUE_ENV_DEBUG=1` for the loader trace.
- **OpenAI SDK constructor throws on missing apiKey** — key-less gateways need a non-empty
  sentinel (Ollama: `'ollama'`) + a `ready` bypass; see ADR-005.

## Docs (meta)
- **Where's the live working-tree state?** — `git status` / `git diff`. `state.md` intentionally
  does not transcribe diffs (anti-drift; see [compression-policy.md](compression-policy.md)).
- **CLAUDE.md and a perma doc disagree** — the perma doc is canonical; fix CLAUDE.md's pointer.
