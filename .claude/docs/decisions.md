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
**Decision:** `streamOpenAI` is reused for nvidia and ollama by swapping `baseURL`; the OpenAI
SDK constructor needs non-empty `apiKey`, so Ollama uses a sentinel `'ollama'`; the `ready`
check bypasses the key for `ollama`.
**Rationale:** avoids per-provider SDKs for OpenAI-compatible gateways; one code path.
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

## ADR-012 — `.env` is dependency-free — implemented
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

## ADR-015 — Retire the `.env` system into the Store — decided (Phase 8)
**Decision:** remove `src/env.js` and the `CUE_*` runtime-override path; all config (incl. API
secrets) already lives in the Store (`src/store.js` `apiKeys`). Reverses ADR-012's dependency-free
`.env` precedent, so this ADR is the required logged decision per CLAUDE.md governance.
**Rationale:** the `.env` system is no longer needed — the Store owns all settings, and the `CUE_*`
env path is a redundant seeding layer. Removing it simplifies the boot path and one less config
surface. A one-time import of an existing `userData/.env` seeds the Store on first boot post-change.
**Status:** decided; implementation deferred to Phase 8 so P1/P2 don't add new `CUE_*` consumers
that would have to be re-migrated. **Alternatives rejected:** keep `.env` as a pure convenience
seeder (redundant with the Store; two config surfaces breeds drift).
