<!--
  tier:     long-term
  owner:    claude
  updates:  when a provider's integration, SDK, error shape, or capability changes
  scope:    per-provider implementation notes for LLM and STT
  no-grow:  one row per provider + the normalize table; cap ~120 lines. New providers add a row, not a section
  belongs:  SDK reuse, baseURLs, maxTokens, image attachment, STT chain, sentinel key, error map
  excludes: generic architecture (architecture.md), decision rationale (decisions.md), the errors.js module's own design (decisions.md ADR-011)
  migrates: a decision-grade "why this provider works this way" into decisions.md; a user-facing key hint into README troubleshooting
-->

# providers — per-provider implementation notes

How each LLM/STT provider is wired. LLM providers are registry-driven (ADR-017): each lives in
its own folder under [src/providers/llm/](../../src/providers/llm/) and self-describes. STT remains
on the legacy `src/stt.js` chain until R2. See [decisions.md](decisions.md) for rationale.

## LLM — registry-driven (ADR-017)

Each provider folder `src/providers/llm/<id>/index.js` calls `defineProvider`, declaring
`capabilities`, `supportedModels`, `configurableSettings`, `defaultSettings` (folded into
[src/store.js](../../src/store.js) DEFAULTS automatically), and `createEngine({settings})` which
returns `{ provider, model, apiKey, ready, stream({system,turns,imageDataUrl,onToken}) }`.
[src/llm.js](../../src/llm.js) `createLLM` is now a one-line delegate:
`getProvider('llm', settings.provider).createEngine({settings})`.

| Provider | Folder | SDK / Notes |
|---|---|---|
| openai | [llm/openai/](../../src/providers/llm/openai/index.js) | `openai`. Image → `image_url` with the full data URL (no mime split). |
| anthropic | [llm/anthropic/](../../src/providers/llm/anthropic/index.js) | `@anthropic-ai/sdk`. **Requires `maxTokens`** → pinned 4096. Image via `source:{type:'base64',media_type,data}` (`stripDataUrl`). |
| gemini | [llm/gemini/](../../src/providers/llm/gemini/index.js) | `@google/genai`. `generateContentStream`; image via `inlineData` (`stripDataUrl`); role remap `assistant`→`model`. |
| nvidia | [llm/nvidia/](../../src/providers/llm/nvidia/index.js) | `openai` + fixed `baseURL: https://integrate.api.nvidia.com/v1` (ADR-005). Shares [openai-compat.js](../../src/providers/llm/openai-compat.js). |
| ollama | [llm/ollama/](../../src/providers/llm/ollama/index.js) | `openai` + local `baseURL: settings.ollama.baseURL \|\| http://localhost:11434/v1`. **Sentinel `apiKey: 'ollama'`** (SDK needs non-empty; Ollama ignores). Ready reflects actual server availability via `local-health.js` (periodic GET `/v1/models`). |
| groq | [llm/groq/](../../src/providers/llm/groq/index.js) | `openai` + fixed `baseURL: https://api.groq.com/openai/v1`. Same API key powers Groq STT. Models: Llama 3.1 8B Instant (fast), Llama 3.3 70B Versatile (smart). No vision. |
| omni | [llm/omni/](../../src/providers/llm/omni/index.js) | `openai` + local `baseURL: settings.omniroute.baseURL \|\| http://localhost:20128/v1`. **Sentinel `apiKey: 'omniroute'`**. Ready reflects actual gateway availability via `local-health.js` (periodic GET `/v1/models`). Model `auto` = free routing across 290+ providers. |

**Adding a provider = one folder calling `defineProvider`.** No `src/llm.js` switch edit, no
`DEFAULTS` slice, no Settings-UI edit (R3 auto-builds from `configurableSettings`); `defaultSettings`
folds into the store automatically. OpenAI-compatible gateways share
[openai-compat.js](../../src/providers/llm/openai-compat.js) (the Ollama template for "no real key").
Shared helpers (lazy `child('llm')` logger guard + `stripDataUrl`) live in
[src/providers/llm/shared.js](../../src/providers/llm/shared.js), kept BELOW `src/llm.js` in the
require graph so providers never pull llm.js (cycle avoidance). Provider modules lazy-require their
SDK **inside** `createEngine` so loading the registry pulls no network SDK.

## Image/screenshot attachment differs per provider

Each provider's `createEngine` attaches the optional screenshot to the **last user turn**
differently (JSON field, content part, or inline data). `stripDataUrl` (in
[src/providers/llm/shared.js](../../src/providers/llm/shared.js)) keeps the mime so all three
attach correctly. Screenshots are JPEG-capped to a 1568-px longest edge with a 1.5 s TTL cache
([src/screen.js](../../src/screen.js), Phase-5 vision).

## STT — `createSTT(settings)` (decoupled, ADR-002)

Anthropic has no audio API, so STT is a **separate** factory. It builds a fallback chain
from audio-capable keys, **openai → gemini**, and falls across providers on error. A
`sttDisabled` latch in [main.js](../../main.js) stops retry spam once the chain returns
403/401/`model_not_found`; `settings:set` resets it.

| Provider | Streaming | Batch | Notes |
|---|---|---|---|
| faster-whisper (local) | yes | yes | Managed Python service (venv spawn + JSON-RPC). Order 10. |
| assemblyai | yes | no | `wss://streaming.assemblyai.com/v3/ws`. Auth via `Authorization` header (raw API key). Audio: pcm_s16le binary frames (~50ms chunks). Reconnect with exponential backoff; latches after 3 failures. Order 15. |
| deepgram | yes | yes | `wss://api.deepgram.com/v1/listen` (streaming) + `POST https://api.deepgram.com/v1/listen` (batch). Auth via `Authorization: Token <key>`. Binary Int16 PCM streaming; raw WAV batch. Hand-rolled WsClient (no SDK). Reconnect with exponential backoff; latches after 3 failures. Order 17. |
| openai | no | yes | Whisper API (`audio.transcriptions`). Order 20. |
| groq | no | yes | OpenAI-compatible endpoint (`api.groq.com/openai/v1`). Uses `openai` SDK with custom `baseURL`. Fast inference. Order 25. |
| gemini | no | yes | `generateContent` with inline audio. Order 30. |
| omni | no | yes | Local OmniRoute gateway (`localhost:20128/v1`). OpenAI-compatible `audio.transcriptions`. Ready reflects actual gateway availability via `local-health.js`. Order 35. |
| external-ws | yes | no | User-run faster-whisper WS server. Order 40. |
| ollama | yes | yes | Delegates to managed faster-whisper engine (same manager, different id). Order 50 — only activates when explicitly selected; never interferes with `auto`. |

- **OpenAI Whisper** — one key does chat + transcription, **but** a project key restricted
  to chat-only models **403s on Whisper** (common user pitfall → README troubleshooting).
- **Gemini** — one key does chat + transcription.
- **Faster-whisper / Deepgram** — **decided** (ADR-006), implemented as a local streaming
  WS server with cue as client + POST batch fallback; see [implementation-plan.md](implementation-plan.md)
  Phase 3 and a planned `docs/faster-whisper-setup.md`.
- **AssemblyAI** — real-time streaming via v3 WebSocket API. API key set in Settings → API Keys.
  Protocol reference: `assemblyai` npm package v4.36.4 (NOT used as dependency — hand-rolled
  using WsClient from external-ws). Provider descriptor auto-registers; Settings UI auto-builds
  from `configurableSettings`.
- **Groq** — fast batch transcription via OpenAI-compatible endpoint (`api.groq.com/openai/v1`).
  Uses the `openai` npm package with a custom `baseURL`. API key set in Settings → API Keys.
  Supported models: `whisper-large-v3-turbo` (default), `whisper-large-v3`, `distil-whisper-large-v3-en`.

## Error normalization (ADR-011)

[src/errors.js](../../src/errors.js) `normalizeSDKError(err, provider) →
{ status, code, provider, message, suggestion }`. **status → suggestion map:**

| status/code | suggestion |
|---|---|
| 401 | Invalid API key — re-paste it in Settings. |
| 403 | Key lacks access to that model — check provider permissions or pick another provider. |
| 429 | Rate limit — wait, or switch provider. |
| ≥500 | Upstream provider trouble — retry shortly or switch provider. |
| `model_not_found` | Fix the model name in Settings. |
| network (`ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` / …) or status 0 | Could not reach provider — check connection/endpoint. |
| (else) | Something went wrong with the provider request — retry or check Settings. |

`userMessage(e)` builds the IPC `llm:error` bubble string from the normalized object.
