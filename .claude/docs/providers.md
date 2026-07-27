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

How each LLM/STT provider is wired. Canonical provider detail lives here; see
[src/llm.js](../../src/llm.js) and [src/stt.js](../../src/stt.js) for code.

## LLM — `createLLM(settings)` interface

One `{ stream({ system, turns, imageDataUrl, onToken }) }` over:

| Provider | SDK | Notes |
|---|---|---|
| openai | `openai` | `streamOpenAI`. Image attached to last user turn as `data:image/...;base64,…` (`stripDataUrl` passes the mime through, [llm.js:5](../../src/llm.js#L5)). |
| anthropic | `@anthropic-ai/sdk` | `streamAnthropic`. **Requires `maxTokens`** → pinned 4096 (effectively unlimited). |
| gemini | `@google/genai` | `streamGemini`. |
| nvidia | `openai` + `baseURL: https://integrate.api.nvidia.com/v1` | `streamOpenAI` reused (ADR-005). |
| ollama | `openai` + `baseURL: settings.ollama.baseURL \|\| http://localhost:11434/v1` | `streamOpenAI` reused. **Sentinel `apiKey: 'ollama'`** — SDK constructor needs non-empty; Ollama ignores it. **Ready check bypasses the key** (`provider === 'ollama' ? !!model : (!!apiKey && !!model)`) so the dummy key doesn't block readiness. (ADR-005) |

Adding a provider = DEFAULTS `apiKeys` + `models` entry + a `streamX`/baseURL branch + a
`ready` rule + store auto-switch + renderer Settings UI + `statusText`. The Ollama case is
the working template for "OpenAI-compatible gateway with no real key."

## Image/screenshot attachment differs per provider

Each `streamX` attaches the optional screenshot to the **last user turn** differently
(JSON field, content part, or inline data). `stripDataUrl` keeps the mime so all three
attach correctly. The current full-res PNG path is a known slow spot (Phase-5 vision
improvement: JPEG + longest-edge cap + 1.5 s TTL cache — see
[implementation-plan.md](implementation-plan.md)).

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
