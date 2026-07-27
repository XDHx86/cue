<!--
  tier:     long-term
  owner:    claude
  updates:  end-of-feature; when a session realization promotes into a recurring lesson
  scope:    recurring pitfalls + "why X is like this" that are NOT decisions
  no-grow:  ≤60 entries — one bullet per lesson; prune a bullet once folded into decisions.md or conventions.md
  belongs:  foot-guns, rationale-of-the-moment that hardened into habit, superseded-pitfall residues
  excludes: active decisions (decisions.md); current work (state.md); hard rules (conventions.md)
  migrates: a mature recurring lesson that becomes a hard rule → conventions.md
-->

# memory — long-term lessons & recurring pitfalls

The compression **sink** for session knowledge: recurring "why is X like this" facts and
foot-guns that are *not* decisions. One bullet per lesson. Prune a bullet once it has been
folded into [decisions.md](decisions.md) or into [conventions.md](conventions.md) as a hard
rule — it lives there now.

## Audio / capture
- Capture happens in the renderer — a frequent instinct is to move it to main for control;
  that reintroduces the helper-binary authorization ADR-001 wrote against.
- `getDisplayMedia` discards the video track and keeps only the loopback audio track, but the
  video track is the *permission-grant handle* (grabbing it triggers the macOS screen-recording
  prompt) — don't refactor it away.

## Provider / keys
- The OpenAI SDK constructor throws on an empty `apiKey`; any OpenAI-compatible gateway with no
  real key (Ollama) must pass a non-empty sentinel — and `ready` must *not* require a real key
  for that provider.
- Anthropic SDK requires `maxTokens` or it errors; it is pinned to 4096 ("effectively
  unlimited"), not tuned per call.
- OpenAI **project** keys restricted to chat-only models 403 on Whisper — the single most
  common "transcription won't work" user report (see README troubleshooting).

## Renderer / streaming
- Per-token DOM nodes + `insertBefore` caused a re-render/memory-pressure spiral on long
  streams; tokens are now coalesced via `requestAnimationFrame`. Keep new streaming UI on the
  rAF coalescer.
- The `mousemove` click-through handler was unthrottled; it is rAF-capped (60 Hz). Throttle
  any new per-frame renderer work the same way.

## Windows / overlay
- Windows' default `setAlwaysOnTop(true)` level sits **below** Zoom's share overlay (and other
  `'screen-saver'`-level overlays); cue vanishes the moment a call starts sharing. Match macOS:
  `setAlwaysOnTop(true, 'screen-saver', 1)` + `setVisibleOnAllWorkspaces`.
- macOS mic/screen **permission grants tie to the ad-hoc build identity** — rebuilding resets
  them (the System Settings checkbox can linger, misleading users). Tell users to toggle off/on
  after a rebuild.

## Tests
- Tests must not `require('electron')` — electron-dependent bits are param-injected (see
  `src/profile-context.js` and the existing `test/` files). Adding an electron import in a
  tested module silently breaks `npm test`.
