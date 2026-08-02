<!--
  tier:     long-term
  owner:    claude
  updates:  when a decision is made or superseded
  scope:    compressed ADRs — one entry per architectural decision
  no-grow:  ≤25 active. Keep superseded entries *marked*; prune fully-obsolete ones to a one-line lesson in memory.md
  belongs:  decision + rationale + alternatives rejected + status
  excludes: implementation detail (implementation-plan.md); recurring pitfalls (memory.md)
  migrates: a decision whose rationale becomes a hard rule → conventions.md; an obsolete decision → one line in memory.md
-->

# decisions — compressed ADRs

One entry per decision. Status: `decided` (design locked, may await implementation),
`implemented`, or `superseded` (kept *marked*, then pruned per
[compression-policy.md](compression-policy.md) → a one-line lesson in [memory.md](memory.md)).
Later entries may supersede earlier ones.

## ADR-001 — Audio is captured in the renderer, not main — implemented
**Decision:** mic + meeting audio are captured in the renderer process.
**Rationale:** it reuses cue's own Screen-Recording grant, so there is no separate helper
binary to authorize on macOS.
**Alternatives rejected:** a native audio helper (→ native module + extra permission grant).

## ADR-002 — LLM and STT providers are decoupled — implemented
**Decision:** separate `createLLM` and `createSTT` factories.
**Rationale:** Anthropic has no audio API; a single unified interface would force an awkward
optional-degrees design. STT builds its own fallback chain (openai → gemini).
**Alternatives rejected:** one factory with optional methods; routing STT through the LLM SDK.

## ADR-003 — No build step, no native modules — implemented
**Decision:** plain HTML/CSS/JS, `electron .` with no bundler/transpile/linter, no native
modules.
**Rationale:** avoids postinstall pain across macOS/Windows and keeps the repo small &
readable. Consequence: features like a `.env` loader are hand-rolled (see ADR-012).
**Alternatives rejected:** TypeScript + bundler; `dotenv` (pulls a dep chain for a small feature).

## ADR-004 — Three inputs are kept on separate `you`/`them` channels end-to-end — implemented
**Decision:** mic → `you`, meeting audio → `them`; the channel tag survives transcript →
prompt → render.
**Rationale:** "who said what" is the product's core value; conflating channels breaks every
mode prompt.
**Alternatives rejected:** a single transcript stream with channel prefixes.

## ADR-005 — Nvidia & Ollama reuse the OpenAI SDK via `baseURL` — implemented
**Decision:** one OpenAI-compatible streaming path serves openai/nvidia/ollama, diverging only by
`baseURL`; the OpenAI SDK constructor needs non-empty `apiKey`, so Ollama uses a sentinel `'ollama'`;
the `ready` check bypasses the key for `ollama`.
**Rationale:** avoids per-provider SDKs for OpenAI-compatible gateways; one code path.
**Home:** the shared path is [src/providers/llm/openai-compat.js](../../src/providers/llm/openai-compat.js)
`makeOpenAICompatEngine` (was `streamOpenAI` in the old `src/llm.js` switch; moved by ADR-017). The
sentinel + `ready` gate survive verbatim.
**Alternatives rejected:** per-provider SDKs; treating the sentinel as a real key.

## ADR-006 — faster-whisper runs as a local WebSocket streaming server — implemented
**Decision:** cue is the WS client to a local faster-whisper server (`ws://localhost:9080`),
with a POST batch fallback.
**Rationale:** zero-latency streaming STT, no native modules in cue; the server runs
out of process.
**Alternatives rejected:** a native whisper binding in cue; cloud streaming only.

## ADR-007 — Memory/RAG = rolling summary + user-curated persistent notes — decided (Phase 4)
**Decision:** rolling LLM summary (≤2000 chars) + `settings.memory.notes` injected into
prompts; no embeddings / vector store.
**Rationale:** a local, no-infra memory that fits cue's "plain JS, no deps" stance.
**Alternatives rejected:** an embedding/vector store; cloud RAG.

## ADR-008 — Continuous streaming STT is the default pipeline — implemented
**Decision:** capture never pauses; the assistant tracks live partial + finalized transcripts;
VAD is used only for endpoint/segmentation, not to start transcription; a user may request an
immediate response (Ctrl+Alt+A) at any time without interrupting the transcription stream
(sessions owned by `setCapturing`, never gated by `state.busy`).
**Alternatives rejected:** a batched start/stop pipeline with VAD-gated capture.

## ADR-009 — claude-code skills loaded as instructions, not untrusted data — decided (Phase 4)
**Decision:** cue parses `.claude/skills/*.md` (frontmatter `{name,description}` + body, capped
`MAX_SKILLS_CHARS=8000`) and applies them as **behavioral guidance** (instructions framing —
the opposite of résumé's untrusted-data framing).
**Rationale:** reuse Claude skill authoring conventions; keep the two framing styles explicitly
distinct in the prompt-compose ordering (see [implementation-plan.md](implementation-plan.md)
"Shared: system-prompt composition").
**Alternatives rejected:** skills framed as untrusted data; a separate skills store.

## ADR-010 — Ring-buffered transcript replaces unbounded `transcript=[]` — implemented
**Decision:** `src/transcript.js` `transcriptState = { finals (cap TR_MAX_TURNS=200),
partials:{you,them}, lastSummarizedTs }` replaces the flat array.
**Rationale:** the flat array grew forever → memory pressure in long streams (bug B1); the
`{channel,text,ts}` shape is preserved so `formatTranscript` is unchanged.
**Alternatives rejected:** a hard time-window eviction without a watermark.

## ADR-011 — HTTP errors are normalized to one shape — implemented
**Decision:** `src/errors.js` `normalizeSDKError(err, provider) → {status, code, provider,
message, suggestion}`; `streamX` and `handleSttError` route through it.
**Rationale:** main no longer special-cases each provider's error envelope; user-facing hints
are consistent.
**Alternatives rejected:** per-catch bespoke messages (the prior vague/broken state).

## ADR-012 — `.env` is dependency-free — superseded by ADR-015
**Decision:** `src/env.js` hand-rolls a `.env` parser; `CUE_*` env overrides are runtime-only,
never persisted to `cue-data.json`.
**Rationale:** consistency with ADR-003 (no deps); keeping secrets out of the persisted
settings file.
**Alternatives rejected:** `dotenv` (pulls a dep chain); persisting env into `cue-data.json`.

## ADR-013 — Local STT is a managed Python service over JSON-RPC, engine-agnostic — implemented
**Decision:** local Speech-to-Text runs as a Python process (`python/cue_stt_service.py`) spawned
and managed by a Node manager (`src/stt-process.js`) over line-delimited JSON-RPC on
stdin/stdout (not the external WebSocket of ADR-006). The manager owns venv bootstrap, process
restart-with-backoff + latch, clean shutdown. `src/stt-engine.js` registers engines by id so the
rest of the app (`main.js`, `src/stt-stream.js`) never names one; `auto` prefers the local engine
when its venv is ready. ADR-006's external-WS server remains the `faster-whisper` transport; both
expose the same `{ start, sendAudio, close }` + partial/final surface to `stt-stream`.
**Rationale:** zero-config local STT (users never run `pip`) with no native modules in cue
(ADR-003); the engine seam lets a future whisper.cpp register in one call. CPU-only venv by
default (CUDA is an opt-in manual step) so `npm install` never pulls the CUDA stack.
**Alternatives rejected:** a native whisper binding in cue (native module); ship a bundled Python
(repackaging); route the managed engine through the WS client (two transports, one surface wins).

## ADR-014 — Centralized STT logging: Pino (Node) + Loguru (Python) — implemented
**Decision:** a shared structured logger (`src/logger.js`, Pino singleton) for the Node STT
lifecycle, and Loguru (`python/cue_stt_logging.py`) for the Python service. Console → stderr (fd
2, so it appears in the `npm` terminal, stdout stays the JSON-RPC protocol) + a rotating dated
file under `userData/logs`. Python stderr is one JSON line per record, parsed by the manager and
forwarded through Pino at the matching level (levels survive the process boundary). Config in
`settings.stt.logging` with `CUE_STT_LOG_*` runtime overrides (never persisted).
**Rationale:** STT failures were untraceable — `console.log` only, no levels/timestamps/files;
the Python service's stderr was free-form. Structured logs make "why did transcription hang"
answerable. Param-injected so tests spawn no Pino transport.
**Alternatives rejected:** `electron-log` (native-ish dep, not STT-scoped); raw `console` per file
(no levels/rotation/tracebacks); writing Python logs to a separate file Node can't read.

## ADR-016 — No silent STT timeouts: download/load decoupled + finite bounds — implemented
**Decision:** (1) the local engine *downloads* a model (`model_download`, emits progress) *then*
*loads* it with `local_files_only=true` under a finite timeout — `load` can never block on a silent
network fetch; (2) the batch/cloud `transcribe` is wrapped in a 30s watchdog that releases the
channel lock + surfaces an actionable error; (3) a streaming session that fails mid-capture
degrades its channel to the batch loop in-session; (4) `provider:'local'` with the venv unready
auto-prepares it on first capture.
**Rationale:** every transcription failure previously presented as an infinite, silent "timeout"
— `load` ran at `timeout:0` and downloaded silently (sid never set, PCM dropped); the batch path
had no timeout (a hung SDK call pinned `state.transcribing[ch]` forever); latched sessions dropped
audio until a re-toggle; and 'local' with no venv transcribed nothing. These were root-cause
structural defects, not timeout-tuning problems.
**Alternatives rejected:** increasing timeouts (treats the symptom, the hang is silent either way);
giving up on the local engine (the whole point of ADR-013); dropping the batch path (cloud is the
fallback when local is unavailable).

## ADR-015 — Retire the `.env` system into the Store — implemented
**Decision:** remove `src/env.js` and the `CUE_*` runtime-override path; all config (incl. API
secrets) already lives in the Store (`src/store.js` `apiKeys`). Reverses ADR-012's dependency-free
`.env` precedent, so this ADR is the required logged decision per CLAUDE.md governance.
**Rationale:** the `.env` system is no longer needed — the Store owns all settings, and the `CUE_*`
env path is a redundant seeding layer. Removing it simplifies the boot path and one less config
surface. Python service params (VAD, beam size) are passed via `buildPyLogEnv()` at spawn time
from settings, preserving the env-var interface for the child process without a .env file.
**Status:** implemented. `src/env.js` deleted; `loadDotenv()` removed from `main.js`; all
`LEGACY_ENV_OVERRIDES` and `SCHEMA_ENV_MAP` removed from `store.js`; `.env.example` deleted;
`env` fields removed from config-schema.js. **Alternatives rejected:** keep `.env` as a pure
convenience seeder (redundant with the Store; two config surfaces breeds drift).

## ADR-020 — Plugin-centric provider discovery with core singleton services — implemented (R3)
**Decision:** a unified core module (`src/providers/core/`) owns singleton services (EventBus,
ProviderRegistry, ModelRegistry, CapabilityRegistry, HealthMonitor, CacheManager,
DiscoveryEngine) that orchestrate all provider plugins. Each provider calls `definePlugin()`
(alias `defineProvider` for backward compat) with a rich descriptor: capabilities as
`{ state, source, confidence }`, `configurableSettings` with `settingsPath`/`group`, optional
`skipAutoSwitch`, optional `healthConfig`, and `createEngine`. The legacy `src/registry.js`
becomes a thin facade delegating to core singletons. IPC push events (`providers:spec:push`,
`models:update`, `health:update`, `capabilities:update`, `discovery:progress`) replace
request/response polling — the renderer subscribes to events and updates dynamically from a
unified `providers:spec` handler. Provider/model lists are no longer hardcoded in `store.js` or
the renderer; validation derives from the registry at runtime.
**Rationale:** ADR-017's two-bucket registry was built for LLM only (R1). Extending to 17
providers (LLM + STT) with capabilities, health checks, model discovery, and dynamic UI
demanded a richer orchestration layer. The core module replaces ad-hoc registry access with
typed services, adds event-driven push to the renderer, and eliminates hardcoded provider
lists from store.js and renderer — a single `definePlugin()` call in a provider folder
is the only entry point.
**Alternatives rejected:** extending the bare Map-based registry (no events, no health, no
model management — adding those piecemeal would recreate the core piecemeal); a separate
plugin host process (violates the "no native modules, no build step" invariant).

## ADR-017 — Shared provider descriptor shape, two registries (LLM + STT) — implemented (R1)
**Decision:** one self-describing descriptor shape (`id, displayName, providerType, capabilities,
supportedModels, configurableSettings, defaultSettings, order, createEngine` + optional
`createStreamSession` for STT), registered by type into TWO buckets (`'llm'` | `'stt'`) keyed
`${type}:${id}`. Adding a provider = one folder under `src/providers/<type>/<id>/index.js` calling
`defineProvider`, loaded by folder discovery (`src/registry-loader.js`). `createLLM`/Settings
read the registry; no provider switch, no DEFAULTS fan-out (store folds `defaultSettings`), no
Settings-UI edits (R3 auto-builds from `configurableSettings`).
**Rationale:** preserves ADR-002 (LLM/STT decoupled — same shape, never-merged runtime paths) while
removing the per-provider `if/else` switches and fan-out that made "add a provider" touch 6 files.
`createEngine` lazy-requires its SDK so store folds defaults without pulling network SDKs, keeping
tests electron- and dep-free (ADR-003). `renderSafe` strips functions so descriptors cross IPC for
the Settings UI. Two buckets over one merged registry: the merged "future-proof" option would braid
deliberately-decoupled paths and risk the working LLM/image flow.
**Alternatives rejected:** one unified registry (merges decoupled domains — the ADR-002 risk); an
STT-only plugin model (leaves the LLM switch in place); a JSON manifest without `createEngine` in
the descriptor (the engine belongs with the metadata it describes).
**Status:** implemented for LLM (R1a spine, R1b 5 providers, R1c `createLLM`+store delegation).
STT migration (R2) uses the same shape — `createStreamSession` is already in the validator.

## ADR-018 — Settings validation is advisory, non-blocking — implemented
**Decision:** `store.setSettings(patch)` runs `validatePatch()` before merging: schema `validate()`
(type coercion, numeric clamping — corrective) plus semantic checks (API-key prefixes, STT/LLM
provider ids — advisory). Advisory errors are logged, never block the save.
**Rationale:** a bad API key or unknown provider id should warn without breaking saving (a blocked
save traps the user in a broken state with no escape). Schema clamping stays corrective so
out-of-range values can't poison the app.
**Alternatives rejected:** hard-fail validation (blocks saving); no validation (silent bad state).

## ADR-019 — Shutdown flushes all pending state synchronously — implemented
**Decision:** the `will-quit` handler flushes every pending state: stop the memory runner + persist
the rolling summary, close streaming STT sessions (sends `stream_stop`/Terminate), stop the batch
flush loop, tear down the STT manager, then flush the Pino transport. All best-effort synchronous.
**Rationale:** quitting mid-capture previously lost the rolling memory summary (only persisted on
`setCapturing(false)`) and leaked the Python process. Synchronous best-effort keeps the handler
simple — Electron gives no way to await async work in `will-quit`, and a failure must never hang
quit.
**Alternatives rejected:** `before-quit` with `e.preventDefault()` + async drain (adds a quit-delay
failure mode for marginal benefit); leaving teardown to the renderer's stop button (missed on quit
shortcuts / window close).
