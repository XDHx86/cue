# Contributing to cue

Issues and PRs welcome — `cue` is intentionally small and readable. This guide is the fuller
version of the "Contributing" section in the [README](../README.md).

## Prerequisites & setup

You need [Node.js](https://nodejs.org) 18+. No Xcode / no native build toolchain required
(there are no native modules by design).

```bash
git clone https://github.com/Blueturboguy07/cue.git
cd cue
npm install
npm start          # electron .
```

Verbose capture/LLM traces: set `const DEBUG = true` at the top of
[`main.js`](../main.js) (or `CUE_ENV_DEBUG=1` for the `.env` loader). LLM provider traces also flow
through the `child('llm')` Pino logger at debug level. **Don't commit DEBUG on.**

## Project layout

| Path | Role |
|---|---|
| [`main.js`](../main.js) | main process: window, shortcuts, capture flush loop, `runFeature` orchestration |
| [`preload.js`](../preload.js) | tight `contextBridge` IPC allowlist (`contextIsolation:true`) |
| [`src/`](../src/) | providers (`llm.js`, `stt.js`), `prompts.js`, `screen.js`, `transcript.js`, `store.js`, `env.js`, `errors.js`, `wav.js`, `profile-context.js` |
| [`renderer/`](../renderer/) | the glass UI (`renderer.js`, `index.html`, `styles.css`), `pcm-processor.js` (audio worklet), `icons.js` |
| [`test/`](../test/) | `node --test` suite (pure-Node) |

**No build step for source** — plain HTML/CSS/JS; no TypeScript, no linter, no bundler.

## Tests

```bash
npm test                                    # node --test — runs everything in test/
node --test test/transcript.test.js         # one file
node --test --test-name-pattern="leaves" .  # by name
```

Tests are **pure-Node** — they must not import `electron`. Electron-dependent logic is
param-injected (the pattern in [`src/profile-context.js`](../src/profile-context.js)). Add new
tests as `test/<thing>.test.js`. Run `npm test` before committing.

## Commits & PRs

- **Atomic Conventional Commit per feature / chore / fix / docs** — don't combine unrelated work:
  `feat(<scope>): …`, `fix(<scope>): …`, `refactor:`, `docs:`, `chore:`, …
- A change is complete only when fully implemented, tested, documented (when applicable), and
  clean — no TODOs, temp code, or known regressions.
- Review the staged diff before committing; it should contain only that change.
- Keep PRs reviewable and merge-ready: pass `npm test`, follow existing architecture & style,
  update affected docs (`README.md`, `docs/`, and the `.claude/docs/` knowledge tree when
  it's the kind of fact that belongs there).
- Never rewrite or squash existing commits, and never force-push, unless explicitly asked.

## Platform support

- macOS — fully supported.
- Windows — fully supported.
- Linux — untested (PRs welcome).

When touching platform behavior, grep for `process.platform` / `cue.platform` rather than
assuming one path — platform branches are scattered (window flags, onboarding, shortcut
keycaps, the Zoom z-order fix).

## The AI-internal knowledge tree (`.claude/docs/`)

[`.claude/docs/`](../.claude/docs/) is the project's **AI-internal working memory** —
architecture decisions, conventions, current state, and retrieval/compression policies —
maintained by Claude Code so context survives across long-lived, multi-session development. It
is version-controlled and reviewable but not required reading. For a deeper narrative of the
system, see [architecture.md](architecture.md); for releases, [release.md](release.md).
