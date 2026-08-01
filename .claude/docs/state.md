<!--
  tier:     current
  owner:    claude
  updates:  per session — REWRITE, do not append. Never transcribe a diff; point to git
  scope:    branch progress, in-flight, next, blockers, session discoveries
  no-grow:  ~80 lines. The "Session discoveries" subsection is cleared at commit time
  belongs:  a stable progress snapshot that survives between sessions
  excludes: implementation detail (implementation-plan.md); decisions (decisions.md)
  migrates: session discoveries → memory.md / decisions.md at commit, then delete the entry here
-->

# state — current project state (snapshot)

Rewritten per session, not appended. **For live working-tree state run `git status` and
`git diff` — never transcribe a volatile diff here.** This file captures *progress* and
*next*; it is not a transcript.

## Branch
- `main` — latest commit: `d04ad29 feat: add external WebSocket STT provider and local faster-whisper support`.

## Completed (this session)
- **Groq STT provider.** New batch provider at `src/providers/stt/groq/` (order 25, between
  OpenAI and Gemini). Uses `openai` npm SDK with custom `baseURL: api.groq.com/openai/v1`.
  Supported models: whisper-large-v3-turbo (default), whisper-large-v3, distil-whisper-large-v3-en.
  API key field added to Settings UI. Provider auto-registers via folder discovery.
- **AssemblyAI universal-streaming STT provider.** New provider at
  `src/providers/stt/assemblyai/` (order 15, streaming only, v3 WebSocket protocol at
  `wss://streaming.assemblyai.com/v3/ws`). Hand-rolled using WsClient from external-ws
  with `Authorization` header for API key auth. 18 tests in `test/assemblyai-provider.test.js`.
- **Audio resampling safety net.** `src/resample.js` (Int16 linear interpolation resampler,
  dual-format: browser global + Node module) + `renderer/audio-capture.js` (shared
  AudioCapture class replacing duplicated inline capture in renderer.js). Warns once per
  AudioContext when sample rate mismatches. 11 tests in `test/resample.test.js`.
- **WsClient headers extension.** Generic `headers` option added to WsClient in
  `src/providers/stt/external-ws/session.js` (backward-compatible, used by AssemblyAI).
- **resolveProvider generalization.** Generic exact-id match in `src/stt-stream.js`
  prevents explicit provider names (like 'assemblyai') from accidentally matching a
  different provider via capability-based fallback.

## Completed (prior, committed)
- R1a–R1c: registry foundation, LLM providers into folders, createLLM + store fold.
- R2: STT providers into folders (faster-whisper, openai, gemini, external-ws).
- P1–P3: transcription fixes, logging migration, categorized Settings tabs.
  `defineProvider`. Shared: [src/providers/llm/openai-compat.js](../../src/providers/llm/openai-compat.js)
  (one OpenAI-compatible streaming path for openai/nvidia/ollama; diverges only by `baseURL` +
  the ollama sentinel) and [src/providers/llm/shared.js](../../src/providers/llm/shared.js) (lazy
  `child('llm')` logger guard + `stripDataUrl`, kept BELOW llm.js in the require graph to avoid a
  cycle). Anthropic/gemini ports are verbatim from the old `streamX` functions.
  [test/providers.test.js](../../test/providers.test.js) asserts the 5 register + that folding
  their `defaultSettings` reproduces today's literal DEFAULTS exactly.
- **R1c — createLLM + store fold.** [src/llm.js](../../src/llm.js) is now a thin
  `getProvider('llm', settings.provider).createEngine({settings})` delegate (the `if/else` switch
  + `streamX` functions deleted). [src/store.js](../../src/store.js) folds every registered LLM
  provider's `defaultSettings` into DEFAULTS at load (`foldLlmDefaults` + `BASE_DEFAULTS`) — the
  provider descriptors are now the single source for `apiKeys`/`models`/`ollama` defaults.
  `main.js` calls `loadProviders()` at startup (idempotent; store already triggers it at require).
  **238/238 tests pass.**

## In flight
- Nothing mid-edit; R2 is complete and verified (258/258 tests pass, no import cycles).

## Next
1. **R3 — auto-generated provider Settings UI.** providers:spec IPC -> renderer builds provider
   buttons + key/baseURL/model fields + provider-specific options from configurableSettings.
   See HANDOFF R3.
2. Then R4 (shortcuts), R5 (prompts UI), R6 (popup), R7 (logging), R8 (docs compression).

## Blockers / open questions
- Manual UI reachability check for R3/R5/R6/R7 needs the user's machine (headless Electron can't
  open the panel). Not blocking R2 (uncoupled).
- `apiKeys.deepgram` is an STT key seeded as a literal in `store.js BASE_DEFAULTS` until R2 wires a
  deepgram STT provider to contribute it (matches ADR-002 — STT defaults live in store today).

## Session discoveries
- Real provider modules + `_resetProviders()`-between-cases are incompatible: Node caches a
  required module by path, so the top-level `defineProvider()` never re-runs on re-require —
  resetting the registry mid-suite leaves it empty for every later case. Real-provider tests load
  ONCE at module scope (per-file worker isolation protects other suites). Recorded in
  [memory.md](memory.md).
- `logger.js` is require-safe: it imports `pino` at load but the worker transport only spawns at
  `getLogger()` time, so requiring it (and thus provider→shared→logger) in the store-load path
  pulls no transport and no Electron. (Promote to conventions if another store-load dep tempts a
  transport-spawning require.)
