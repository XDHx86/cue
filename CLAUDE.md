# CLAUDE.md

This is the project **operating system** — the always-loaded router. It stays concise by
pointing to supporting docs instead of duplicating them. For depth, follow the links.

## What this is

`cue` is an Electron overlay app — a frameless, transparent, always-on-top window that floats
over everything, sees your screen, hears your microphone and meeting audio, and streams AI
responses. Plain HTML/CSS/JS: **no build step, no bundler, no TypeScript, no linter.** Everything
runs locally except calls to the user's chosen AI provider (OpenAI, Anthropic, Gemini, Nvidia,
Ollama). Bring-your-own-key; no server, no telemetry. macOS and Windows supported; Linux untested.

## The documentation system (two trees)

- **AI-internal working memory** — [`.claude/docs/`](.claude/docs/README.md): architecture,
  conventions, decisions, current state, retrieval & compression policies. **Start there** for
  any non-trivial work. Index + constitution: [.claude/docs/README.md](.claude/docs/README.md).
- **Human docs** — [docs/](docs/architecture.md) and this repo's [README.md](README.md). Never
  duplicate their prose into `.claude/docs/`; link inward.

**One fact has one primary home** — if `.claude/docs/` and `docs/` overlap, the canonical owner
wins and the other links. See [.claude/docs/compression-policy.md](.claude/docs/compression-policy.md).

## Rapid retrieval

Read only what a task needs — see [.claude/docs/retrieval-policy.md](.claude/docs/retrieval-policy.md)
for the task→docs matrix. On resume from a gap: this file → [.claude/docs/context-summary.md](.claude/docs/context-summary.md)
→ [.claude/docs/state.md](.claude/docs/state.md) + [.claude/docs/implementation-plan.md](.claude/docs/implementation-plan.md).
For code substance (what a symbol *is*, who calls it, blast radius), use the `codegraph_explore`
tool first; for seams & invariants read [.claude/docs/architecture.md](.claude/docs/architecture.md).

## Always-on invariants (do not violate without a logged ADR)

- **The three inputs stay on separate `you` / `them` channels end-to-end** (screen · mic ·
  meeting audio) — "who said what" survives transcript → prompt → render. Never collapse channels.
- **No build step, no native modules by design.** Don't introduce a bundler, TypeScript, or a
  dep chain without a decision in [.claude/docs/decisions.md](.claude/docs/decisions.md). If a
  feature tempts a native module, find a dependency-free path first.
- **Audio is captured in the renderer, not main** — it reuses cue's own Screen-Recording grant,
  so there is no helper binary to authorize.
- **LLM and STT are decoupled** ([src/llm.js](src/llm.js) vs [src/stt.js](src/stt.js)) because
  Anthropic has no audio API; STT builds its own fallback chain.
- **A new IPC channel needs three legs** — [preload.js](preload.js) allowlist *and* a main
  handler *and* a renderer consumer. Missing any leg = silent no-op.
- **`asar: false`** — the packaged app ships unpacked; keep `main.js`, `preload.js`, `src/**`,
  `renderer/**` in the `files` allowlist in [package.json](package.json).
- **Invisibility is best-effort** — `win.setContentProtection(true)` (NSWindowSharingNone) is
  *not* guaranteed on macOS 15.4+; `CUE_NO_PROTECT=1` disables it for debug.

Conventions, gotchas, and edit blast-radius live in [.claude/docs/conventions.md](.claude/docs/conventions.md)
and [.claude/docs/architecture.md](.claude/docs/architecture.md). Per-provider notes in
[.claude/docs/providers.md](.claude/docs/providers.md).

## Commands

```bash
npm install          # dependencies (no native modules by design — avoids postinstall pain)
npm start            # run the app (electron .)
npm test             # node --test — runs everything in test/
npm run pack         # electron-builder --dir (local unpackaged app)
npm run dist         # macOS distributable (electron-builder --mac zip)
npm run dist:win     # Windows distributable (electron-builder --win, nsis installer)
```

Single test / filter by name:

```bash
node --test test/profile-context.test.js
node --test --test-name-pattern="leaves the mode prompt" .
```

Tests are pure-Node and **must not import `electron`** — electron-dependent bits are
param-injected (see [src/profile-context.js](src/profile-context.js)).

Releasing is tag-driven: pushing a `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml)
(mac + Windows artifacts attached to a GitHub Release). There is no CI test gate — run `npm test`
locally. Details at [docs/release.md](docs/release.md).

## Coding & debugging notes

- **Debug logging** — `const DEBUG = false` at the top of [main.js](main.js#L1). Flip to `true`
  for traces; **don't commit it true**. (LLM traces flow through the lazy `child('llm')` Pino
  logger in [src/providers/llm/shared.js](src/providers/llm/shared.js), debug-level and silent
  at the default info level — the `src/llm.js` `DEBUG` flag is retired; it's now a thin registry
  delegate.)
- **Model names drift** — defaults in [src/store.js](src/store.js) (`gpt-4o`, `claude-3-5-sonnet-latest`,
  …) are user-editable and change fast — treat them as defaults, not constraints.
- **`process.platform` branches** are scattered (window flags, onboarding, shortcut keycaps, the
  Zoom z-order fix). Grep `process.platform` / `cue.platform`; don't assume one path.
- **Global shortcuts** are owned by main (`Cmd/Ctrl+H` → leetcode, `Cmd/Ctrl+Shift+X` → quit,
  configurable **Assist**, default `Cmd/Ctrl+Return`): the renderer records the combo, main
  confirms registration and persists.
- **Click-through** — the renderer toggles `setIgnoreMouseEvents({ forward:true })` on `mousemove`
  via `document.elementFromPoint`; empty glass passes clicks through. The handler is rAF-throttled.

## Development workflow

- Implement features as small, self-contained vertical slices. Complete one feature or
  architectural milestone before starting the next.
- A feature is fully implemented only when it's tested, documented (when applicable), and clean
  — no TODOs, temporary code, or known regressions.
- Run all relevant checks (`npm test`) **before committing**.

## Repository contribution standards

Treat this repo as an external project receiving a contribution rather than a personal codebase:

- Follow the repository's existing architecture, conventions, and coding style.
- Ensure all available checks pass.
- Update affected documentation: README, [docs/](docs/architecture.md), and the
  [.claude/docs/](.claude/docs/README.md) tree when the change is the kind of fact that belongs
  there (seam move, new decision, current-state change). Compress, don't append — see
  [.claude/docs/compression-policy.md](.claude/docs/compression-policy.md).
- Keep commits reviewable, logically separated, and suitable for a Pull Request.
- Leave the repository in a merge-ready state with no known failing checks or unfinished work.

## Repository Knowledge Maintenance

Repository memory is part of the implementation.

Whenever work changes repository knowledge, before considering the task complete:

- Update the appropriate document under `.claude/docs/`.
- Update the implementation plan if roadmap or progress changed.
- Rewrite or compress existing documentation instead of appending.
- Preserve one authoritative owner per topic.
- Remove obsolete or superseded information.
- Validate cross references if documentation structure changed.

Do not create new documentation unless an existing document cannot reasonably own the knowledge.

## Git workflow

- **Atomic Conventional Commit per feature/chore/docs** — `feat(<scope>): …`, `fix(<scope>): …`,
  `refactor:`, `docs:`, `chore:`, … Don't combine unrelated work into one commit.
- Never rewrite or squash existing commits unless explicitly instructed. Never force-push unless
  explicitly instructed.
- Before committing, review the staged diff — it must contain only changes related to the
  current feature/work. When a feature is complete, commit it before starting unrelated work
  (a full feature/chore/docs/governance unit, not individual files).
