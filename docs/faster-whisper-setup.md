# Streaming transcription with faster-whisper

By default cue transcribes in **batches** (every few seconds it sends an audio chunk to OpenAI
Whisper or Gemini). That has second-scale latency. For near-live transcription you can run a
local **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** server and point cue at it:
cue then streams PCM continuously over a WebSocket and renders **partial** transcripts as you
speak, finalizing each utterance when the server's VAD detects an endpoint. Asking (`⌘` `↵`,
soon `Ctrl+Alt+A`) answers from the *live* transcript, mid-speech, without pausing capture.

> cue is the **WebSocket client**; you start the server. No native modules, no new deps in cue —
> the client in [`src/stt-stream.js`](../src/stt-stream.js) is hand-rolled (see the protocol
> below). This page's server is reference Python you adapt to your needs.

## Prerequisites

- Python 3.10+
- `pip install faster-whisper websockets webrtcvad numpy`

macOS note: `webrtcvad` needs a C toolchain (`xcode-select --install`); if that's a hassle, swap
the VAD for an energy gate — the protocol doesn't care how the server decides an endpoint.

## The protocol (authoritative)

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

## Reference server

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
    return np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

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

## Point cue at it

Pick **one**:

- **Settings** (`⌘` `,`) — set **STT provider** to `faster-whisper` (or `auto`) and the
  **faster-whisper endpoint** to `ws://localhost:9080/stream`.
- **`.env`** (see [README](../README.md#use-ollama-local-models) for the `.env` loader):
  ```dotenv
  CUE_STT_PROVIDER=faster-whisper
  CUE_FASTER_WHISPER_URL=ws://localhost:9080/stream
  ```

`auto` (the default) picks faster-whisper when a URL is set and otherwise falls back to the
batch path — so an empty URL means "use Whisper/Gemini as before." cue never sends your audio to
the faster-whisper provider's vendor; it stays on your machine.

Verify with `DEBUG=true` in [`main.js`](../main.js): you'll see `[stt-stream]` lines on connect,
partials, and finals. Kill the server mid-session to confirm the 3-fail latch degrades to batch.

## Troubleshooting

- **No partials render** — confirm cue connected (look for the `stt:status active` badge after
  starting listening). If it's stuck reconnecting, the URL/port is wrong or the server isn't up.
- **Partials but no finals** — the server's VAD isn't declaring endpoints; raise `VAD_AGG` or
  lower `END_MS`.
- **`webrtcvad` won't install** — replace the VAD block with an RMS energy gate
  (`np.abs(audio).mean() > 0.01`) and end an utterance after ~700 ms below the threshold.
- **High CPU** — `WhisperModel("small", compute_type="int8")` is the sweet spot for CPU; use
  `"tiny"` for speed or a GPU-backed model for accuracy.
```
