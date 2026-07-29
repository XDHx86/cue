#!/usr/bin/env python3
"""Centralized STT logging for the cue Python service (Loguru).

One import line for any current or future STT module::

    from cue_stt_logging import setup_logging, get_logger
    log = get_logger("my_module")

`setup_logging()` is called once at service startup (it reads CUE_STT_LOG_* env
vars that the Node manager src/stt-process.js passes to the spawned process), then
every module asks for a module-scoped logger via get_logger(name) — no refactoring
needed to extend logging to the rest of the service.

Invariants:
  - **stdout is reserved for the JSON-RPC protocol** — Loguru NEVER writes to stdout.
    Logs go to: (a) stderr, one JSON object per line, so Node can parse each line and
    forward it through Pino at the matching level ("preserving log levels"); and (b)
    a rotating JSON file under CUE_STT_LOG_DIR (Loguru-native rotation + retention).
  - **No duplicate sinks**: setup_logging() calls logger.remove() first, so calling it
    again (or re-importing) never stacks handlers.
  - **Thread-safe + non-blocking**: every sink uses enqueue=True (Loguru routes records
    through a single queue thread), so the audio/loop thread is never blocked by I/O and
    concurrent transcribe threads can't interleave half-lines.
  - **Full tracebacks**: `logger.exception(...)` (or opt(exception=True)) attaches the
    active exception traceback to record["exception"]; the stderr sink serializes it into
    a `traceback` field, and the serialize=True file sink keeps it in the JSON too.

Loguru is a pure-Python wheel (no compilation) — pinned in python/requirements.txt,
installed into the cue venv by src/stt-process.js. See ADR-014 (.claude/docs/decisions.md).
"""

import json
import os
import sys
import traceback
import threading

try:
    import loguru  # noqa: F401  (imported for the version attr + clarity)
    from loguru import logger
except Exception:  # pragma: no cover - loguru is a declared venv dep; this only guards
    # an accidental run outside the venv so the import error is clear, not a NameError.
    logger = None

_LOCK = threading.Lock()

PYTHON_LOG_FILE = "stt-python.log"
DEFAULT_ROTATE_SIZE_BYTES = 5 * 1024 * 1024   # 5 MB
DEFAULT_ROTATE_COUNT = 5                      # rotated files retained

# pino-ish level names → Loguru level names (Loguru has no FATAL; CRITICAL is highest).
_LEVEL_MAP = {
    "trace": "DEBUG", "debug": "DEBUG",
    "info": "INFO",
    "warn": "WARNING", "warning": "WARNING",
    "error": "ERROR", "err": "ERROR",
    "fatal": "CRITICAL", "critical": "CRITICAL",
}


def _normalize_level(v):
    return _LEVEL_MAP.get(str(v or "info").strip().lower(), "INFO")


def _env_bool(name, default):
    v = os.environ.get(name)
    if v is None:
        return default
    v = v.strip().lower()
    if v in ("false", "0", "off", "no", ""):
        return False
    if v in ("true", "1", "on", "yes"):
        return True
    return default


def _env_int(name, default):
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _stderr_json_sink(message):
    """Custom Loguru sink: one compact JSON line per log on stderr.

    Node (src/stt-process.js onStderr) parses each line and forwards it through Pino
    at the matching level, so the level survives the process boundary. `message` is a
    Loguru Message; `.record` is the structured record dict.
    """
    rec = message.record
    extra = rec["extra"] or {}
    out = {
        "level": rec["level"].name,
        "ts": rec["time"].isoformat(),
        "pid": os.getpid(),
        "module": extra.get("module", "cue-stt"),
        "message": rec["message"],
    }
    # Everything bound via logger.bind(...) except `module` is structured context.
    public = {k: v for k, v in extra.items() if k != "module"}
    if public:
        try:
            json.dumps(public)  # probe serializability; fall back to repr below
        except (TypeError, ValueError):
            public = {k: repr(v) for k, v in public.items()}
        out["extra"] = public
    exc = rec["exception"]
    if exc is not None:
        out["traceback"] = "".join(
            traceback.format_exception(exc.type, exc.value, exc.traceback)
        )
    sys.stderr.write(json.dumps(out, default=str) + "\n")
    sys.stderr.flush()


def setup_logging(level=None, log_dir=None, console=None,
                  rotate_size=None, rotate_count=None):
    """Configure Loguru exactly once. Idempotent (logger.remove() first).

    With no args it reads CUE_STT_LOG_* env (set by the Node manager on spawn), so the
    service module can call setup_logging() at import with no plumbing. Returns the
    configured logger (rarely needed — get_logger() is the entry point).
    """
    if logger is None:
        return None
    if level is None:
        level = os.environ.get("CUE_STT_LOG_LEVEL", "info")
    if log_dir is None:
        log_dir = os.environ.get("CUE_STT_LOG_DIR") or None
    if console is None:
        console = _env_bool("CUE_STT_LOG_CONSOLE", True)
    file_enabled = _env_bool("CUE_STT_LOG_FILE", True)
    if rotate_size is None:
        rotate_size = _env_int("CUE_STT_LOG_ROTATE_SIZE", DEFAULT_ROTATE_SIZE_BYTES)
    if rotate_count is None:
        rotate_count = _env_int("CUE_STT_LOG_ROTATE_COUNT", DEFAULT_ROTATE_COUNT)

    lvl = _normalize_level(level)

    with _LOCK:
        # Remove every existing handler (the default stderr pretty handler + any prior
        # setup) so repeated calls never stack duplicate sinks.
        logger.remove()
        # Default binding so records carry module even when get_logger() isn't used.
        logger.configure(extra={"module": "cue-stt"})

        if file_enabled and log_dir:
            try:
                os.makedirs(log_dir, exist_ok=True)
            except OSError:
                pass  # sink will be skipped below if the dir isn't writable
            file_path = os.path.join(log_dir, PYTHON_LOG_FILE)
            if int(rotate_size) > 0:
                rotation = "{mb} MB".format(mb=max(1, int(rotate_size) // (1024 * 1024)))
            else:
                rotation = "1 day"
            logger.add(
                file_path, level=lvl, serialize=True, enqueue=True, catch=True,
                rotation=rotation, retention=int(rotate_count),
            )

        if console:
            logger.add(_stderr_json_sink, level=lvl, enqueue=True, catch=True)

    return logger


def get_logger(name="cue-stt"):
    """Return a module-scoped logger bound with `module=<name>`.

    Structured context is added per-call via .bind(**fields) — those fields flow into
    record["extra"] and out to both the file JSON and the stderr JSON:
        log = get_logger("cue_stt_service")
        log.bind(model=name, device=dev).info("model loading")
    """
    if logger is None:
        return None  # venv misconfigured (no Loguru): service is caller-guarded, never crashes
    return logger.bind(module=name)
