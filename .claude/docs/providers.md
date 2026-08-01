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
| ollama | [llm/ollama/](../../src/providers/llm/ollama/index.js) | `openai` + local `baseURL: settings.ollama.baseURL \|\| http://localhost:11434/v1`. **Sentinel `apiKey: 'ollama'`** (SDK needs non-empty; Ollama ignores) and **ready = `!!model` only** — the shared engine's `id==='ollama'` branch bypasses the key gate (ADR-005). |

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

- **OpenAI Whisper** — one key does chat + transcription, **but** a project key restricted
  to chat-only models **403s on Whisper** (common user pitfall → README troubleshooting).
- **Gemini** — one key does chat + transcription.
- **Faster-whisper / Deepgram** — **decided** (ADR-006), implemented as a local streaming
  WS server with cue as client + POST batch fallback; see [implementation-plan.md](implementation-plan.md)
  Phase 3 and a planned `docs/faster-whisper-setup.md`.

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
