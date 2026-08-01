# Architecture

The deeper, narrative "what & why" of `cue`. (README has the short version.) If you need
"what's safe to change & where the seams are," see the AI-internal companion
[`.claude/docs/architecture.md`](../.claude/docs/architecture.md) — this doc and that one ask
different questions, so they overlap in code but not in prose.

## Overview

`cue` is an [Electron](https://www.electronjs.org/) overlay: a frameless, transparent,
always-on-top window that floats over everything else, captures **screen + mic + meeting
audio**, transcribes the audio, and streams answers from a bring-your-own-key LLM. Everything
runs locally except the call to the user's chosen provider (OpenAI, Anthropic, Google Gemini,
Nvidia, or a local Ollama). There is no server and no telemetry.

The whole app is plain HTML/CSS/JS — no build step, no bundler, no TypeScript, no native
modules by design. Sources ship unpacked (`asar: false`).

## Process model & the security boundary

`cue` is the standard three-process Electron split:

- **Main** — [`main.js`](../main.js). Creates the overlay window, owns global shortcuts,
  accumulates incoming PCM, runs the transcription flush loop, and orchestrates feature runs
  (`runFeature`). It is the single source of truth for capture/transcript/LLM `state`.
- **Preload** — [`preload.js`](../preload.js). A tight `contextBridge` exposing `window.cue`
  and an **explicit IPC allowlist**. `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: false`. The renderer never touches Node directly.
- **Renderer** — [`renderer/`](../renderer/): the glass UI ([`renderer.js`](../renderer/renderer.js),
  [`index.html`](../renderer/index.html), [`styles.css`](../renderer/styles.css)), an
  `AudioWorkletProcessor` that converts float → Int16
  ([`pcm-processor.js`](../renderer/pcm-processor.js)), and inlined Lucide icons
  ([`icons.js`](../renderer/icons.js)).

## The three inputs — kept on separate channels

This is the central design. Each input is captured by a different mechanism, and the
**`you` / `them` "who said what" tag** is preserved end-to-end through transcript → prompt →
render.

- **Screen** — [`src/screen.js`](../src/screen.js): a full-resolution `desktopCapturer`
  screenshot taken in main **only when a feature needs one** (`needsScreen`).
- **Microphone ("you")** — the renderer's `getUserMedia` → a 16 kHz `AudioContext` → the
  `pcm-processor` worklet → IPC `mic:pcm`.
- **Meeting audio ("them")** — the renderer's `getDisplayMedia` loopback of the system's
  **output** audio; the video track is discarded, only the loopback audio track is kept → the
  same worklet → IPC `system:pcm`.

### Why audio is captured in the renderer, not the main process

Capturing audio inside `cue`'s own renderer process means it reuses `cue`'s **own**
Screen-Recording grant — there's no separate helper binary to authorize, and no native module
to ship. This is a deliberate architectural decision (ADR-001 in
[`.claude/docs/decisions.md`](../.claude/docs/decisions.md)).

## Transcription pipeline

PCM arrives as `mic:pcm` / `system:pcm`. The **default path is streaming**: on capture start
`openStreamSessions()` builds a per-channel session that consumes PCM live and emits partial/final
turns into the ring buffer. The **batch flush loop** (`FLUSH_MS = 3500`, gated by `MIN_BYTES` and
an RMS silence gate in [`src/wav.js`](../src/wav.js) `rms16`) is the fallback when no streaming
provider is available/latched — so capture never pauses. `stt.enabled === false` stops both.
Finals push into the **ring-buffered** transcript in [`src/transcript.js`](../src/transcript.js):
`finals` is capped at `TR_MAX_TURNS = 200` (oldest evicted), `partials` holds the live per-channel
streaming partial, and `lastSummarizedTs` is the rolling-summary watermark. The turn shape
`{ channel, text, ts }` is preserved so prompt formatting is unchanged.

## Provider abstraction — LLM and STT are decoupled

- **LLM** — [`src/llm.js`](../src/llm.js): `createLLM(settings)` returns one
  `{ stream({ system, turns, imageDataUrl, onToken }) }` interface over OpenAI, Anthropic, and
  Gemini. **Nvidia and Ollama reuse the OpenAI SDK with a different `baseURL`** (a local Ollama
  needs no real key — a non-empty sentinel is used). Each provider's `streamX` attaches the
  optional screenshot to the last user turn differently; `maxTokens` is pinned to 4096
  ("effectively unlimited") because the Anthropic SDK requires a value.
- **Speech-to-text** — registry-driven providers behind one engine-agnostic seam:
  - **Batch (cloud)** — [`src/stt.js`](../src/stt.js) `createSTT(settings)`, a separate factory
    (Anthropic has no audio API); a fallback chain over audio-capable providers (local
    faster-whisper → OpenAI Whisper → Groq → Gemini) with a `sttDisabled` latch on
    403/401/`model_not_found`.
  - **Managed local engine** — [`src/stt-process.js`](../src/stt-process.js) spawns + manages a
    Python service ([`python/cue_stt_service.py`](../python/cue_stt_service.py)) over
    line-delimited JSON-RPC: it creates the venv, pins deps, restarts on crash (latches after 3),
    clean-shuts on quit. [`src/stt-engine.js`](../src/stt-engine.js) registers engines by id so
    `main.js`/`stt-stream.js` never name one — adding whisper.cpp is one `registerEngine` call.
    [`src/stt-models.js`](../src/stt-models.js) is the paired Node-side model list (synced with
    the Python `MODELS`).
  - **Cloud streaming** — **AssemblyAI** streams live PCM over a hand-rolled v3 WebSocket
    (binary Int16 frames, `Authorization` header auth), reusing the `WsClient` transport from
    external-ws ([`src/providers/stt/assemblyai/`](../src/providers/stt/assemblyai/)).
  - **External server** — a hand-rolled WebSocket client to a faster-whisper server you run;
    same `{ start, sendAudio, close }` surface as the managed engine.
- **Routing** — [`src/stt-stream.js`](../src/stt-stream.js) `resolveProvider` picks `auto` → local
  (when its venv is ready) → AssemblyAI (if a key is set) → external WS URL → null/batch, or
  `local`/`assemblyai`/`faster-whisper`/`batch` forced (explicit names match by provider id).
  CLIs: `npm run stt:setup|status|models|download|delete`. See
  [faster-whisper-setup.md](faster-whisper-setup.md).

## Feature modes & prompt composition

[`src/prompts.js`](../src/prompts.js) exports `MODES`: `assist`, `say`, `followup`, `recap`,
`ask`, `leetcode`. Each mode declares `{ needsScreen, userBubble, small, system, build(ctx) }`.
`runFeature` ([`main.js`](../main.js)) orchestrates: pick the mode → screenshot if `needsScreen`
→ `build()` the user message from the transcript + the user's text → **compose the system
prompt** → optionally append the user's résumé as untrusted reference data
([`src/profile-context.js`](../src/profile-context.js), capped at 12 000 chars) → stream the
LLM → relay tokens to the renderer via IPC `llm:token`.

## Settings & `.env`

[`src/store.js`](../src/store.js) persists `userData/cue-data.json`, deep-merged over `DEFAULTS`.
Each provider has `{ fast, smart }` model tiers; the **Smart** toggle picks the tier. The store
**auto-switches the active provider** if the current one has no key but another does.

[`src/env.js`](../src/env.js) is a dependency-free `.env` loader that runs before the store is
required (`CUE_ENV_PATH` → `userData/.env` → `cwd/.env`); the store then applies `CUE_*`
runtime overrides that are **never persisted** — so secrets can live in `.env` without being
written into the settings file.

## Errors

[`src/errors.js`](../src/errors.js) normalizes every SDK/STT error to one shape
`{ status, code, provider, message, suggestion }`, so the UI can build a consistent, helpful
message without special-casing each provider's error envelope.

## Invisibility

A single macOS window flag — `win.setContentProtection(true)` (sets `NSWindowSharingNone`) —
asks the window server to exclude `cue` from screen capture. This is best-effort (particularly
on macOS 15.4+, where some capture tools can ignore it); `CUE_NO_PROTECT=1` disables it for
debugging. Full caveat in [README](../README.md).

## Releases

Releasing is tag-driven; see [release.md](release.md).

```
main process ──┬─ overlay window (frameless, transparent, always-on-top, content-protected)
               ├─ screenshot capture (desktopCapturer)
               ├─ speech-to-text ┬ managed local faster-whisper (spawns a Python service,
               │                  │  JSON-RPC over stdin/stdout)   ── "you" + "them" channels
               │                  └ external WS server / cloud Whisper-Gemini fallback
               └─ LLM streaming (OpenAI / Anthropic / Gemini / Nvidia / Ollama)
renderer ──────┴─ the glass UI + mic capture + system-audio loopback
                        (getUserMedia / getDisplayMedia → pcm-processor → IPC)
```
