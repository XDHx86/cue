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
- `fix/stt-transcription-timeout` (off `main`). An 8-priority overhaul at
  [`../plans/cue-fix-plan.md`](../plans/cue-fix-plan.md). **P1–P2 committed**; **P3 in flight**.

## Completed (committed)
- **P1 — transcription root-cause fixes** (`be96ab6`): decouple model download from load (download
  first with progress → cache-only load, finite 120s timeout); pre-sid bounded PCM ring; mid-capture
  channel degradation to batch in-session; 30s batch/cloud transcribe watchdog releasing the channel
  lock; actionable provider-specific error surfacing; auto-prepare the venv on first capture for
  `provider:'local'`; `scripts/stt-test-providers.js` (+ `npm run stt:test-providers`). ADR-014/ADR-016.
- **P2 — generalized logging** (`b46163b` → `a96f256` → `bc1e89a`): Pino (Node) + Loguru (Python)
  centralized, app-wide singleton; migrated the ~39 `console.*` in main/llm to the structured logger
  (terminal fd 2 + dated rotating files). No stray `console.log` outside intentional transport fallbacks.

## In flight (uncommitted)
- **P3 — Settings redesign as categorized tabs.** Rebuilt the single scrolling panel into a left-nav
  tabbed shell — **Providers · Transcription · Models · Context · Shortcuts** — preserving every field
  and the `fillSettings`/`saveSettings` contract (only the container/navigation changes; entry points
  stable). Also fixes a latent storage-coherence bug: the Assistant-style seg was reading the deleted
  legacy `settings.prePrompt`/`prePromptTemplate` keys, so it always showed "Concise" on reopen; it now
  reads/writes the live `settings.promptOverrides.prePrompt` home via a new electron-free
  [src/preprompt.js](../../src/preprompt.js) (`getPrePromptChoice`/`buildPrePromptOverride`, tested in
  `test/preprompt.test.js`, exposed to the renderer as synchronous preload contextBridge pass-throughs —
  not new IPC). **217/217 tests pass.** Docs refresh below is part of the commit.

## Next
1. **Commit P3** (`feat(ui): categorized settings tabs`) — `npm test` already green; manual UI check
   (the user, not headless).
2. **P4** — Mute/Unmute recording control reflecting real capture/STT state (depends on P1).
3. Then P5 (screen perms), P6 (notifications), P7 (CI/build/Docker), P8 (retire .env + ADR-015).

## Blockers / open questions
- P3's "every field reachable, seg reflects saved choice" needs the user's machine (headless Electron
  can't open the panel); tests cover only the extracted helper. The manual checklist is in the plan.

## Session discoveries
- (Promoted to [memory.md](memory.md) at commit — the preload-contextBridge-pass-through precedent and
  the not-wired `prompts:registry` note.)
