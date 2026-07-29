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
- `fix/stt-transcription-timeout` (off `main`). Goal: **Priority 1 — fix transcription** so
  local Python / OpenAI / Gemini all transcribe the same captured audio with no silent timeouts
  and actionable errors; follows the 8-priority overhaul plan at
  [`.claude/plans/cue-fix-plan.md`](../plans/cue-fix-plan.md).

## Completed (committed)
- **P1 — transcription root-cause fixes** (commit `be96ab6`): decouple model download from load
  (download first with progress → cache-only load, finite 120s timeout); pre-sid bounded PCM ring
  (D2); mid-capture channel degradation to batch in-session (D3); 30s batch/cloud transcribe
  watchdog releasing the channel lock (D4/D5); actionable provider-specific error surfacing (D6);
  auto-prepare the venv on first capture for `provider:'local'` (D9); `main.js` wired to a
  `sttChild('main-stt')` structured logger. Python `load()` gained `local_files_only`. New
  `scripts/stt-test-providers.js` (+ `npm run stt:test-providers`) feeds one WAV through every
  provider. **206/206 tests pass.**

## In flight
- **P1 — docs.** ADR-014 (logging) + ADR-016 (no silent timeouts) added to
  [decisions](decisions.md) (ADR-015 reserved for P8); [architecture](architecture.md) STT/engine
  + main.js-wiring sections updated; this file + [context-summary](context-summary). Not yet
  committed.

## Next
1. Commit P1 docs, then verify P1 end-to-end (user runs `npm run stt:setup` + the manual
   checklist below — can't be done headless).
2. **P2** — migrate the remaining ~39 `console.*` in main/llm to the structured logger (the STT
   transport already exists; generalize beyond STT).
3. **P3** — Settings as categorized tabs (Providers · Whisper · Model · Memory · Audio · Screen ·
   Shortcuts · Advanced), preserving every field.
4. Then P4 (mute/unmute), P5 (screen perms), P6 (notifications), P7 (CI/build/Docker), P8 (.env
   retirement, ADR-015). See [`cue-fix-plan.md`](../plans/cue-fix-plan).

### P1 manual verification checklist (the user runs this)
```
npm test                 # 206/206 green (CI half)
npm run stt:setup        # one-time venv (or let auto-prepare do it on first capture)
npm start                # then in the overlay:
  - Settings → Speech-to-Text → Provider: local → toggle listening → say a few words
    Expect: "starting…" badge → "streaming" → a transcript appears (local works)
  - Provider: auto with an OpenAI key, no venv → batch path transcribes (OpenAI works)
  - Provider: auto with a Gemini key only → batch transcribes (Gemini works)
  - Kill a cloud key / pull network → expect an actionable status, NOT a silent hang
node scripts/stt-test-providers.js ./sample.wav   # same audio via all three, no mic
```

## Blockers / open questions
- None hard-blocking. **Cannot verify live transcription headless** (no audio hardware, no keys,
  no Electron) — P1's "works for all three providers" success criterion requires the user's machine.

## Session discoveries (in flight — promote at commit, then clear)
- **The local-vs-cloud failure modes were structurally separate but presented identically.** The
  `auto` transport gates the local engine on `manager.isVenvReady()`, and `getSttManager()` only
  *creates* the manager (never bootstraps the venv) — so on `auto` with no venv + no WS URL the
  pipeline silently falls to the band batch path, while `provider:'local'` with no venv dropped
  everything. Diagnosis required reading the *whole* pipeline, not one provider. (Promote to
  [memory.md](memory.md) at commit.)
- `load` at `timeout:0` + `local_files_only=False` was the single highest-impact defect: a silent
  download blocked `stream_start` forever and dropped all PCM. Decoupling download from load was
  the real fix; raising timeouts would have changed nothing.
