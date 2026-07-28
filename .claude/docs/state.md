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
- `feat/local-stt-engine` — **6 commits ahead of `main`**. `feat/mvp-overhaul` is an ancestor;
  it carried the overhaul phases (0a/0b/1/2/3/5/6) into `main`, so this branch is scoped to the
  STT feature itself.
- Goal: **managed local Speech-to-Text with faster-whisper** — zero-config (no `pip`, **no
  native modules** in cue), behind an engine-agnostic seam so a second engine (whisper.cpp)
  registers without app changes (ADR-013). Layered onto the existing streaming pipeline
  (ADR-008), not a parallel system.

## Completed (committed)
- **Local STT engine** — 5 commits (`36f83af`→`e1bf887`) + `70f18d3` (Settings scroll prereq):
  - `36f83af` — [`src/stt-process.js`](../../src/stt-process.js) `createSttProcessManager`
    (venv bootstrap, line-delimited JSON-RPC, restart-with-backoff + latch after 3, clean
    shutdown) + [`python/cue_stt_service.py`](../../python/cue_stt_service.py) +
    `python/requirements.txt`. Param-injected `{ spawn, spawnSync, fs, getPath }` → tests spawn
    no Python.
  - `8935d05` — [`src/stt-engine.js`](../../src/stt-engine.js) registry (`registerEngine`/
    `createEngineSession`) + `LocalFasterWhisperSession`; [`src/stt-stream.js`](../../src/stt-stream.js)
    `resolveProvider`/`createStreamSTT` routing. `auto` → local (venv ready) → external WS URL
    → null/batch; `local`/`faster-whisper`/`batch` forced. `store.js` `DEFAULTS.stt` + ENV.
  - `4a51914` — Settings → Speech-to-Text panel (enable · engine · model · download/delete ·
    device · compute type · language · VAD · diagnostics) + preload IPC + main wiring +
    [`src/stt-models.js`](../../src/stt-models.js) shared model list.
  - `0c07423` — `model_download`/`delete`/`list` pass `download_root` so they honor the cache
    dir before any `load` (the service's sticky root is unset pre-load).
  - `e1bf887` — npm scripts (`stt:setup|status|models|download|delete`) + `scripts/stt-cli.js`.
- **Tests:** `test/stt-process`, `test/stt-engine`, `test/stt-stream` (incl. a real loopback WS
  server), `test/stt-models` (JS↔Python list-drift guard), `test/stt-cli`, `test/stt`, `test/env`.
  **171/171 pass.**

## In flight
- **Commit 5 — docs (uncommitted).** Rewritten:
  [docs/faster-whisper-setup.md](../../docs/faster-whisper-setup.md) (managed-engine + external
  split), [README.md](../../README.md), [docs/architecture.md](../../docs/architecture.md);
  [.claude/docs/](architecture.md) [architecture](architecture.md) / [conventions](conventions.md)
  / [troubleshooting](troubleshooting.md); ADR-013 in [decisions.md](decisions.md) (ADR-006/008
  → implemented); plus this file + [implementation-plan](implementation-plan.md) +
  [context-summary](context-summary.md). Verify with `git diff`.

## Next
1. Final verification (`npm test` ✅, scan for stray TODOs / debug flags) → commit the docs →
   merge `feat/local-stt-engine`.
2. Out of scope for this branch: **Phase 4 — prompt-compose seam** (skills · rolling memory ·
   pre-prompt · résumé-efficiency, ADR-007/009), the one open roadmap item — see
   [implementation-plan.md](implementation-plan.md).

## Blockers / open questions
- None hard-blocking.

## Session discoveries (in flight — promote at commit, then clear)
- _(empty — last cleared: 2026-07-28)_
