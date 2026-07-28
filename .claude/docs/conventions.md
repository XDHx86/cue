<!--
  tier:     permanent
  owner:    claude
  updates:  when a coding rule, invariant, or repo convention changes
  scope:    coding rules, invariants, and gotchas that apply repo-wide
  no-grow:  one entry per rule, terse; cap ~120 lines. Move tight gotchas specifics into troubleshooting.md
  belongs:  no-build invariant, platform branches, debug logging, audio/capture invariants, click-through, shortcuts, model drift, tests, workflow, git
  excludes: architecture seams (architecture.md), provider specifics (providers.md), user troubleshooting (README)
  migrates: a recurring editor-level footgun into troubleshooting.md
-->

# conventions — coding rules, invariants, gotchas

Permanent rules of this repo. Break one only with a deliberate decision logged in
[decisions.md](decisions.md).

## Language & toolchain — no build step (ADR-003)

- Plain HTML/CSS/JS. **No bundler, no transpile, no TypeScript, no linter.** `npm start`
  runs `electron .` directly; sources ship unpacked.
- **No native modules by design** — avoids postinstall pain across macOS/Windows. If a
  feature tempts you to add one, first look for a dependency-free path (the
  [src/env.js](../../src/env.js) hand-rolled `.env` loader is the precedent).
- `electron-builder` config uses **`asar: false`**; the `files` allowlist in
  [package.json](../../package.json) is `main.js`, `preload.js`, `src/**`, `renderer/**`,
  `python/**` (the managed STT service ships unpacked so the spawned process can read it).
  Keep any new top-level asset in that allowlist or it won't ship.

## Platform branches — grep, don't assume

`process.platform` branches are scattered: window flags, onboarding steps, shortcut
keycaps, the Zoom z-order fix. When touching platform behavior, grep `process.platform` /
`cue.platform` rather than assuming one path. macOS and Windows are both supported; Linux
is untested.

## Debug logging — flip local, never commit

`const DEBUG = false` at the top of [main.js](../../main.js#L1) and [src/llm.js](../../src/llm.js#L1).
Flip to `true` for verbose capture/LLM traces; **don't commit it true**.

## Audio & capture invariants

- Audio is captured **in the renderer**, not main (ADR-001).
- The `you`/`them` channel tag is preserved end-to-end; never collapse the two channels.
- `setContentProtection(true)` (NSWindowSharingNone) makes cue **best-effort invisible**,
  not guaranteed (esp. macOS 15.4+). `CUE_NO_PROTECT=1` disables it for debug/screenshot.

## Click-through

The renderer toggles `setIgnoreMouseEvents({ forward:true })` on `mousemove` based on
`document.elementFromPoint`; real UI re-enables capture, empty glass passes clicks through.
The handler is rAF-throttled (60 Hz). When adding a new hit-testable surface, include it in
the selector.

## Global shortcuts — owned by main

`Cmd/Ctrl+H` → leetcode, `Cmd/Ctrl+Shift+X` → quit, and a configurable **Assist** shortcut
(default `Cmd/Ctrl+Return`). The renderer records the key combo; **main confirms
registration and persists** (reserved-shortcut + "already in use" handling in
`registerAssistShortcut` / `registerShortcuts`).

## Model names drift

Defaults in [src/store.js](../../src/store.js) (e.g. `gpt-4o`, `claude-3-5-sonnet-latest`)
are **user-editable and change fast** — treat them as defaults, not constraints.

## Tests — pure-Node, electron-independent

`npm test` = `node --test` over [test/](../../test/). Add tests as `test/<thing>.test.js`.
Electron-dependent bits must be **param-injected** like [src/profile-context.js](../../src/profile-context.js)
so tests don't import `electron` — `src/stt-process.js` and `src/stt-engine.js` follow this
(`createSttProcessManager({ spawn, spawnSync, fs, getPath })`), so the STT tests spawn no Python
and require no Electron. Run one test: `node --test test/<file>.test.js`; filter:
`node --test --test-name-pattern="…" .` Paired source-of-truth lists that cross a language
boundary get a drift guard — `test/stt-models.test.js` asserts `STT_MODEL_SIZES` equals
`python/cue_stt_service.py:MODELS`.

## Local STT — engine-agnostic seam

- `src/stt-engine.js` is the single seam: `registerEngine(id, factory)`. A new local engine
  (whisper.cpp) is ONE factory implementing `{ start, sendAudio, close }` +
  onFinal/onPartial/onStatus/onError + an `ENGINE_META` label. `main.js` and `src/stt-stream.js`
  never name an engine — they ask the registry.
- The managed service manager (`src/stt-process.js`) is param-injected; keep it that way.
  `download_root` must be passed on `model_download`/`model_delete`/`models_list` — the service's
  sticky root is unset until a `load`, and Settings/the CLI can manage the cache before any load.
- The model-size list is PAIRED across JS and Python; change both together (the test catches
  drift). The Python service resolves a name to the HuggingFace repo; Node only lists + scans the
  cache dir.
- `stt.enabled === false` is a hard stop at `openStreamSessions()` — no sessions, no batch loop,
  PCM drops. Don't gate STT on `state.busy` (asking never interrupts transcription, ADR-008).

## Workflow & contribution

- Implement as small, self-contained vertical slices. Complete a feature / architecture
  milestone before starting the next.
- A feature is complete only when fully implemented, tested, documented (when applicable),
  and clean — no TODOs, temp code, or known regressions.
- Run all relevant checks (`npm test`) **before committing**.
- **Atomic Conventional Commit per feature/chore/docs**; don't combine unrelated work:
  `feat(<scope>): …`, `fix(<scope>): …`, `refactor:`, `docs:`, `chore:`, `feat(errors):`, …
- Review the staged diff before committing; it must contain only that feature's changes.
- Treat the repo as an external contribution: follow existing architecture & style, pass
  checks, update affected docs, keep commits reviewable and merge-ready.
- Never rewrite or squash existing commits unless explicitly instructed. Never force-push
  unless explicitly instructed.
