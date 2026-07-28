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
provider call. Speech-to-text defaults to a **managed local faster-whisper** Python service —
cue spawns it, no `pip`, no native modules (ADR-013); external WS server or cloud
Whisper/Gemini are fallbacks. The central invariant: **the three inputs stay separate and the
channel tag preserves "who said what"** through transcript → prompt → render.

## Where things live
- Architecture & seams → [architecture.md](architecture.md)
- Coding rules & gotchas → [conventions.md](conventions.md)
- Why things are this way → [decisions.md](decisions.md)
- Recurring pitfalls → [memory.md](memory.md)
- Per-provider notes → [providers.md](providers.md)
- Terms → [glossary.md](glossary.md)
- Dev troubleshooting → [troubleshooting.md](troubleshooting.md)

## Where the work is
- Current snapshot → [state.md](state.md) — and `git status` / `git diff` for the live tree.
- The roadmap & phase status → [implementation-plan.md](implementation-plan.md)

## Right now
- Branch `feat/local-stt-engine`, 6 commits ahead of `main`. (Its ancestor `feat/mvp-overhaul`
  carried the overhaul phases 0a/0b/1/2/3/5/6 into `main` first; this branch adds the
  **managed local STT** feature.)
- Committed on this branch (5 STT commits, `36f83af`→`e1bf887`): managed faster-whisper Python
  service + venv bootstrap; engine-agnostic registry + streaming session + routing; Settings
  UI + preload IPC + main wiring; `download_root` honored before any `load`; npm scripts +
  `scripts/stt-cli.js`. Plus one Settings-panel scroll fix. **171/171 tests pass.**
- **In flight (uncommitted): Commit 5 — docs** ([faster-whisper-setup](../../docs/faster-whisper-setup.md),
  [README](../../README.md), architecture, ADR-013, conventions, troubleshooting, state/plan).
  Verify with `git diff`.
- Next: final verification + merge. After this branch the one open roadmap item is **Phase 4 —
  prompt-compose seam** (skills · rolling memory · pre-prompt · résumé — ADR-007/009); see
  [implementation-plan.md](implementation-plan.md).

## How to behave here
- **Rewrite, don't append** (see [compression-policy.md](compression-policy.md)).
- One fact, one home; **link, don't restate** ([README.md](README.md)).
- Point at `git` for volatile state; keep prose stable.
