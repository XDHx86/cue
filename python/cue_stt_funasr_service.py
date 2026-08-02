#!/usr/bin/env python3
"""cue local FunASR Speech-to-Text service.

A managed Python process spawned by cue's main process (src/stt-process.js)
for offline FunASR / Paraformer transcription. It speaks the same line-delimited
JSON-RPC over stdin/stdout as python/cue_stt_service.py — same protocol, same
logging, same Node-side lifecycle — so the shared manager (src/stt-process.js)
spawns and tears this down identically to the faster-whisper service.

FunASR is an offline engine: it transcribes complete audio segments and has no
built-in streaming API. For a *streaming* feel we wrap the same webrtcvad
endpointing loop that faster-whisper uses (30 ms frames, ~0.4 s partial
cadence, ~700 ms trailing-silence finalization), re-transcribing the growing
utterance buffer each cycle. Inaccuracy is minimal with Paraformer-large
(~1.3 GB), which segments and transcribes long audio in one call; the
re-transcription overhead is tens of milliseconds per partial, well within
the 0.4 s cadence on desktop hardware.

Models cache under download_root via modelscope snapshot_download.
First-time import fetches the model (~1.3 GB) so download is separated from
pip install; the Node side manages download via `model_download` (calls
snapshot_download) BEFORE `load`, same ADR-016 decoupling as faster-whisper.

Runs on Python 3.10+. The venv + pinned deps (python/requirements-funasr.txt)
are created by Node before this process starts, so imports here assume they
are installed. CPU inference is the default; torch.cuda.is_available()
enables GPU path when CUDA is present."""
import asyncio
import base64
import json
import os
import sys
import time
import traceback

# Shared logging is the same as the faster-whisper service: config from
# CUE_STT_LOG_* env (set by Node on spawn), one JSON record per line on stderr,
# stdout stays the protocol pipe. See python/cue_stt_logging.py and ADR-014.
from cue_stt_logging import setup_logging, get_logger
setup_logging()
log = get_logger("funasr_service")


# ---- audio / VAD constants (mirror python/cue_stt_service.py) ------------
SR = 16000
VAD_MS = 30
VAD_BYTES = int(SR * 2 * VAD_MS / 1000)  # 960 bytes per 30 ms Int16 frame


def _env_int(name, default):
    v = os.environ.get(name)
    if v is None or v == "": return default
    try: n = int(v)
    except (TypeError, ValueError): return default
    return n if n > 0 else default


def _env_float(name, default):
    v = os.environ.get(name)
    if v is None or v == "": return default
    try: n = float(v)
    except (TypeError, ValueError): return default
    return n if n > 0 else default


VAD_AGG = _env_int("CUE_STT_VAD_AGG", 2)
END_MS = _env_int("CUE_STT_VAD_END_MS", 700)
MIN_SP_MS = _env_int("CUE_STT_MIN_SPEECH_MS", 400)
PARTIAL_EVERY_S = _env_float("CUE_STT_PARTIAL_EVERY_S", 0.4)
ENERGY_GATE = _env_float("CUE_STT_ENERGY_GATE", 0.010)

# Known FunASR model names -> modelscope repo id.
# NOTE: kept in sync with src/stt-funasr-models.js (the drift-guard test forces them to be equal).
_MODELSCOPE_REPOS = {
    "paraformer-large-zh": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1",
    "paraformer-large-en": "iic/speech_paraformer-large_asr_nat-en-16k-common-vocab10028-tensorflow1",
    "paraformer-zh": "iic/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1",
}
MODELS = list(_MODELSCOPE_REPOS.keys())


# ---- a JSON line responder/emitter (same as the faster-whisper service) ------
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
    obj = {"m": method}
    obj.update(fields)
    write_json(obj)


# ---- webrtcvad / energy gate (same pattern as faster-whisper service) ----
try:
    import webrtcvad  # type: ignore
    _VAD = webrtcvad.Vad(VAD_AGG)
    HAVE_VAD = True
except Exception:
    _VAD = None
    HAVE_VAD = False
    # message logged via structured logger
    log.warning("webrtcvad unavailable — using RMS energy gate instead")


def is_voiced(frame_bytes):
    if HAVE_VAD:
        try:
            return _VAD.is_speech(bytes(frame_bytes), SR)
        except Exception:
            return False
    import numpy as np
    x = np.frombuffer(frame_bytes, dtype="int16")
    return float(abs(x).mean()) > ENERGY_GATE * 32768.0


# ---- streaming session (VAD‑driven offline re-transcribe) ---------------
class Session:
    """Accumulates Int16 PCM audio and runs Paraformer on each utterance
    endpointed via webrtcvad / energy gate."""

    def __init__(self, svc, sid):
        self.svc = svc
        self.sid = sid
        self.speech = bytearray()
        self.last_partial = 0.0
        self.finalized = False
        log.debug("session started", sid=sid)

    def feed(self, pcm_bytes):
        if self.finalized:
            return


        pos = 0
        data = pcm_bytes
        while pos + VAD_BYTES <= len(data):
            frame = data[pos : pos + VAD_BYTES]
            if is_voiced(frame):
                # extend the speech buffer, or start a new utterance from silence
                self.speech.extend(frame)

                self._maybe_partial()
            pos += VAD_BYTES

    def _maybe_partial(self):
        if len(self.speech) == 0:
            return
        now = time.time()
        if now - self.last_partial >= PARTIAL_EVERY_S:
            self.last_partial = now
            self._transcribe("partial")

    def _transcribe(self, kind):
        if len(self.speech) == 0:
            return
        wav_bytes = self._to_wav(bytes(self.speech))
        text = self.svc.transcribe_raw(wav_bytes)
        emit("partial" if kind == "partial" else "final", sid=self.sid, text=text, ts=time.time())

    def _to_wav(self, pcm):
        import struct
        import wave
        from io import BytesIO
        wavfile = BytesIO()
        with wave.open(wavfile, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm)
        return wavfile.read()

    def flush(self):
        if self.finalized:
            return
        self.finalized = True
        if len(self.speech) == 0:
            emit("status", status="empty", sid=self.sid)
            return
        self._transcribe("final")


# ---- the managed service ----------------------------------------------------
class Service:
    def __init__(self):
        self.model = None
        self.model_name = None
        self.device = None
        self.models_dir = None
        self.cuda = False
        self.sessions = {}
        self._next_sid = 1
        self.funasr_version = None
        self._pyver = None
        self.last_error = None

    def hello(self):
        import platform
        self._pyver = platform.python_version()
        try:
            import torch
            self.cuda = torch.cuda.is_available()
        except Exception:
            self.cuda = False

        try:
            import funasr
            self.funasr_version = getattr(funasr, "__version__", "unknown")
        except Exception:
            self.funasr_version = None

        return {
            "python_version": self._pyver,
            "cuda": self.cuda,
            "funasr_version": self.funasr_version,
        }

    def model_download(self, info):
        name = info.get("model") or info.get("name")
        self.models_dir = info.get("download_root") or self.models_dir
        if not self.models_dir:
            return {"ok": False, "error": "models_dir not set — provide download_root"}
        repo = _MODELSCOPE_REPOS.get(name)
        if not repo:
            return {"ok": False, "error": f"unknown model: {name}"}

        from modelscope.hub.snapshot_download import snapshot_download as sd
        try:
            dest = sd(repo, cache_dir=self.models_dir)
            return {"ok": True, "dest": dest}
        except Exception as e:
            log.error("model download failed: %s", e)
            return {"ok": False, "error": str(e)}

    def model_delete(self, info):
        self.models_dir = info.get("download_root") or self.models_dir
        if not self.models_dir:
            return {"ok": False, "error": "models_dir not set — provide download_root"}
        name = info.get("model") or info.get("name")
        repo = _MODELSCOPE_REPOS.get(name)
        if not repo:
            return {"ok": False, "error": f"unknown model: {name}"}

        removed = False
        try:
            import shutil
            p = os.path.join(self.models_dir, repo.replace("/", "__").replace(":", "__"))
            if os.path.isdir(p):
                shutil.rmtree(p)
                removed = True
            return {"ok": True, "removed": removed}
        except Exception as e:
            log.error("model delete failed: %s", e)
            return {"ok": False, "error": str(e)}

    def models_list(self, info):
        d = info.get("download_root") or self.models_dir
        if not d:
            return []
        out = []
        for name, repo in _MODELSCOPE_REPOS.items():
            cached = False
            try:
                p = os.path.join(d, repo.replace("/", "__").replace(":", "__"))
                cached = os.path.isdir(p)
            except Exception:
                pass
            out.append({"name": name, "repo": repo, "cached": cached})
        return out

    def load(self, info):
        name = info.get("model") or info.get("name")
        device = info.get("device") or "cpu"
        self.models_dir = info.get("download_root") or self.models_dir
        repo = _MODELSCOPE_REPOS.get(name)
        if not repo:
            raise RuntimeError(f"unknown model: {name}")

        try:
            from funasr import AutoModel
        except ImportError as e:
            raise RuntimeError(f"funasr not installed: {e}")

        try:
            model = AutoModel(
                model=repo,
                model_revision="master",
                disable_update=True,  # don't check for model updates during load
                device=device,
            )
        except Exception as e:
            error_msg = str(e)
            log.error("load failed (%s/%s): %s", name, device, error_msg)
            self.last_error = error_msg
            raise RuntimeError(error_msg) from e

        self.model = model
        self.model_name = name
        self.device = device
        self.last_error = None
        emit("status", status="loaded", model=name, device=device)
        log.info("loaded model=%s device=%s cuda=%s", name, device, self.cuda)

    def transcribe_raw(self, wav_bytes):
        if self.model is None:
            raise RuntimeError("no model loaded")

        try:
            from io import BytesIO
            import wave
            import numpy as np

            wav = BytesIO(wav_bytes)
            wf = wave.open(wav, "rb")
            pcm = wf.readframes(wf.getnframes())
            np_arr = np.frombuffer(pcm, dtype="int16")
            audio = np_arr.astype(np.float32) / 32768.0
            res = self.model.generate(input=audio)
            text = res[0]["text"] if isinstance(res, list) and len(res) > 0 else ""
            return (text or "").strip()
        except Exception as e:
            error_msg = str(e)
            self.last_error = error_msg
            log.error("transcribe error: %s", error_msg)
            raise

    def shutdown(self):
        for s in list(self.sessions.values()):
            try: s.flush()
            except Exception: pass
        self.sessions.clear()
        self.model = None
        log.info("shutdown complete")


# ---- the RPC dispatch loop ---------------------------------------------------
svc = Service()


def _dispatch(method, params, req_id):
    if method == "hello":
        respond(req_id, result=svc.hello())
        return False
    if method == "list_models":
        respond(req_id, result=svc.models_list(params or {}))
        return False
    if method == "model_download":
        r = svc.model_download(params or {})
        respond(req_id, r["ok"], result={"dest": r.get("dest")} if r.get("ok") else None, error=r.get("error"))
        return False
    if method == "model_delete":
        r = svc.model_delete(params or {})
        respond(req_id, r["ok"], result={"removed": r.get("removed")}, error=r.get("error"))
        return False
    if method == "load":
        try:
            svc.load(params or {})
            respond(req_id, result={"model": svc.model_name, "device": svc.device, "cuda": svc.cuda})
        except Exception as e:
            svc.last_error = str(e)
            respond(req_id, ok=False, error=svc.last_error)
        return False
    if method == "transcribe":
        raw = params.get("wav_b64")
        if not raw:
            respond(req_id, ok=False, error="wav_b64 required")
            return False
        try:
            wav = base64.b64decode(raw)
            text = svc.transcribe_raw(wav)
            respond(req_id, result={"text": text})
        except Exception as e:
            svc.last_error = str(e)
            log.error("transcribe error: %s", e)
            respond(req_id, ok=False, error=svc.last_error)
        return False
    if method == "stream_start":
        sid = svc._next_sid
        svc._next_sid += 1
        session = Session(svc, sid)
        svc.sessions[sid] = session
        respond(req_id, result={"sid": sid})
        return False
    if method == "stream_audio":
        sid = (params or {}).get("sid")
        pcm_b64 = (params or {}).get("pcm_b64")
        if not sid or sid not in svc.sessions:
            respond(req_id, ok=False, error="unknown or missing sid")
            return False
        try:
            if isinstance(pcm_b64, str):
                data = base64.b64decode(pcm_b64)
            else:
                data = bytes(pcm_b64) if pcm_b64 else b""
        except Exception:
            respond(req_id, ok=False, error="invalid base64")
            return False
        try:
            svc.sessions[sid].feed(data)
        except Exception as e:
            svc.last_error = str(e)
            log.warning("stream_audio failed: %s", e)
        respond(req_id, result={"ack": True})
        return False
    if method == "stream_stop":
        sid = (params or {}).get("sid")
        if sid and sid in svc.sessions:
            try:
                svc.sessions[sid].flush()
            finally:
                del svc.sessions[sid]
        respond(req_id, result={"sid": sid})
        return False
    if method == "diagnostics":
        sids = [int(s) for s in svc.sessions]
        respond(req_id, result={
            "model": svc.model_name,
            "device": svc.device,
            "cuda": svc.cuda,
            "active_sids": sids,
            "last_error": svc.last_error,
            "version": svc.funasr_version,
        })
        return False
    if method == "shutdown":
        svc.shutdown()
        respond(req_id, result={})
        return True
    respond(req_id, ok=False, error=f"unknown method: {method}")
    return False


async def _main():
    loop = asyncio.get_event_loop()
    bufs = b""
    while True:
        try:
            chunk = await loop.run_in_executor(None, sys.stdin.buffer.read, 4096)
            if not chunk:
                break
        except Exception:
            break
        bufs += chunk
        while b"\n" in bufs:
            line_b, bufs = bufs.split(b"\n", 1)
            line = line_b.decode("utf-8").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            method = obj.get("method") or obj.get("m")
            params = obj.get("params") or {}
            req_id = obj.get("id")
            stop = _dispatch(method, params, req_id)
            if stop:
                break
        if stop:
            break
    svc.shutdown()
    log.info("service stopped")


def _run():
    try:
        asyncio.run(_main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    _run()