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
- `main` — latest commit: `8b372c4 feat: add OmniRoute LLM and STT providers with local health checks`.
  R3 plugin discovery system complete in working tree (uncommitted).

## Completed (this session)
- **R3 — Plugin-centric Provider & Model Discovery System.** Full discovery architecture
  under `src/providers/core/` (EventBus, Model, CapabilityRegistry, CacheManager,
  PluginInterface, ProviderRegistry, ModelRegistry, HealthMonitor, DiscoveryEngine,
  7 normalization adapters). All 17 providers migrated to `definePlugin()` with rich
  capabilities, `settingsPath`, `group`, `skipAutoSwitch`. Hardcoded provider/model
  lists eliminated from store.js, renderer/index.html, renderer/renderer.js. New IPC
  channels: `providers:spec`, `providers:spec:push`, `models:update`, `health:update`,
  `discovery:progress`, `capabilities:update`. Renderer builds provider UI dynamically
  from spec. 88 tests pass across 4 test files. `src/registry.js` is a backward-compat
  facade delegating to core singletons.
- **Groq LLM provider.** New LLM provider at `src/providers/llm/groq/` (order 4). Reuses
  `makeOpenAICompatEngine` with `baseURL: https://api.groq.com/openai/v1`. Models: Llama 3.1
  8B Instant (fast), Llama 3.3 70B Versatile (smart). Same API key powers Groq STT.
  `ready = !!apiKey && !!model` (remote API). Npm order: nvidia→5, ollama→6.
- **OmniRoute LLM + STT providers.** New dual-pipeline provider at `src/providers/llm/omni/`
  and `src/providers/stt/omni/`. Local AI gateway (localhost:20128, OpenAI-compatible, no API
  key needed). LLM: `auto` model for free routing across 290+ providers. STT: batch Whisper
  via `audio.transcriptions`. Ready reflects actual gateway availability via `local-health.js`.
- **Ollama STT provider.** New STT provider at `src/providers/stt/ollama/` (order 50). Delegates
  to the managed faster-whisper engine — same manager, same session, different id. Only activates
  when explicitly selected (never interferes with `auto`).
- **Local health check module.** `src/providers/local-health.js` — lightweight HTTP health
  cache for local services (OmniRoute, Ollama, faster-whisper). Synchronous `isReady(id)` for
  provider `createEngine`; async `checkAll()` populates cache; 15s periodic re-check so
  services started after cue are detected. Wired into main.js at startup, `settings:set`,
  and `will-quit`.
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
- **Graceful shutdown.** Enhanced `will-quit` handler in `main.js` that stops memory
  runner, persists rolling summary, closes streaming sessions, stops flush loop before
  STT manager stop and logger flush.
- **Settings validation.** `validatePatch()` in `store.js` validates API key formats,
  STT provider ids, LLM provider ids, and schema constraints on every `setSettings()` call.
  9 tests in `test/store-defaults.test.js`.
- **Logging settings in Advanced UI.** 5 new schema entries in `config-schema.js`
  (level, logDir, console, file, pretty) under "Logging" section in Advanced tab.

## Completed (prior, committed)
- R1a–R1c: registry foundation, LLM providers into folders, createLLM + store fold.
- R2: STT providers into folders (faster-whisper, openai, gemini, external-ws).
- P1–P3: transcription fixes, logging migration, categorized Settings tabs.

## In flight
- Nothing mid-edit.

## Next
1. R4 (shortcuts), R5 (prompts UI), R6 (popup), R7 (logging config), R8 (docs compression).

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
