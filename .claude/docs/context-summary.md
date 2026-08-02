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
(OpenAI / Anthropic / Gemini / Nvidia / Ollama / Groq / OmniRoute). Everything runs locally
except the provider call. The provider system is **plugin-centric** (R3): all providers
(LLM + STT, 17 total) live in folders under `src/providers/<type>/<id>/index.js`, self-describe
via `definePlugin()` with rich capabilities, model discovery, health checks, and
`configurableSettings` with `settingsPath`/`group`. A core discovery engine
(`src/providers/core/`) orchestrates registration, model registry, health monitoring,
caching, and IPC push events to the renderer. Speech-to-text is decoupled (ADR-002): the
default transport is a **managed local faster-whisper** Python service (ADR-013) spawned by
main; fallbacks are **AssemblyAI** (cloud streaming), **Deepgram** (streaming + batch),
external WebSocket server, and cloud batch (OpenAI Whisper / Groq / Gemini / OmniRoute).
The central invariant: **the three inputs stay separate and the channel tag preserves "who
said what"** through transcript → prompt → render.

## Right now
- Branch `main` with R3 plugin discovery system complete in the working tree (uncommitted).
  Latest commit: `8b372c4 feat: add OmniRoute LLM and STT providers with local health checks`.
  R3 introduced `src/providers/core/`, migrated all 17 providers to `definePlugin()`, removed
  hardcoded provider/model lists, and added `providers:spec` IPC with push events.
- **Next:** R4 (shortcuts), R5 (prompts UI), R6 (popup), R7 (logging config), R8 (docs compression).

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
