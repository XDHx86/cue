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
- `feat/mvp-overhaul` — **15 commits ahead of `main`**.
- Goal: the "features & bug-fix overhaul" defined in [implementation-plan.md](implementation-plan.md)
  (13 features / 2 bugs, dependency-ordered phases). Four design decisions are locked
  (ADR-006…009).

## Completed (committed)
- **Phase 0a — B1 re-render/memory** (`5422c30`, `a3ad3f0`, `cf8debb`, `8cbd467`): per-token
  span coalescing via rAF, click-through throttle, ring-buffered transcript
  (`src/transcript.js`), 30 s stream-idle watchdog.
- **Phase 0b — B2 Zoom overlay** (`2faec2b`): Windows `'screen-saver',1` z-order +
  all-workspaces; primary-display source selection.
- **Phase 1 — `.env` system** (`b10fa03`): `src/env.js` dependency-free loader; `CUE_*`
  runtime overrides (never persisted).
- **Phase 6 — HTTP errors** (`fdbe892`): `src/errors.js` `normalizeSDKError` / `userMessage`.
- **Phase 2 — F3 Ollama provider** (`48c6552`): `apiKeys.ollama='ollama'` sentinel (NOT a real
  key), `models.ollama`, `ollama.baseURL`; ollama routes through `streamOpenAI` with the
  sentinel + baseURL; `createLLM` `ready` bypasses the apiKey gate for ollama; ollama is
  **deliberately NOT in `validProviders`**. Renderer: Ollama button + disabled key field + base-URL
  field; `statusText` lists only real keys. Test: `test/store-defaults.test.js`.
- **Docs tree** (`ae2e64d`, `5ec4a78`): `docs/architecture.md`, `docs/contributing.md`,
  `docs/release.md` + README "Further documentation" + "Use Ollama". Corrected an inherited
  inaccuracy (`.claude/docs/` is gitignored → NOT version-controlled; README now says so).
- **Phase 3 — F4 streaming STT + F6 continuous pipeline + live strip + F13 Ctrl+Alt+A**
  (`93bcf58`, `a3f3a4b`, `ee29e56`, `9d17ac9`): NEW `src/stt-stream.js` (hand-rolled, dep-free
  RFC 6455 WS client over net/tls/crypto — the env.js precedent; `FasterWhisperStreamSession`
  handshake → binary Int16 frames, `{type:'partial'|'final',text,ts}` parse, exp-backoff
  reconnect, 3-fail latch). NEW `docs/faster-whisper-setup.md` (authoritative protocol + reference
  Python WS server w/ VAD). `src/stt.js` got `transcribeFasterWhisperHTTP` (batch POST fallback)
  + faster-whisper-first chain order. `main.js` `openStreamSessions()`/`closeStreamSessions()`
  replace the flush loop as the capture lifecycle; `mic:pcm`/`system:pcm` route to the live
  session (never gated by `state.busy`) or fall back to batch; `settings:set` resets both STT
  latches. **Deviation (flagged):** `stt.fasterWhisperURL` defaults to `''` (NOT a localhost URL)
  so `auto` → batch by default — otherwise every capture would burn 3 connect failures before
  latching. Renderer: `<div id="transcript-strip">` + `cue.on('transcript'/'transcript:partial'/
  'stt:status')` (the `transcript` channel finally gets a consumer); partials render live, finals
  replace the channel's partial cell. `Ctrl+Alt+A` (reserved, non-configurable) →
  `runFeature('assist','')`, which now composes from `liveTranscriptForPrompt()` (finals + live
  partials). Preload allowlist gained `transcript:partial`, `stt:status`.
- Tests added this branch: `test/transcript.test.js`, `test/env.test.js`, `test/errors.test.js`,
  `test/store-defaults.test.js`, `test/stt-stream.test.js` (incl. a real loopback WS server),
  `test/stt.test.js`. **51/51 pass.**

## In flight
- Nothing uncommitted in the code tree. `.gitignore` has an inherited `CLAUDE.md` → `claude.md`
  tweak — flagged as a Linux regression (case-sensitive FS un-ignores `CLAUDE.md`); left
  uncommitted pending a user decision.

## Next (per plan order)
1. **Phase 4** — composition-point refactor (F8 + F9 + F10 + F11, bundle): NEW `src/prompt-compose.js`
   `composeSystem({ def, settings, memoryState })` (pre-prompt → mode system → skills → memory →
   résumé, in that order); NEW `src/skills.js` (`loadSkillDir`, frontmatter parse, 8 000-char cap);
   NEW `src/memory.js` (rolling summary on a 60 s interval, persisted to `userData/cue-memory.json`);
   `prompts.js` `wantsResume` per mode + `MEMORY_SUMMARY_PROMPT` + `RESUME_SUMMARY_PROMPT`;
   `profile-context.js` two-tier résumé; `store.js` DEFAULTS `prePrompt`/`skillDir`/`memory.notes`/
   `resumeSummary`. See the "Shared: system-prompt composition (Phase 4 seam)" note in
   [implementation-plan.md](implementation-plan.md). Tests: `test/prompt-compose.test.js`
   (ordering + framing + résumé gating), `test/skills.test.js`, `test/memory.test.js`.
2. **Phase 5** — F5 `Ctrl+Alt+C` show/hide, F2 drag polish, F12 vision speed (1568 px JPEG + 1.5 s
   TTL cache).

## Blockers / open questions
- None currently hard-blocking. (If one appears, put it here and add a one-line pointer in
  [context-summary.md](context-summary.md).)

## Session discoveries (in flight — promote at commit, then clear)
- _Session notes accumulate here during active work. Each resolved item is promoted to
  [memory.md](memory.md) / [decisions.md](decisions.md) and **deleted from this subsection**
  before the feature's commit._
- _(empty — last cleared: 2026-07-27)_
