#!/usr/bin/env python3
"""cue local Speech-to-Text service.

A single Python process spawned and managed by cue's main process
(src/stt-process.js). It speaks a line-delimited JSON-RPC protocol over
stdin/stdout; the rest of the app never imports or talks to Python directly.

  - stdout: one JSON object per line — the protocol (responses echo the request
    `id`; events have no `id`). Spawned with `python -u` and every write is
    flushed so the pipe never stalls.
  - stdin: one JSON request per line.
  - stderr: free-form logs (Node captures these for diagnostics / "last error").

Transcription is faster-whisper (CTranslate2 backend). VAD endpoint detection is
ported from the reference server in docs/faster-whisper-setup.md: voiced 30 ms
frames accumulate into an utterance; partials re-transcribe the growing buffer
roughly twice a second; a ~700 ms trailing-silence gap finalizes the utterance.
If `webrtcvad` is unavailable an RMS energy gate takes over — the protocol does
not care how the service decides an endpoint.

Models cache under a caller-supplied `download_root` (cue keeps it under
userData/stt-models/), so downloads persist across runs and are never
re-fetched. A `load` auto-downloads a missing model on first use.

Runs on Python 3.10+. The venv + pinned deps (python/requirements.txt) are
created by Node before this process starts, so imports here can assume they are
installed. No CUDA assumption: compute_type defaults to int8 on CPU. See
docs/faster-whisper-setup.md for the CUDA opt-in.
"""

import asyncio
import base64
import json
import os
import shutil
import sys
import time

# Logging is configured once at startup from CUE_STT_LOG_* env (Node passes them on
# spawn). stdout stays the JSON-RPC protocol; stderr carries one JSON log line per
# record so Node can forward each through Pino at the matching level. See
# python/cue_stt_logging.py and ADR-014. Configured at import time (not deferred to
# main()) so the webrtcvad probe below — and any import-time warning — emits through
# the configured sinks, not Loguru's default pretty handler.
from cue_stt_logging import setup_logging, get_logger
setup_logging()
log = get_logger("cue_stt_service")

# ---- audio / VAD constants (ported from docs/faster-whisper-setup.md) ----
SR = 16000
VAD_AGG = 2                  # webrtcvad aggressiveness 0–3
VAD_MS = 30                  # webrtcvad frame sizes are 10/20/30 ms
VAD_BYTES = int(SR * 2 * VAD_MS / 1000)  # 960 bytes per 30 ms Int16 frame
END_MS = 700                 # trailing silence that ends an utterance
MIN_SP_MS = 400             # ignore voiced blips shorter than this
PARTIAL_EVERY_S = 0.4       # re-transcribe cadence while speech continues
ENERGY_GATE = 0.010         # RMS fallback gate if webrtcvad is unavailable

# Known faster-whisper model sizes -> HuggingFace repo. `models_list` reports
# these as candidates and flags which are already cached under download_root.
MODELS = ["tiny", "base", "small", "medium", "medium-large-v3", "large-v3"]
ORG = "Systran"            # Systran/faster-whisper-<name>


def hf_repo(name):
    return f"{ORG}/faster-whisper-{name}"


# ---- a JSON line responder/emitter ---------------------------------------
def write_json(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def respond(req_id, ok=True, result=None, error=None):
    if req_id is None:
        return
    out = {"id": req_id, "ok": ok}
    if ok:
        out["result"] = result
    else:
        out["error"] = error
    write_json(out)


def emit(method, **fields):
    """Event to the host (no id). Used for partial/final/status/progress/error."""
    obj = {"m": method}
    obj.update(fields)
    write_json(obj)


# ---- optional VAD --------------------------------------------------------
try:
    import webrtcvad  # type: ignore
    _VAD = webrtcvad.Vad(VAD_AGG)
    HAVE_VAD = True
except Exception:  # webrtcvad needs a C toolchain; not always buildable
    _VAD = None
    HAVE_VAD = False
    log.warning("webrtcvad unavailable — using RMS energy gate instead")


_NUMPY = None


def _np():
    global _NUMPY
    if _NUMPY is None:
        import numpy  # cold import; faster-whisper already pulled it in
        _NUMPY = numpy
    return _NUMPY


def to_float(pcm_bytes):
    np = _np()
    return np.frombuffer(pcm_bytes, dtype="int16").astype("float32") / 32768.0


def _have_cuda():
    """faster-whisper uses CTranslate2 (not torch) for inference, so the CUDA
    probe is CTranslate2's device count — torch is not a dependency and may be
    absent entirely. Returns False if CTranslate2 isn't importable yet."""
    try:
        import ctranslate2  # type: ignore  (a faster-whisper dep)
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def is_voiced(frame_bytes):
    if HAVE_VAD:
        try:
            return _VAD.is_speech(bytes(frame_bytes), SR)
        except Exception:
            return False
    # energy fallback (portable)
    import numpy as np
    x = np.frombuffer(frame_bytes, dtype="int16")
    return float(abs(x).mean()) > ENERGY_GATE * 32768.0


# ---- the model + one streaming session -----------------------------------
class Service:
    def __init__(self):
        self.model = None
        self.model_name = None
        self.device = None
        self.compute_type = None
        self.cuda = False
        self.download_root = None
        # streaming sessions: sid -> Session
        self.sessions = {}
        self._next_sid = 1
        self.fw_version = None
        self._pyver = None
        self.last_error = None
        self._started = False

    # -- introspection ----------------------------------------------------
    def hello(self):
        import platform
        self.cuda = _have_cuda()
        self._pyver = platform.python_version()
        try:
            import faster_whisper  # type: ignore
            self.fw_version = getattr(faster_whisper, "__version__", "unknown")
        except Exception:
            self.fw_version = None
        return {
            "python_version": self._pyver,
            "cuda": self.cuda,
            "faster_whisper_version": self.fw_version,
            "have_vad": HAVE_VAD,
        }

    # -- model lifecycle --------------------------------------------------
    def _resolve_device(self, device, compute_type):
        dev = (device or "auto").lower()
        if dev == "auto":
            dev = "cuda" if self.cuda else "cpu"
        ct = compute_type
        if not ct or ct == "auto":
            ct = "float16" if dev == "cuda" else "int8"
        return dev, ct

    async def load(self, name, device="auto", compute_type="auto", language=None,
                   vad=True, download_root=None, local_files_only=False):
        """Load a model into memory.

        ``local_files_only`` is the load's contract with the host: the host downloads
        the model first (via ``model_download``, which emits progress), then loads it
        with ``local_files_only=True`` so a ``load`` can NEVER block on a silent
        network download (the old root cause of the "local STT hangs forever" symptom —
        ``local_files_only=False`` downloaded silently with no progress events, and
        the host gave the call an infinite ``timeout:0``). A cached ``local_files_only``
        load is fast and bounded; a missing cache surfaces a real, actionable error.
        """
        from faster_whisper import WhisperModel  # type: ignore
        self.download_root = download_root or self.download_root
        dev, ct = self._resolve_device(device, compute_type)
        log.bind(model=name, device=dev, compute_type=ct, cuda=self.cuda,
                 cache_only=bool(local_files_only)).info("model loading")
        t0 = time.monotonic()
        try:
            model = await asyncio.to_thread(
                WhisperModel, name, device=dev, compute_type=ct,
                download_root=self.download_root, local_files_only=local_files_only)
        except Exception:
            log.bind(model=name, device=dev, cache_only=bool(local_files_only)).exception("model load failed")
            raise
        self.model = model
        self.model_name = name
        self.device = dev
        self.compute_type = ct
        log.bind(model=name, device=dev, compute_type=ct,
                 load_ms=int((time.monotonic() - t0) * 1000)).info("model ready")
        emit("status", status="ready", model=name, device=dev,
             compute_type=ct, cuda=self.cuda, vad=bool(vad))
        return {"model": name, "device": dev, "compute_type": ct}

    def unload(self):
        log.bind(model=self.model_name).info("model unloading")
        self.model = None
        self.model_name = None
        for s in list(self.sessions.values()):
            s.clear()
        self.sessions.clear()
        emit("status", status="unloaded")
        log.info("model unloaded")
        return {}

    # -- batch transcribe (WAV bytes -> text) -----------------------------
    async def transcribe(self, wav_b64, language=None):
        if self.model is None:
            raise ValueError("no model loaded")
        log.bind(language=language).info("transcribe request")
        wav = base64.b64decode(wav_b64)
        # strip a standard 44-byte WAV header if present
        pcm = wav[44:] if wav[:4] == b"RIFF" else wav
        text = await self._whisper(to_float(pcm), language)
        return {"text": text}

    async def _whisper(self, audio_float, language=None, beam_size=1):
        # Inference timing: faster-whisper.transcribe is the hot (CPU/GPU-bound) call.
        # Measured here, not in transcribe(), so every caller (batch + partial + final)
        # reports its own inference duration in the structured log.
        t0 = time.monotonic()
        segs, _info = await asyncio.to_thread(
            self.model.transcribe, audio_float, language=language,
            beam_size=beam_size, vad_filter=False)
        text = " ".join(s.text.strip() for s in segs).strip()
        log.bind(model=self.model_name, beam_size=beam_size, language=language,
                 duration_ms=int((time.monotonic() - t0) * 1000),
                 chars=len(text)).info("inference")
        return text

    # -- streaming --------------------------------------------------------
    async def stream_start(self, language=None, vad=True):
        if self.model is None:
            raise ValueError("no model loaded")
        sid = str(self._next_sid)
        self._next_sid += 1
        self.sessions[sid] = Session(self, sid, language, vad)
        log.bind(sid=sid, language=language, vad=bool(vad)).info("stream_start")
        emit("status", status="streaming", sid=sid)
        return {"sid": sid}

    def stream_audio(self, sid, pcm_b64):
        s = self.sessions.get(sid)
        if s is None:
            return False
        pcm = base64.b64decode(pcm_b64)
        s.feed(pcm)
        return True

    def stream_stop(self, sid):
        s = self.sessions.pop(sid, None)
        if s:
            s.finalize_now()
        log.bind(sid=sid).info("stream_stop")
        return {}

    # -- model cache management ------------------------------------------
    # `download_root` is sticky once `load` sets it, but a model_download/delete may arrive
    # BEFORE any load (the Settings Download button, or the CLI, never load first). Each
    # method accepts an explicit download_root that overrides the sticky one; the host always
    # passes userData/stt-models so the cache lives where the Settings scan + CLI look.
    def _cache_dir(self, name, download_root=None):
        root = download_root or self.download_root
        if not root:
            return None
        return os.path.join(root, f"models--{ORG}--faster-whisper-{name}")

    def models_list(self, download_root=None):
        if download_root:
            self.download_root = download_root
        cached = []
        for name in MODELS:
            d = self._cache_dir(name)
            cached.append({"name": name,
                           "cached": bool(d and os.path.isdir(d))})
        return {"models": cached, "active": self.model_name,
                "download_root": self.download_root}

    async def model_download(self, name, download_root=None):
        from faster_whisper import WhisperModel  # type: ignore
        if download_root:
            self.download_root = download_root
        log.bind(model=name).info("model downloading")
        emit("progress", phase="downloading", model=name, pct=None)
        # instantiate into the cache dir (downloads if missing; cache hit otherwise)
        dev, ct = self._resolve_device("cpu", "int8")
        try:
            await asyncio.to_thread(
                WhisperModel, name, device=dev, compute_type=ct,
                download_root=self.download_root, local_files_only=False)
        except Exception:
            log.bind(model=name).exception("model download failed")
            raise
        emit("progress", phase="done", model=name, pct=100)
        log.bind(model=name).info("model downloaded")
        return {"model": name}

    def model_delete(self, name, download_root=None):
        d = self._cache_dir(name, download_root)
        if not d or not os.path.isdir(d):
            log.bind(model=name).info("model delete skipped (not cached)")
            return {"deleted": False, "error": "not cached"}
        if self.model_name == name:
            self.model = None
            self.model_name = None
            emit("status", status="unloaded", reason="model deleted")
        shutil.rmtree(d, ignore_errors=True)
        log.bind(model=name).info("model deleted")
        return {"deleted": True, "model": name}

    def diagnostics(self):
        return {
            "ready": self.model is not None,
            "status": "ready" if self.model else ("unloaded" if self._started else "starting"),
            "active_model": self.model_name,
            "device": self.device,
            "compute_type": self.compute_type,
            "cuda": self.cuda,
            "have_vad": HAVE_VAD,
            "python_version": getattr(self, "_pyver", None),
            "faster_whisper_version": self.fw_version,
            "last_error": getattr(self, "last_error", None),
        }

    def shutdown(self):
        for s in list(self.sessions.values()):
            s.clear()
        self.sessions.clear()
        return {}


class Session:
    """One audio channel inside a streaming session (you OR them)."""

    def __init__(self, svc, sid, language, vad):
        self.svc = svc
        self.sid = sid
        self.language = None if (language is None or language == "auto") else language
        self.vad = bool(vad)
        self.speech = bytearray()
        self.in_speech = False
        self.silence_ms = 0
        self.last_partial = 0.0
        self.partial_in_flight = False
        self._closed = False
        # sid-bound child so every feed/partial/final log carries the session id.
        self.log = get_logger("cue_stt_service").bind(sid=sid)

    def feed(self, pcm):
        if self._closed or not self.vad:
            self.speech.extend(pcm)
            return
        for i in range(0, len(pcm) - VAD_BYTES + 1, VAD_BYTES):
            frame = pcm[i:i + VAD_BYTES]
            if is_voiced(frame):
                if not self.in_speech:
                    self.log.debug("speech start")  # ~16 feeds/s; log only the onset
                self.speech.extend(frame)
                self.in_speech = True
                self.silence_ms = 0
                self._maybe_partial()
            elif self.in_speech:
                self.silence_ms += VAD_MS
                if self.silence_ms >= END_MS:
                    self._emit_final_on_loop()

    def _maybe_partial(self):
        now = time.monotonic()
        if self.partial_in_flight:
            return
        if now - self.last_partial < PARTIAL_EVERY_S:
            return
        if len(self.speech) < VAD_BYTES:
            return
        self.last_partial = now
        self.partial_in_flight = True
        snapshot = bytes(self.speech)  # safe: loop thread; thread gets an immutable copy

        async def go():
            try:
                text = await self.svc._whisper(to_float(snapshot), self.language)
                if text:
                    emit("partial", sid=self.sid, text=text, ts=_now_ms())
            except Exception as e:
                self.log.warning("partial transcription error", error=str(e))
            finally:
                self.partial_in_flight = False

        asyncio.ensure_future(go())

    def _emit_final_on_loop(self):
        if len(self.speech) < VAD_BYTES * (MIN_SP_MS // VAD_MS):
            self.speech.clear()
            self.in_speech = False
            self.silence_ms = 0
            return
        snapshot = bytes(self.speech)
        self.speech.clear()
        self.in_speech = False
        self.silence_ms = 0

        async def go():
            try:
                text = await self.svc._whisper(to_float(snapshot), self.language)
                if text:
                    emit("final", sid=self.sid, text=text, ts=_now_ms())
                self.log.debug("utterance finalized", chars=len(text))
            except Exception as e:
                self.log.warning("final transcription error", error=str(e))

        asyncio.ensure_future(go())

    def finalize_now(self):
        if self.speech:
            self._emit_final_on_loop()
        self._closed = True

    def clear(self):
        self._closed = True
        self.speech.clear()


def _now_ms():
    return int(time.time() * 1000)


# ---- read loop: one JSON request per stdin line --------------------------
async def main(svc):
    svc._pyver = __import__("platform").python_version()
    svc._started = True
    loop = asyncio.get_running_loop()
    log.bind(python=svc._pyver, vad=HAVE_VAD).info("stt service starting")

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break  # stdin closed (host shut us down)
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            log.warning("unparseable request line", raw=line[:120])
            emit("error", error="unparseable request line")
            continue
        req_id = req.get("id")
        method = req.get("m") or req.get("method")
        params = req.get("params") or {k: v for k, v in req.items()
                                       if k not in ("id", "m", "method")}
        try:
            result = await dispatch(svc, method, params)
            respond(req_id, True, result)
        except Exception as e:
            svc.last_error = f"{e}"
            # log.exception attaches the full traceback (replaces traceback.print_exc).
            log.bind(method=method, sid=req_id).exception("handler error")
            emit("error", error=f"{e}")
            respond(req_id, False, error=f"{e}")

    log.info("stt service shutting down")
    await svc.shutdown()
    log.info("stt service stopped")


async def dispatch(svc, method, p):
    if method == "hello":
        return svc.hello()
    if method == "load":
        return await svc.load(p.get("name"), p.get("device", "auto"),
                              p.get("compute_type", "auto"), p.get("language"),
                              p.get("vad", True), p.get("download_root"),
                              p.get("local_files_only", False))
    if method == "unload":
        return svc.unload()
    if method == "transcribe":
        return await svc.transcribe(p.get("wav_b64"), p.get("language"))
    if method == "stream_start":
        return await svc.stream_start(p.get("language"), p.get("vad", True))
    if method == "stream_audio":
        ok = svc.stream_audio(p.get("sid"), p.get("pcm_b64"))
        return {"ok": ok}
    if method == "stream_stop":
        return svc.stream_stop(p.get("sid"))
    if method == "model_download":
        return await svc.model_download(p.get("name"), p.get("download_root"))
    if method == "model_delete":
        return svc.model_delete(p.get("name"), p.get("download_root"))
    if method == "models_list":
        return svc.models_list()
    if method == "diagnostics":
        return svc.diagnostics()
    if method == "shutdown":
        return svc.shutdown()
    raise ValueError(f"unknown method: {method}")


if __name__ == "__main__":
    try:
        asyncio.run(main(Service()))
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        pass
