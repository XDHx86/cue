<!--
  tier:     compression
  owner:    claude
  updates:  on resume / periodic rewrite — REWRITE, never append
  scope:    30-second orientation briefing + pointers
  no-grow:  ~70 lines. This is a transient, solidified view; if it disagrees with a perm, that file wins
  belongs:  the regenerable narrative that orients a fresh session
  excludes: any fact already owned elsewhere — link, don't restate
  migrates: nothing — it is a transient view; facts are promoted into the docs it points at
-->

# context-summary — resume orientation briefing

Load this second (after [CLAUDE.md](../../CLAUDE.md)) when resuming, then the task-specific
docs from [retrieval-policy.md](retrieval-policy.md). **This file is REWRITTEN, not appended.**
It is a compressed view — if it disagrees with a permanent file, that file wins.

## 30-second orientation
`cue` is a frameless, transparent, always-on-top Electron overlay (plain HTML/CSS/JS, no
build step) that captures **screen + mic + meeting audio**, transcribes them as two
end-to-end channels (`you` / `them`), and streams answers from a bring-your-own-key LLM
(OpenAI / Anthropic / Gemini / Nvidia / **Ollama**). Everything runs locally except the
provider call. Speech-to-text is **registry-driven**: STT providers live in folders under
`src/providers/stt/<id>/index.js` and auto-register via `defineProvider`. Default transport
is a **managed local faster-whisper** Python service (ADR-013) spawned by main; fallbacks
are **AssemblyAI** (cloud streaming), external WebSocket server, and cloud batch
(OpenAI Whisper / **Groq** / Gemini). The central invariant: **the three inputs stay
separate and the channel tag preserves "who said what"** through transcript → prompt → render.

## Right now
- Branch `main` with uncommitted session work. Recent: Groq STT provider, AssemblyAI
  streaming provider, audio resampling safety net, graceful shutdown, settings validation,
  Advanced-tab logging config. See [state.md](state.md) for the full list and `git status`.
- **98/98 tests pass** across the touched suites (`test/providers.test.js`,
  `test/assemblyai-provider.test.js`, `test/resample.test.js`, `test/store-defaults.test.js`,
  `test/registry.test.js`, `test/stt-stream.test.js`).
- **Next:** R3 — auto-generated provider Settings UI (renderer builds provider fields from
  `configurableSettings`), then R4–R8.

## Where things live
- Architecture & seams → [architecture.md](architecture.md) · Coding rules → [conventions.md](conventions.md)
- Why → [decisions.md](decisions.md) · Pitfalls → [memory.md](memory.md) · Providers →
  [providers.md](providers.md) · Terms → [glossary.md](glossary.md) · Dev trouble → [troubleshooting.md](troubleshooting.md)

## Where the work is
- Current snapshot → [state.md](state.md) — and `git status` / `git diff` for the live tree.
- The roadmap → [implementation-plan.md](implementation-plan.md)
- Assistant-style shaping helper → [src/preprompt.js](../../src/preprompt.js) (electron-free; the
  renderer reaches it via a synchronous preload contextBridge pass-through, not IPC).

## How to behave here
- **Rewrite, don't append** (see [compression-policy.md](compression-policy.md)).
- One fact, one home; **link, don't restate** ([README.md](README.md)).
- Point at `git` for volatile state; keep prose stable.
