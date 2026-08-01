// Central schema for all configurable settings.
//
// Every hardcoded runtime value in cue is declared once here. The schema is the single
// source of truth for:
//   - DEFAULTS in src/store.js (the schema entries supply their default values)
//   - env-var overrides (each entry may carry a CUE_* env name)
//   - validation/coercion on load (type + min/max)
//   - the Advanced Settings UI (the renderer fetches 'ui'-tier entries via IPC and
//     generates controls dynamically — no HTML per setting, no fill/save fan-out)
//
// Three tiers:
//   'ui'  — rendered as controls in the Settings Advanced tab
//   'env' — configurable via env vars or cue-data.json edits, but NOT in the UI
//           (internal tuning knobs for power users / diagnostics)
//
// Adding a new setting = adding one entry here. Zero HTML changes, zero renderer changes.
//
// The reserved (NOT configurable) values — sample rate (16000), VAD frame size (30 ms),
// WebSocket GUID, file paths, provider sort orders — are intentionally absent from this
// schema. They stay hardcoded.

const SCHEMA = [
  // ---- LLM ----------------------------------------------------------------
  {
    path: 'llm.maxTokens',
    type: 'int', default: 4096, min: 256, max: 32768,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'LLM',
    label: 'Max tokens per response',
    hint: 'Output cap for every LLM reply. Anthropic requires ≥ 1.',
  },
  {
    path: 'llm.idleTimeoutMs',
    type: 'int', default: 30000, min: 5000, max: 300000,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'LLM',
    label: 'Stream idle timeout (ms)',
    hint: 'If no tokens arrive within this window, the stream is abandoned.',
  },

  // ---- Memory & Compaction (Context tab) -----------------------------------
  {
    path: 'memory.minNewTurns',
    type: 'int', default: 10, min: 1, max: 100,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Memory',
    label: 'Min turns before compaction',
    hint: 'How many finalized turns must pass before the rolling summary compacts.',
  },
  {
    path: 'memory.summaryIntervalMs',
    type: 'int', default: 60000, min: 10000, max: 600000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Memory',
    label: 'Compaction interval (ms)',
    hint: 'How often the memory compaction loop checks for new turns.',
  },
  {
    path: 'memory.maxSummaryChars',
    type: 'int', default: 2000, min: 200, max: 10000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Memory',
    label: 'Max rolling summary chars',
    hint: 'Cap on the conversation summary injected into prompts.',
  },
  {
    path: 'memory.maxNotesChars',
    type: 'int', default: 4000, min: 200, max: 20000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Memory',
    label: 'Max user notes chars',
    hint: 'Cap on the memory notes injected into prompts.',
  },

  // ---- Transcript (Context tab) --------------------------------------------
  {
    path: 'transcript.maxTurns',
    type: 'int', default: 200, min: 10, max: 1000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Transcript',
    label: 'Transcript max turns',
    hint: 'Ring-buffer cap for finalized transcript turns. Older turns are evicted.',
  },

  // ---- Skills (Context tab) ------------------------------------------------
  {
    path: 'skills.maxChars',
    type: 'int', default: 8000, min: 500, max: 50000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Skills',
    label: 'Max skills chars',
    hint: 'Total body-length budget for all loaded skills injected into prompts.',
  },

  // ---- Resume (Context tab) ------------------------------------------------
  {
    path: 'resume.maxContextChars',
    type: 'int', default: 12000, min: 500, max: 50000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Résumé',
    label: 'Max résumé chars',
    hint: 'Cap on the full résumé injected into prompts.',
  },
  {
    path: 'resume.maxSummaryChars',
    type: 'int', default: 1500, min: 200, max: 5000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Résumé',
    label: 'Max career digest chars',
    hint: 'Cap on the auto-generated short résumé digest for small modes.',
  },

  // ---- Screen Capture (Advanced tab — power-user tuning) -------------------
  {
    path: 'screen.maxEdge',
    type: 'int', default: 1568, min: 256, max: 4096,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'Screen Capture',
    label: 'Longest edge (px)',
    hint: 'Screenshots are downscaled so the longest side ≤ this. Vision providers do further downscaling.',
  },
  {
    path: 'screen.jpegQuality',
    type: 'int', default: 85, min: 10, max: 100,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'Screen Capture',
    label: 'JPEG quality',
    hint: '0–100. Higher = larger images. 85 is visually clean for screen text.',
  },
  {
    path: 'screen.cacheTtlMs',
    type: 'int', default: 1500, min: 0, max: 30000,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'Screen Capture',
    label: 'Screenshot cache TTL (ms)',
    hint: 'Reuse the last capture within this window for rapid ask bursts.',
  },

  // ---- STT Timing (Transcription tab) --------------------------------------
  {
    path: 'stt.flushMs',
    type: 'int', default: 3500, min: 500, max: 30000,
    tier: 'ui', restart: false,
    tab: 'transcription', section: 'STT Timing',
    label: 'Batch flush interval (ms)',
    hint: 'How often the batch STT flush loop drains accumulated audio.',
  },
  {
    path: 'stt.minBytes',
    type: 'int', default: 9600, min: 320, max: 64000,
    tier: 'ui', restart: false,
    tab: 'transcription', section: 'STT Timing',
    label: 'Min bytes before flush',
    hint: 'Minimum audio bytes before attempting transcription. ~0.6s at 16kHz.',
  },
  {
    path: 'stt.rmsGate',
    type: 'int', default: 240, min: 0, max: 1000,
    tier: 'ui', restart: false,
    tab: 'transcription', section: 'STT Timing',
    label: 'Silence gate (RMS)',
    hint: 'Audio below this RMS is treated as silence and not transcribed.',
  },
  {
    path: 'stt.transcribeTimeoutMs',
    type: 'int', default: 30000, min: 5000, max: 120000,
    tier: 'ui', restart: false,
    tab: 'transcription', section: 'STT Timing',
    label: 'Transcribe watchdog (ms)',
    hint: 'If a transcribe call takes longer, it is abandoned and the error surfaced.',
  },

  // ---- STT (Advanced tab — internal tuning) ---------------------------------
  {
    path: 'stt.maxSpawnFailures',
    type: 'int', default: 3, min: 1, max: 20,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Max spawn failures',
    hint: 'Consecutive Python process failures before the service latches (degrades to batch).',
  },
  {
    path: 'stt.helloTimeoutMs',
    type: 'int', default: 8000, min: 1000, max: 60000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Hello timeout (ms)',
    hint: 'Timeout for the Python service hello handshake after spawn.',
  },
  {
    path: 'stt.callTimeoutMs',
    type: 'int', default: 15000, min: 1000, max: 120000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'RPC call timeout (ms)',
    hint: 'Default JSON-RPC call timeout for the Python service.',
  },
  {
    path: 'stt.modelReloadTimeoutMs',
    type: 'int', default: 120000, min: 5000, max: 600000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Model reload timeout (ms)',
    hint: 'Timeout for re-loading a cached model after an unexpected Python restart.',
  },
  {
    path: 'stt.shutdownGraceMs',
    type: 'int', default: 1000, min: 100, max: 30000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Shutdown grace (ms)',
    hint: 'Grace period (ms) before killing the Python process on app quit.',
  },
  {
    path: 'stt.modelDownloadTimeoutMs',
    type: 'int', default: 600000, min: 30000, max: 3600000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Model download timeout (ms)',
    hint: 'Timeout for downloading a faster-whisper model from HuggingFace.',
  },
  {
    path: 'stt.modelLoadTimeoutMs',
    type: 'int', default: 120000, min: 10000, max: 600000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Model load timeout (ms)',
    hint: 'Timeout for loading an already-cached model into memory.',
  },
  {
    path: 'stt.preSidBytes',
    type: 'int', default: 64000, min: 3200, max: 128000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Pre-SID buffer (bytes)',
    hint: 'Audio bytes buffered while awaiting the stream session ID. ~2s at 16kHz.',
  },
  {
    path: 'stt.streamMaxConnectFailures',
    type: 'int', default: 3, min: 1, max: 20,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Stream max connect failures',
    hint: 'WebSocket connect failures before the stream session latches (degrades to batch).',
  },
  {
    path: 'stt.streamMaxBackoffMs',
    type: 'int', default: 8000, min: 1000, max: 60000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'STT Process',
    label: 'Stream max backoff (ms)',
    hint: 'Maximum reconnect backoff delay for the faster-whisper WebSocket.',
  },

  // ---- Python service (Advanced tab — internal tuning) ----------------------
  {
    path: 'python.vadAggressiveness',
    type: 'int', default: 2, min: 0, max: 3,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'VAD aggressiveness',
    hint: 'WebRTC VAD aggressiveness (0=least, 3=most). Higher = more silence trimming.',
  },
  {
    path: 'python.endMs',
    type: 'int', default: 700, min: 200, max: 2000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'VAD end silence (ms)',
    hint: 'Trailing silence (ms) that finalizes an utterance.',
  },
  {
    path: 'python.minSpeechMs',
    type: 'int', default: 400, min: 100, max: 2000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'Min speech duration (ms)',
    hint: 'Voiced blips shorter than this are ignored (ms).',
  },
  {
    path: 'python.partialEveryS',
    type: 'float', default: 0.4, min: 0.1, max: 5.0,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'Partial update interval (s)',
    hint: 'How often (seconds) partial transcriptions are emitted during speech.',
  },
  {
    path: 'python.energyGate',
    type: 'float', default: 0.01, min: 0.001, max: 0.1,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'Energy gate (RMS)',
    hint: 'RMS fallback gate when webrtcvad is unavailable.',
  },
  {
    path: 'python.beamSize',
    type: 'int', default: 1, min: 1, max: 10,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'Python Service',
    label: 'Beam search size',
    hint: 'Whisper beam search size. Higher = slower but potentially more accurate.',
  },
  {
    path: 'python.stderrTailBytes',
    type: 'int', default: 1024, min: 256, max: 8192,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'Python Service',
    label: 'Stderr tail (bytes)',
    hint: 'Bytes of Python stderr kept for diagnostics display.',
  },
  {
    path: 'main.backoffBaseMs',
    type: 'int', default: 1000, min: 100, max: 10000,
    tier: 'ui', restart: true,
    tab: 'advanced', section: 'General',
    label: 'Backoff base (ms)',
    hint: 'Base delay for exponential backoff (process restart, WS reconnect).',
  },
  {
    path: 'main.shortcutMaxLength',
    type: 'int', default: 80, min: 20, max: 200,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'General',
    label: 'Max shortcut length',
    hint: 'Maximum string length for a keyboard shortcut accelerator.',
  },

  // ---- UI (renderer-only, read by the renderer) ----------------------------
  {
    path: 'ui.zoomMin',
    type: 'float', default: 0.5, min: 0.1, max: 2.0,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'UI',
    label: 'Min text zoom',
    hint: 'Minimum zoom level for the text size buttons.',
  },
  {
    path: 'ui.zoomMax',
    type: 'float', default: 3.0, min: 1.0, max: 5.0,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'UI',
    label: 'Max text zoom',
    hint: 'Maximum zoom level for the text size buttons.',
  },
  {
    path: 'ui.zoomStep',
    type: 'float', default: 0.1, min: 0.01, max: 0.5,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'UI',
    label: 'Zoom step',
    hint: 'Increment per zoom button click.',
  },
  {
    path: 'ui.statusDurationMs',
    type: 'int', default: 11000, min: 1000, max: 60000,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'UI',
    label: 'Status toast duration (ms)',
    hint: 'How long status messages (e.g. errors, warnings) are displayed.',
  },
  {
    path: 'ui.inputMaxHeight',
    type: 'int', default: 140, min: 50, max: 500,
    tier: 'ui', restart: false,
    tab: 'advanced', section: 'UI',
    label: 'Input max height (px)',
    hint: 'Maximum height of the composer textarea before it stops growing.',
  },

  // ---- Pre-prompt personality templates (Context tab) -----------------------
  // Each built-in assistant style has its template text stored in settings so users
  // can edit the personality without switching to Custom. Empty string = use the
  // built-in default from prompt-registry.js.
  {
    path: 'promptOverrides.prepromptTemplates.concise',
    type: 'string', default: '', min: 0, max: 5000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Assistant style',
    kind: 'textarea',
    label: 'Concise template',
    hint: 'Customized text for the "Concise" style. Empty = built-in default.',
  },
  {
    path: 'promptOverrides.prepromptTemplates.interview',
    type: 'string', default: '', min: 0, max: 5000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Assistant style',
    kind: 'textarea',
    label: 'Interview template',
    hint: 'Customized text for the "Interview" style. Empty = built-in default.',
  },
  {
    path: 'promptOverrides.prepromptTemplates.engineer',
    type: 'string', default: '', min: 0, max: 5000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Assistant style',
    kind: 'textarea',
    label: 'Engineer template',
    hint: 'Customized text for the "Engineer" style. Empty = built-in default.',
  },
  {
    path: 'promptOverrides.prepromptTemplates.copilot',
    type: 'string', default: '', min: 0, max: 5000,
    tier: 'ui', restart: false,
    tab: 'context', section: 'Assistant style',
    kind: 'textarea',
    label: 'Copilot template',
    hint: 'Customized text for the "Copilot" style. Empty = built-in default.',
  },

  // ---- Shortcuts (Shortcuts tab) -------------------------------------------
  // The four global shortcuts. All are configurable and apply immediately on save.
  {
    path: 'shortcuts.leetcode',
    type: 'string', default: 'CommandOrControl+H', min: 0, max: 80,
    tier: 'ui', restart: false,
    tab: 'shortcuts', section: 'Global shortcuts',
    label: 'LeetCode solver',
    hint: 'Solve the coding problem shown on screen.',
  },
  {
    path: 'shortcuts.quit',
    type: 'string', default: 'CommandOrControl+Shift+X', min: 0, max: 80,
    tier: 'ui', restart: false,
    tab: 'shortcuts', section: 'Global shortcuts',
    label: 'Quit app',
    hint: 'Quit the app.',
  },
  {
    path: 'shortcuts.immediateAssist',
    type: 'string', default: 'Control+Alt+A', min: 0, max: 80,
    tier: 'ui', restart: false,
    tab: 'shortcuts', section: 'Global shortcuts',
    label: 'Immediate assist',
    hint: 'Answer from live transcript without waiting for the speaker to finish.',
  },
  {
    path: 'shortcuts.toggleOverlay',
    type: 'string', default: 'Control+Alt+C', min: 0, max: 80,
    tier: 'ui', restart: false,
    tab: 'shortcuts', section: 'Global shortcuts',
    label: 'Toggle overlay',
    hint: 'Show/hide the entire overlay window.',
  },
];

// ---- helpers ----------------------------------------------------------------

/** Get all entries (both tiers). */
function allEntries() { return SCHEMA; }

/** Get entries for the renderer (ui-tier only, with safe fields). */
function uiEntries() {
  return SCHEMA.filter((e) => e.tier === 'ui').map((e) => ({
    path: e.path,
    type: e.type,
    default: e.default,
    min: e.min,
    max: e.max,
    restart: e.restart,
    tab: e.tab,
    section: e.section,
    label: e.label,
    hint: e.hint,
  }));
}

/** Build a defaults object from the schema (merged into BASE_DEFAULTS). */
function schemaDefaults() {
  const out = {};
  for (const e of SCHEMA) {
    setNested(out, e.path, e.default);
  }
  return out;
}

/** Walk a dotted path to read a value. */
function getNested(obj, path) {
  const keys = path.split('.');
  let node = obj;
  for (const k of keys) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[k];
  }
  return node;
}

/** Walk a dotted path to set a value, creating intermediate objects as needed. */
function setNested(obj, path, value) {
  const keys = path.split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/** Validate and coerce a settings object against the schema.
 *  Returns the cleaned object (mutates in place). */
function validate(data) {
  if (!data || typeof data !== 'object') return data;
  for (const e of SCHEMA) {
    let val = getNested(data, e.path);
    // Coerce type
    if (e.type === 'int') {
      val = parseInt(val, 10);
      if (!Number.isFinite(val)) val = e.default;
    } else if (e.type === 'float') {
      val = parseFloat(val);
      if (!Number.isFinite(val)) val = e.default;
    } else if (e.type === 'bool') {
      val = !!val;
    } else if (e.type === 'string') {
      val = typeof val === 'string' ? val : String(val);
    }
    // Clamp numeric
    if (typeof e.min === 'number' && val < e.min) val = e.min;
    if (typeof e.max === 'number' && val > e.max) val = e.max;
    // Write back if changed
    if (val !== getNested(data, e.path)) setNested(data, e.path, val);
  }
  return data;
}

module.exports = {
  SCHEMA, allEntries, uiEntries, schemaDefaults,
  getNested, setNested, validate,
};
