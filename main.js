const DEBUG = false; // Set to false to disable debug logging
const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const { loadDotenv } = require('./src/env');
// Populate process.env from .env (CUE_ENV_PATH → userData/.env → cwd/.env) BEFORE the store
// require, so store.load()'s CUE_* override pass sees the env-supplied values. No-op if no
// .env exists; shell-set vars always win.
loadDotenv();
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createStreamSTT } = require('./src/stt-stream');
const { createLLM } = require('./src/llm');
const { MODES, RESUME_SUMMARY_PROMPT } = require('./src/prompts');
const { composeSystem } = require('./src/prompt-compose');
const { createMemoryRunner } = require('./src/memory');
const { loadSkillDir, clearSkillCache } = require('./src/skills');
const { transcriptState, pushFinal, setPartial, clearPartial, liveTranscriptForPrompt, getFinals } = require('./src/transcript');
const { normalizeSDKError, userMessage } = require('./src/errors');
const { rms16 } = require('./src/wav');

let win = null;
let registeredAssistShortcut = null;

const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';
const RESERVED_SHORTCUTS = new Set([
  'commandorcontrol+h',
  'commandorcontrol+shift+x',
  'control+alt+a', // immediate assist — always-on, not user-configurable (see registerShortcuts)
  'control+alt+c'  // show/hide the overlay — always-on, not user-configurable (see registerShortcuts)
]);

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false;       // batch path: the key can't reach any speech model (stops retry spam)
let sttStreamDisabled = false; // stream path: a faster-whisper session latched after 3 connect failures
const buffers = { you: [], them: [] };
// Streaming sessions per channel (src/stt-stream.js). When a channel has a session, its live PCM
// goes straight to the session (never buffered, never gated by state.busy); when it doesn't, the
// channel falls back to the batch flush loop below. A session that latches sets sttStreamDisabled,
// so the next openStreamSessions() uses batch for both channels — capture never pauses.
const streamSessions = { you: null, them: null };
// Rolling-summary compaction runner (src/memory.js). Created in app.whenReady (app.getPath isn't
// safe before that). Started/stopped with the STT capture loop in setCapturing so memory accrues
// only while the user is listening; its session summary persists to userData/cue-memory.json.
// Its compaction calls have their own `summarizing` latch — they never touch state.busy, so a
// hung summary cannot block an assist and an assist never waits on a summary.
let memoryRunner = null;
// transcript is now a ring-buffered transcriptState (src/transcript.js): finals capped at
// TR_MAX_TURNS, plus live partials and a summary watermark. The lone read site (runFeature's
// def.build) consumes liveTranscriptForPrompt() (finals + current partials); streaming finals
// are pushed via pushFinal(), batch finals too.
const FLUSH_MS = 3500;
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s
const RMS_GATE = 240;
let flushTimer = null;

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// Show/hide the whole overlay window (Ctrl+Alt+C). Distinct from the renderer's panel-collapse
// "Hide" button, which only folds the panel and keeps the top bar visible — this toggles the
// BrowserWindow itself, so the overlay vanishes entirely (no chrome at all) and comes back on the
// same shortcut. Because cue has no dock/taskbar presence (skipTaskbar + dock.hide on macOS), the
// shortcut is the only way back from hidden — which is the point: a global, always-available toggle.
// Capture (mic + system audio + STT) keeps running while hidden — the renderer process stays
// alive, so an ongoing meeting keeps transcribing and Ctrl+Alt+A still answers from the live state.
function toggleVisibility() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive(); // show without stealing focus from the app behind the overlay
    // Windows can drop the 'screen-saver' z-order level on re-show (Phase-0b raised it exactly so
    // Zoom's share overlay can't hide cue). Reapply on every re-show; macOS retains the level.
    if (process.platform !== 'darwin') win.setAlwaysOnTop(true, 'screen-saver', 1);
  }
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: workArea.y + 6,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  win.setContentProtection(!process.env.CUE_NO_PROTECT);            // excluded from screen capture (best-effort)
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
  } else {
    // Windows: the default setAlwaysOnTop(true) level sits below Zoom's share overlay (and
    // other 'screen-saver'-level overlays), so cue vanishes the moment a call starts sharing.
    // Match macOS: raise to 'screen-saver',1 and span all workspaces so an overlay on a
    // fullscreen app can't hide the panel. (setHiddenInMissionControl is darwin-only.)
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));
}

// -------- STT flushing (batch fallback) --------
// Used when no streaming STT is configured, or after a streaming session has latched. Streams
// whose faster-whisper WS server is up never touch this path — their PCM goes straight to the
// session via sendAudio (see mic:pcm / system:pcm handlers), so capture is never gated by an
// in-flight LLM turn (state.busy) and never pauses when the server hiccups (it latches → batch).
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushFinal(turn);
      if (DEBUG) console.log(`[TRANSCRIPT] ${channel === 'you' ? 'You' : 'Them'}:`, turn.text);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  const ne = normalizeSDKError(err, err && err.provider);
  console.log('[stt] error', ne.provider, ne.status, ne.code, ne.message);
  if (sttDisabled) return;
  const noAccess = ne.status === 401 || ne.status === 403 || ne.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds; reset on settings:set
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + ne.provider + ' key has no access to a speech-to-text model. ' + ne.suggestion + ' Screen + LeetCode still work; fix the key and reopen Settings to re-enable listening.' });
  } else {
    send('status', { message: 'Transcription error (' + ne.provider + '): ' + ne.suggestion });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT pipeline --------
// On capture start, openStreamSessions() picks streaming mode (a faster-whisper WS session per
// channel) when a streaming provider is configured and hasn't latched; otherwise it runs the
// batch flush loop. Sessions receive live PCM and emit partial/final transcripts into the ring
// buffer + the renderer's transcript:partial channel. closeStreamSessions() tears it all down.
function openStreamSessions() {
  const settings = store.getSettings();
  const stream = createStreamSTT(settings);
  if (stream.available && !sttStreamDisabled) {
    for (const ch of ['you', 'them']) {
      const session = stream.createSession({
        channel: ch,
        language: null,
        onFinal: ({ text, ts }) => {
          const turn = { channel: ch, text, ts: ts || Date.now() };
          pushFinal(turn);                 // ring buffer (capped at TR_MAX_TURNS)
          clearPartial(ch);               // the live partial is now finalized — clear the cell
          if (DEBUG) console.log(`[TRANSCRIPT] ${ch === 'you' ? 'You' : 'Them'}:`, text);
          send('transcript', turn);        // finalized turn → renderer strip (Phase 3c)
        },
        onPartial: ({ text, ts }) => {
          setPartial(ch, text);            // live per-channel partial for Ctrl+Alt+A (Phase 3d)
          send('transcript:partial', { channel: ch, text, ts: ts || Date.now() });
        },
        onError: (e) => { if (DEBUG) console.log('[stt-stream]', ch, e && e.message); },
        onStatus: (s) => {
          if (s.active) {
            send('stt:status', { active: true, provider: s.provider, channel: ch });
          } else {
            // Session latched (3 connect failures). Latch globally so a re-toggle uses batch
            // instead of hammering the dead server; reset on settings:set (a config change).
            sttStreamDisabled = true;
            send('stt:status', { active: false, reason: s.reason || 'streaming unavailable', channel: ch });
          }
        },
      });
      if (session) { streamSessions[ch] = session; session.start(); }
    }
  }
  // No streaming session opened (no provider, latched, or createSession returned null): use the
  // batch flush loop so capture never pauses. A latched-but-configured server reports itself so
  // the renderer can show a "degraded to batch" status badge.
  if (!streamSessions.you && !streamSessions.them) {
    if (stream.available && sttStreamDisabled) {
      send('stt:status', { active: false, reason: 'streaming disabled after failures — using batch transcription' });
    }
    startFlushLoop();
  }
}

function closeStreamSessions() {
  for (const ch of ['you', 'them']) {
    if (streamSessions[ch]) { try { streamSessions[ch].close(); } catch {} streamSessions[ch] = null; }
  }
  stopFlushLoop();
  buffers.you = []; buffers.them = [];
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    openStreamSessions();
    if (memoryRunner) { memoryRunner.load(); memoryRunner.start(); } // accrue memory only while listening
  } else {
    closeStreamSessions();
    if (memoryRunner) { memoryRunner.stop(); memoryRunner.persist(); } // flush the rolling summary to cue-memory.json
  }
  send('capture:state', { active });
  return active;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (DEBUG) console.log('[DEBUG MAIN] runFeature called:', { mode, userText, isBusy: state.busy });
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) {
    if (DEBUG) console.log('[DEBUG MAIN] mode not found:', mode);
    return;
  }
  state.busy = true;
  // 30s idle watchdog: if the SDK stream stops emitting tokens for 30s, treat it as
  // hung — unblock state.busy and tell the renderer to give up instead of spinning
  // forever (the `finally` below only runs on resolve/reject, which a hung stream never does).
  let watchdog = null;
  let dead = false;
  function disarmWatchdog() { if (watchdog) { clearTimeout(watchdog); watchdog = null; } }
  function onWatchdog() {
    if (dead) return;
    dead = true; // late tokens from the dying stream now no-op
    if (DEBUG) console.log('[DEBUG MAIN] stream idle watchdog: no tokens for 30s, releasing.');
    send('llm:error', { message: 'Stream timed out — no response tokens received for 30s.' });
    send('llm:done', {});
    state.busy = false; // release main's latch without waiting for the hung stream to settle
  }
  function armWatchdog() { disarmWatchdog(); watchdog = setTimeout(onWatchdog, 30000); }
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    if (DEBUG) console.log('[DEBUG MAIN] LLM settings loaded:', { provider: settings.provider, smart: settings.smart });
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      if (DEBUG) console.log('[DEBUG MAIN] LLM not ready (missing key or model).');
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      if (DEBUG) console.log('[DEBUG MAIN] Feature needs screen. Capturing screenshot...');
      try { 
        imageDataUrl = await captureScreenshot(); 
        if (DEBUG) console.log('[DEBUG MAIN] Screenshot captured successfully (length:', imageDataUrl.length, ')');
      }
      catch (e) { 
        if (DEBUG) console.error('[DEBUG MAIN] Screenshot capture failed:', e);
        send('status', { message: 'Screen capture needs permission — grant Screen Recording to cue in System Settings.' }); 
      }
    }

    // Compose the prompt from the finalized turns PLUS the live partials, so the assistant
    // answers from what's being said right now (Ctrl+Alt+A mid-speech) — liveTranscriptForPrompt
    // returns a snapshot clone, so a final arriving mid-build can't mutate the array we format.
    const built = def.build({ transcript: liveTranscriptForPrompt(), userText: userText || '' });
    if (DEBUG) console.log('[DEBUG MAIN] Built prompt. Starting LLM stream...');
    armWatchdog();
    const fullText = await llm.stream({
      system: composeSystem({ def, settings, memoryState: memoryRunner }),
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      onToken: (t) => { armWatchdog(); send('llm:token', { text: t }); }
    });
    disarmWatchdog();
    if (DEBUG) console.log('[DEBUG MAIN] Full LLM Output:\n', fullText);
    if (!dead) send('llm:done', {});
  } catch (e) {
    disarmWatchdog();
    if (dead) return; // watchdog already reported the timeout
    // Errors from streamX are already normalized by llm.js; normalize bare throws too so the
    // user always gets a provider-specific suggestion instead of a raw SDK envelope.
    const ne = e && e.suggestion ? e : normalizeSDKError(e, settings.provider);
    send('llm:error', { message: userMessage(ne) });
  } finally {
    disarmWatchdog();
    state.busy = false;
  }
}

// -------- résumé digest (background summary of the full résumé) --------
// Regenerate the short career digest (settings.resumeSummary) from the full résumé using the
// current provider. Fire-and-forget from the settings:set hook when resumeContext changes; never
// blocks the save and never sets state.busy. On any failure (no key, provider down, empty reply)
// the existing digest stands — the summary tier then falls back to the full résumé (tested in
// profile-context.test.js). The 1500-char cap matches MAX_RESUME_SUMMARY_CHARS / RESUME_SUMMARY_PROMPT.
async function regenerateResumeSummary() {
  try {
    const settings = store.getSettings();
    const resume = (settings.resumeContext || '').trim();
    if (!resume) return;
    const llm = createLLM(settings);
    if (!llm.ready) return;
    const digest = await llm.stream({
      system: RESUME_SUMMARY_PROMPT,
      turns: [{ role: 'user', text: resume }],
      imageDataUrl: null,
      onToken: () => {}, // accumulate silently — no renderer tokens for a background digest
    });
    const clean = (digest || '').trim().slice(0, 1500);
    if (clean) store.setSettings({ resumeSummary: clean });
  } catch (e) {
    if (DEBUG) console.log('[cue] resume digest failed:', e && e.message);
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  sttStreamDisabled = false;
  // Regenerate the résumé digest when the user edited the full résumé. Fire-and-forget: the
  // settings save is not blocked, and a missing/unready provider leaves the old digest in place
  // (the summary tier then falls back to the full résumé). Clearing the résumé also clears the
  // digest so stale career data isn't sent.
  const before = store.getSettings().resumeContext;
  const result = store.setSettings(patch);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'resumeContext') && patch.resumeContext !== before) {
    if (!String(patch.resumeContext || '').trim()) store.setSettings({ resumeSummary: '' });
    else regenerateResumeSummary();
  }
  // Skill edits on disk don't bump the skills dir mtime; a settings save is a natural moment to
  // drop the cache so the next composeSystem re-reads current skill contents.
  clearSkillCache();
  return result;
});
ipcMain.handle('skills:reload', () => {
  clearSkillCache();
  const skills = loadSkillDir(store.getSettings().skillDir || '');
  return { count: skills.length };
});
ipcMain.handle('shortcut:assist:set', (_e, accelerator) => setAssistShortcut(accelerator));
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
// Live PCM: route to the streaming session if one owns this channel (never gated by state.busy —
// asking never interrupts transcription), else accumulate for the batch flush loop.
ipcMain.on('mic:pcm', (_e, arrayBuffer) => {
  if (!state.capturing) return;
  const pcm = Buffer.from(arrayBuffer);
  if (streamSessions.you) streamSessions.you.sendAudio(pcm);
  else buffers.you.push(pcm);
});
ipcMain.on('system:pcm', (_e, arrayBuffer) => {
  if (!state.capturing) return;
  const pcm = Buffer.from(arrayBuffer);
  if (streamSessions.them) streamSessions.them.sendAudio(pcm);
  else buffers.them.push(pcm);
});
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function normalizeShortcut(accelerator) {
  return typeof accelerator === 'string' ? accelerator.trim().replace(/\s+/g, '') : '';
}

function registerAssistShortcut(accelerator) {
  const next = normalizeShortcut(accelerator) || DEFAULT_ASSIST_SHORTCUT;
  if (next.length > 80) return { ok: false, error: 'That shortcut is too long.' };
  if (RESERVED_SHORTCUTS.has(next.toLowerCase())) {
    return { ok: false, error: 'That shortcut is reserved by another cue action.' };
  }

  const previous = registeredAssistShortcut;
  if (previous) globalShortcut.unregister(previous);

  try {
    if (!globalShortcut.register(next, () => runFeature('assist', ''))) {
      if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
      return { ok: false, error: 'That shortcut is already in use by another application.' };
    }
  } catch (_) {
    if (previous) globalShortcut.register(previous, () => runFeature('assist', ''));
    return { ok: false, error: 'That key combination is not a valid global shortcut.' };
  }

  registeredAssistShortcut = next;
  return { ok: true, accelerator: next };
}

function setAssistShortcut(accelerator) {
  const result = registerAssistShortcut(accelerator);
  if (result.ok) store.setSettings({ shortcuts: { assist: result.accelerator } });
  return result;
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  // Immediate assist: answer from the live transcript (finals + current partials) without waiting
  // for the speaker to finish. Not user-configurable — reserved so the configurable Assist can't
  // collide. STT sessions are owned by setCapturing and never gated by state.busy, so requesting
  // an answer never interrupts the ongoing transcription stream (ADR-008).
  globalShortcut.register('Control+Alt+A', () => runFeature('assist', ''));

  // Show/hide the overlay. Not user-configurable — always available so the user can dismiss cue
  // entirely (toolbar included) during a share/record and bring it back from anywhere. The
  // renderer process stays alive while hidden, so capture + the live transcript keep running —
  // hiding is purely visual and Ctrl+Alt+A still answers from the current speaker state.
  globalShortcut.register('Control+Alt+C', () => toggleVisibility());

  const settings = store.getSettings();
  const configured = settings.shortcuts && settings.shortcuts.assist;
  const result = registerAssistShortcut(configured || DEFAULT_ASSIST_SHORTCUT);
  if (!result.ok && configured && configured !== DEFAULT_ASSIST_SHORTCUT) {
    console.log('[cue] unable to register Assist shortcut:', result.error, 'Falling back to default.');
    const fallback = registerAssistShortcut(DEFAULT_ASSIST_SHORTCUT);
    if (fallback.ok) store.setSettings({ shortcuts: { assist: DEFAULT_ASSIST_SHORTCUT } });
  }
}

// -------- lifecycle --------
app.whenReady().then(() => {
  if (app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) {
        // Pick the source belonging to the primary display rather than always sources[0],
        // which on multi-monitor setups can hand back a secondary screen's loopback and
        // leave cue listening to the wrong display's audio. display_id is a string; on
        // Windows it can be empty for some sources, so fall back to sources[0].
        const primaryId = String(screen.getPrimaryDisplay().id);
        const primary = sources.find((s) => String(s.display_id) === primaryId) || sources[0];
        callback({ video: primary, audio: 'loopback' });
      } else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();

  // Rolling-summary compaction runner. The watermark IS transcriptState.lastSummarizedTs (src/
  // transcript.js exposes it for memory.js to advance), so this module advances it through the
  // injected accessors rather than owning its own. The summarize call reuses createLLM with the
  // MEMORY_SUMMARY_PROMPT system prompt (src/memory.js imports it from prompts.js); tokens are
  // accumulated into the full text and never surfaced to the renderer (onToken is a no-op).
  memoryRunner = createMemoryRunner({
    getFinals: () => getFinals(),
    getWatermark: () => transcriptState.lastSummarizedTs,
    setWatermark: (ts) => { transcriptState.lastSummarizedTs = ts; },
    summarize: async ({ system, userMessage }) => {
      const settings = store.getSettings();
      const llm = createLLM(settings);
      if (!llm.ready) return ''; // no provider → appendSummary treats '' as a no-op; watermark still advances
      try {
        return await llm.stream({
          system,
          turns: [{ role: 'user', text: userMessage }],
          imageDataUrl: null,
          onToken: () => {},
        });
      } catch (e) {
        throw e; // memory.js retries on throw (watermark not advanced); provider errors retry every 60 s
      }
    },
    filePath: path.join(app.getPath('userData'), 'cue-memory.json'),
  });
  memoryRunner.load();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
