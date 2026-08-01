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
- `feat/registry-refactor` (off `main`). An 8-phase registry-driven refactor at
  [`C:\Users\karee\.claude\plans\curried-toasting-badger.md`](../../../Users/karee/.claude/plans/curried-toasting-badger.md)
  (also tracked in [HANDOFF.md](HANDOFF.md)). **R1a + R1b + R1c complete** (uncommitted);
  R2 next. Live progress + plan detail live in HANDOFF.md — this file is the short resume.

## Completed (uncommitted, this branch)
- **R1a — registry foundation.** [src/registry.js](../../src/registry.js) (`defineProvider`/
  `listProviders`/`getProvider`/`renderSafe`/`resolveSupportedModels`, `${type}:${id}` namespacing),
  [src/registry-loader.js](../../src/registry-loader.js) (folder discovery, param-injected),
  [test/registry.test.js](../../test/registry.test.js) (11 tests).
- **R1b — LLM providers into folders.** 5 self-describing descriptors under
  `src/providers/llm/<id>/index.js` (openai, anthropic, gemini, nvidia, ollama), each calling
  `defineProvider`. Shared: [src/providers/llm/openai-compat.js](../../src/providers/llm/openai-compat.js)
  (one OpenAI-compatible streaming path for openai/nvidia/ollama; diverges only by `baseURL` +
  the ollama sentinel) and [src/providers/llm/shared.js](../../src/providers/llm/shared.js) (lazy
  `child('llm')` logger guard + `stripDataUrl`, kept BELOW llm.js in the require graph to avoid a
  cycle). Anthropic/gemini ports are verbatim from the old `streamX` functions.
  [test/providers.test.js](../../test/providers.test.js) asserts the 5 register + that folding
  their `defaultSettings` reproduces today's literal DEFAULTS exactly.
- **R1c — createLLM + store fold.** [src/llm.js](../../src/llm.js) is now a thin
  `getProvider('llm', settings.provider).createEngine({settings})` delegate (the `if/else` switch
  + `streamX` functions deleted). [src/store.js](../../src/store.js) folds every registered LLM
  provider's `defaultSettings` into DEFAULTS at load (`foldLlmDefaults` + `BASE_DEFAULTS`) — the
  provider descriptors are now the single source for `apiKeys`/`models`/`ollama` defaults.
  `main.js` calls `loadProviders()` at startup (idempotent; store already triggers it at require).
  **238/238 tests pass.**

## In flight
- Nothing mid-edit; the tree is a clean, tested R1b+R1c slice ready to commit (atomic: one
  `feat(registry): R1b+R1c migrate LLM providers to a folder registry` commit, or two if reviewing
  wants the split — R1b folders/tests then R1c llm/store delegation).

## Next
1. **R2 — STT provider registry.** Migrate STT providers (faster-whisper local, openai Whisper,
   gemini, external-ws) into `src/providers/stt/<id>/index.js`; `createSTT` builds the batch chain
   from `listProviders({type:'stt'})`; `stt-stream.js` resolves stream sessions via
   `createStreamSession`; fold `stt-engine.js`'s `registerEngine`/`engineMeta` into the provider
   registry. Port, don't fix, the local/offline bug (§9). See HANDOFF R2.
2. Then R3 (auto-generated Settings UI), R4 (shortcuts), R5 (prompts UI), R6 (popup), R7 (logging),
   R8 (docs compression).

## Blockers / open questions
- Manual UI reachability check for R3/R5/R6/R7 needs the user's machine (headless Electron can't
  open the panel). Not blocking R2 (uncoupled).
- `apiKeys.deepgram` is an STT key seeded as a literal in `store.js BASE_DEFAULTS` until R2 wires a
  deepgram STT provider to contribute it (matches ADR-002 — STT defaults live in store today).

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
