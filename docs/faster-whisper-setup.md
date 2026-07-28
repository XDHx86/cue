# Local Speech-to-Text with faster-whisper

cue can transcribe **on your own machine** — no audio leaves it, no OpenAI/Gemini key needed for
the listening features. There are **two** local paths, picked by the **Transport** setting under
**Settings → Speech-to-Text**:

| Transport | What it is | When to use |
|---|---|---|
| **`auto`** (default) | cue spawns + manages its own Python `faster-whisper` service; falls back to the external WS URL (if set), then to cloud Whisper/Gemini | everyone — this is the recommended path |
| **`local`** | same managed Python service, but forced (no fallback) | you want local-only, even if it fails |
| **`faster-whisper`** | cue is the **client** to a WebSocket server **you** run yourself | advanced — you already run a faster-whisper WS server |
| **`batch`** | the legacy few-second flush loop (cloud Whisper/Gemini) | you only have an API key and want the old behavior |

With `auto`/`local`, cue **manages everything**: it creates a project-local virtualenv, pip-installs
the pinned `faster-whisper` deps once, downloads + caches Whisper models on first use, and
spawns/respawns the Python process. **You never run `pip` after cloning.** CUDA is an opt-in manual
step (see [CUDA](#cuda-gpu-optional)).

> No native modules in cue. The Python service runs out of process over line-delimited JSON-RPC
> (`src/stt-process.js`). Cue streams PCM continuously and renders **partial** transcripts live,
> finalizing each utterance on the service's VAD; asking (`⌘` `↵` / `Ctrl+Alt+A`) answers from the
> *live* transcript, mid-speech, without pausing capture.

---

## The managed engine (auto / local) — zero config

### Prerequisites

- **Python 3.10+** on your `PATH` (`python3` / `python` / `py`). cue picks the first one that
  reports a usable version.
- A C toolchain for `webrtcvad` is *optional*: if `webrtcvad` won't build, the service falls back
  to an RMS energy gate automatically — the protocol doesn't care how an endpoint is decided.

### One-time setup

Pick **one** (both target the same `userData/stt-venv` + `userData/stt-models` the app reuses):

- **From cue** — open **Settings → Speech-to-Text** and click **Prepare service**. cue creates the
  virtualenv, installs `python/requirements.txt`, and verifies faster-whisper imports. Progress
  streams into the diagnostics panel.
- **From the command line** — `npm run stt:setup` (run once after `npm install`):

```bash
npm install
npm run stt:setup        # creates the venv + pins deps + verifies (one-time, idempotent)
```

You only do this once. A change to `python/requirements.txt` re-installs automatically (pinned by a
hash); an unchanged install is a no-op, so startup stays fast.

### Downloading a model

cue needs one faster-whisper model before it can transcribe. Sizes: `tiny` (fastest) → `base` →
`small` (default, the CPU sweet spot) → `medium` → `medium-large-v3` → `large-v3` (smartest).

- **From cue** — Settings → Speech-to-Text → pick a **Model** → **Download**. A first download can
  take minutes; live progress shows in the panel, and the model is cached under `userData/stt-models`
  (never re-fetched). **Delete** frees the space.
- **From the command line**:

```bash
npm run stt:download -- small      # or tiny / base / medium / medium-large-v3 / large-v3
npm run stt:models                # list candidates + which are cached
npm run stt:status                # venv / Python / faster-whisper / CUDA + cache diagnostics
npm run stt:delete   -- small     # remove a cached model
```

A model selected in Settings that isn't cached yet is auto-downloaded on first capture too — but
downloading up front avoids a cold start mid-meeting.

### Point cue at it

- **Settings** (`⌘` `,`) → Speech-to-Text → **Transport** `auto` (default) or `local`, set
  **Model**, and pick **Engine** (only `faster-whisper (local)` is registered today; the selector
  is data-driven so a second engine like whisper.cpp plugs in with no app changes).
- **`.env`** (see the [README](../README.md) for the loader):
  ```dotenv
  CUE_STT_PROVIDER=local          # or auto
  CUE_STT_LOCAL_MODEL=small
  # optional: CUE_STT_LOCAL_DEVICE=cuda   CUE_STT_LOCAL_COMPUTE=float16   CUE_STT_LOCAL_LANGUAGE=en
  ```

`auto` prefers the managed engine when its venv is ready; if not, it falls to the external WS URL
(if any) and then to cloud Whisper/Gemini — so STT keeps working as your environment changes.

### Diagnostics

The **Diagnostics** box in Settings shows the live state: service status (`stopped`/`restarting`/
`ready`/`streaming`/`latched`), venv-ready, Python version, faster-whisper version, CUDA, active
model, and last error. `npm run stt:status` prints the same from the CLI.

### What cue manages for you

- **Venv** — `userData/stt-venv`, created once, re-installed only when `requirements.txt` changes
  (hash-pinned). `ensureVenv()` is idempotent and safe to call on every Prepare.
- **Process lifecycle** — the Python service is spawned on first use (capture start or a Settings
  action), **restarted with exponential backoff if it crashes**, and **latched after 3 consecutive
  failures** so capture degrades to the cloud batch path instead of hammering. On quit, cue sends a
  clean `shutdown`, closes stdin, and kills after a grace — the process never orphans.
- **Models** — cached under `userData/stt-models` in the HuggingFace hub layout
  (`models--Systran--faster-whisper-<name>`). Downloads skip models already cached. The candidate
  list is a paired source of truth between `src/stt-models.js` and `python/cue_stt_service.py:MODELS`.
- **Engine-agnostic seam** — `src/stt-engine.js` registers engines by id; the rest of the app never
  names one. Adding whisper.cpp = one `registerEngine('whisper-cpp', factory)` implementing the same
  `{ start, sendAudio, close }` + onFinal/onPartial/onStatus/onError surface. No change to `main.js`
  or `src/stt-stream.js`.

### CUDA (GPU, optional)

The venv is **CPU-only by default** (`int8`) so `npm install` never pulls the multi-gigabyte CUDA
stack. To use a GPU once:

```bash
# in the cue venv (src/stt-process.js resolves it under userData/stt-venv)
<venv-python> -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12   # per faster-whisper's CUDA notes
```

Then set **Device** to `cuda` (and a GPU `compute_type` like `float16`) in Settings or
`CUE_STT_LOCAL_DEVICE=cuda`. The diagnostics panel reports `CUDA: available` when CTranslate2 sees a
device. CUDA is probed via CTranslate2 (faster-whisper's backend), **not** torch — so it works in a
torch-less venv.

---

## The external server (advanced: you run it)

If you already run your own faster-whisper server, set **Transport** to `faster-whisper` and point
cue at it. cue is the **WebSocket client**; you start the server. The client in
[`src/stt-stream.js`](../src/stt-stream.js) is hand-rolled — see the protocol below.

### Prerequisites

- Python 3.10+
- `pip install faster-whisper websockets webrtcvad numpy`

macOS note: `webrtcvad` needs a C toolchain (`xcode-select --install`); swap the VAD for an energy
gate if that's a hassle — the protocol doesn't care how the server decides an endpoint.

### The protocol (authoritative for the external path)

This is exactly what cue's client sends and parses — implement it on the server side.

1. **Connect** to the WebSocket URL you put in Settings (`ws://host:port/path`) or
   `CUE_FASTER_WHISPER_URL`.
2. **Handshake** — cue sends one **text** frame on connect:
   ```json
   { "sample_rate": 16000, "channels": 1, "language": null }
   ```
   `language: null` means auto-detect; a BCP-47 code (e.g. `"en"`) forces it. Your server may
   ignore any field it doesn't need — default to 16 kHz mono.
3. **Audio** — cue sends **binary** frames of little-endian **Int16** mono PCM at 16 kHz, on a
   ≤60 ms cadence. Frame sizes vary; handle any size and accumulate.
4. **Results** — the server sends **text** frames, JSON on either of two shapes:
   ```json
   { "type": "partial", "text": "so what I mea",  "ts": 1719700000000 }
   { "type": "final",   "text": "so what I mean is", "ts": 1719700000420 }
   ```
   `ts` is an integer epoch-millis (informational — cue falls back to `Date.now()` if absent).
   Send `partial`s freely while speech is in progress; send a `final` once an utterance ends (VAD
   endpoint). cue replaces the channel's live partial on the next `partial` and clears it on a
   `final`, pushing the final into the transcript ring.
5. **Batch fallback** — for the legacy flush loop (used when streaming is unavailable/latched),
   expose a `POST /transcribe` endpoint that accepts the raw WAV bytes with
   `Content-Type: audio/wav` and returns `{ "text": "…" }`.

cue reconnects with exponential backoff (1s → 2s → 4s → 8s cap). After **3 consecutive connect
failures** it latches the channel as inactive and degrades to the batch path; toggling listening
off→on starts a fresh session (counter reset).

### Reference server

A minimal, single-file server: a WebSocket `/stream` endpoint (the protocol above) and a
`POST /transcribe` endpoint (the batch fallback). VAD (`webrtcvad`) does endpoint detection —
it accumulates speech and, after ~700 ms of silence, transcribes the utterance with
faster-whisper and emits a `final`; while speech continues it re-transcribes the growing buffer
roughly twice a second and emits a `partial`.

```python
# faster-whisper-server.py  — reference. Adapt to taste.
import asyncio, json, time

import numpy as np
import webrtcvad
from aiohttp import web
from faster_whisper import WhisperModel
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

SR        = 16000
VAD_AGG   = 2                      # 0–3
VAD_MS    = 30                      # webrtcvad wants 10/20/30 ms frames
VAD_BYTES = int(SR * 2 * VAD_MS / 1000)   # = 960 bytes per 30 ms Int16 frame
END_MS    = 700                     # silence gap that ends an utterance
MIN_SP_MS = 400                     # ignore blips shorter than this
PARTIAL_EVERY_S = 0.4

VAD  = webrtcvad.Vad(VAD_AGG)
MODEL = WhisperModel("small", device="cpu", compute_type="int8")  # "tiny"→faster, "large-v3"→smarter

def to_float(pcm_bytes):
    return np.frombuffer(pcm_bytes, dtype="int16").astype("float32") / 32768.0

async def run_whisper(audio_float, language=None):
    # faster-whisper is sync/CPU-bound — push to a thread so the loop stays live.
    segs, _ = await asyncio.to_thread(
        MODEL.transcribe, audio_float, language=language, beam_size=1, vad_filter=False
    )
    return " ".join(s.text.strip() for s in segs).strip()

async def stream_handler(ws):
    # 1) handshake
    hs = await ws.recv()
    try:
        cfg = json.loads(hs) if isinstance(hs, str) else {}
    except json.JSONDecodeError:
        cfg = {}
    language = cfg.get("language") or None

    speech = bytearray()
    in_speech = False
    silence_since = 0.0
    last_partial = 0.0

    async def emit_partial(force=False):
        nonlocal last_partial
        now = time.monotonic()
        if not force and (now - last_partial) < PARTIAL_EVERY_S:
            return
        if len(speech) < VAD_BYTES:  # nothing yet to transcribe
            return
        text = await run_whisper(to_float(bytes(speech)), language)
        if text:
            await ws.send(json.dumps({"type": "partial", "text": text, "ts": int(time.time()*1000)}))
        last_partial = now

    async def emit_final():
        if len(speech) >= VAD_BYTES * (MIN_SP_MS // VAD_MS):
            text = await run_whisper(to_float(bytes(speech)), language)
            if text:
                await ws.send(json.dumps({"type": "final", "text": text, "ts": int(time.time()*1000)}))
        speech.clear()

    try:
        async for msg in ws:
            if isinstance(msg, str):
                continue  # ignore mid-stream handshakes
            # 2) split the incoming PCM into 30 ms frames for VAD
            for i in range(0, len(msg) - VAD_BYTES + 1, VAD_BYTES):
                frame = msg[i:i + VAD_BYTES]
                voiced = VAD.is_speech(bytes(frame), SR)
                if voiced:
                    speech.extend(frame)
                    in_speech = True
                    silence_since = 0
                    await emit_partial()
                elif in_speech:
                    # a voiced region ended; count trailing silence
                    silence_since = silence_since + VAD_MS if silence_since else VAD_MS
                    if silence_since >= END_MS:
                        in_speech = False
                        silence_since = 0
                        await emit_final()
    except ConnectionClosed:
        return

async def transcribe_handler(request):
    # 3) POST /transcribe — batch fallback for cue's legacy flush loop.
    body = await request.read()
    # strip the WAV header (44 bytes for a standard 16-bit mono file) and transcribe the PCM
    pcm = body[44:] if body[:4] == b"RIFF" else body
    text = await run_whisper(to_float(pcm))
    return web.Response(text=json.dumps({"text": text}), content_type="application/json")

# Wire both together on one aiohttp app (WS /stream + POST /transcribe).
async def main():
    app = web.Application()
    app.router.add_post("/transcribe", transcribe_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 9080)
    await site.start()
    async with serve(stream_handler, "127.0.0.1", 9080):  # same port, different proto (see note)
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    asyncio.run(main())
```

> **Port note:** the snippet runs the HTTP `POST /transcribe` and the WebSocket `/stream` on the
> same port for brevity. In practice give them one port each (or host the WS upgrade behind an
> aiohttp WebSocket route) — the reference is a starting point, not a production design. cue's
> only requirement is that the URL in Settings resolves to the WS endpoint; the POST endpoint's
> host is derived by rewriting the configured `ws://` URL to `http://`.

### Point cue at it

- **Settings** (`⌘` `,`) — set **Transport** to `faster-whisper` (or `auto`) and the
  **External URL** to `ws://localhost:9080/stream`.
- **`.env`**:
  ```dotenv
  CUE_STT_PROVIDER=faster-whisper
  CUE_FASTER_WHISPER_URL=ws://localhost:9080/stream
  ```

Verify with `DEBUG=true` in [`main.js`](../main.js): you'll see `[stt-stream]` lines on connect,
partials, and finals. Kill the server mid-session to confirm the 3-fail latch degrades to batch.

---

## Troubleshooting

**Managed engine:**
- **"Prepare service" / `npm run stt:setup` fails** — check Python 3.10+ is on `PATH`
  (`npm run stt:status` reports what it found). `model_download`/`model_delete` need the service
  running and pass the right `download_root`; if a model downloaded but Settings still shows it
  uncached, the venv root drifted from `userData/stt-models` (delete via the CLI's `stt:status`).
- **No partials render** — confirm the service started (the diagnostics `status` reached `ready`/
  `streaming`); on the first capture after a model change cue re-loads. CUDA set but unavailable →
  the service auto-resolves to CPU on load.
- **Partials but no finals** — the VAD isn't declaring endpoints; if `webrtcvad` is missing the
  RMS energy gate takes over (raise the model size, or check `CUE_STT_LOCAL_VAD`).
- **High CPU** — `small` + `int8` is the CPU sweet spot; use `tiny` for speed, `cuda`+`float16`
  for accuracy at higher throughput.
- **Capture stopped transcribing after the service died 3×** — the manager latches after 3
  consecutive crash-restarts to degrade cleanly to batch; reopen Settings (or change an STT
  setting) to reset, and check the diagnostics `last error`.

**External server:**
- **No partials render** — confirm cue connected (look for the `stt:status active` badge after
  starting listening). If it's stuck reconnecting, the URL/port is wrong or the server isn't up.
- **Partials but no finals** — the server's VAD isn't declaring endpoints; raise `VAD_AGG` or
  lower `END_MS`.
- **`webrtcvad` won't install** — replace the VAD block with an RMS energy gate
  (`np.abs(audio).mean() > 0.01`) and end an utterance after ~700 ms below the threshold.
```
