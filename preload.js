const { contextBridge, ipcRenderer, webFrame } = require('electron');
// Pure, electron-free settings shaper for the Assistant-style (pre-prompt) control. Exposed as
// synchronous contextBridge pass-throughs (NOT IPC channels — no three-leg wiring needed) so the
// browser-side renderer.js shares one canonical, test-covered implementation with main.
const { getPrePromptChoice, buildPrePromptOverride } = require('./src/preprompt');

contextBridge.exposeInMainWorld('cue', {
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  getZoomLevel: () => webFrame.getZoomLevel(),
  platform: process.platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  skillsReload: () => ipcRenderer.invoke('skills:reload'),
  shortcutAssistSet: (accelerator) => ipcRenderer.invoke('shortcut:assist:set', accelerator),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle'),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  log: (msg) => ipcRenderer.send('log', msg),
  // Managed local STT (src/stt-engine.js + src/stt-process.js). Diagnostics refresh,
  // one-time venv setup + verify, model cache management, and the engine list for the
  // Settings engine selector (data-driven so a future engine just registers in JS).
  sttDiagnostics: () => ipcRenderer.invoke('stt:diagnostics'),
  sttPrepare: () => ipcRenderer.invoke('stt:prepare'),
  sttModelDownload: (model) => ipcRenderer.invoke('stt:model:download', model),
  sttModelDelete: (model) => ipcRenderer.invoke('stt:model:delete', model),
  sttEngineList: () => ipcRenderer.invoke('stt:engine:list'),
  // Assistant-style seg ↔ settings.promptOverrides.prePrompt shaping (src/preprompt.js). Sync,
  // pure — no IPC round-trip. The renderer has no Node `require`, so this is how it reaches the
  // same canonical helper main's composeSystem resolves with (resolveField('prePrompt')).
  getPrePromptChoice: (settings) => getPrePromptChoice(settings),
  buildPrePromptOverride: (selection) => buildPrePromptOverride(selection),
  on: (channel, cb) => {
    // Three legs (preload allowlist + main handler + renderer consumer) per .claude/docs/
    // conventions.md. stt:progress carries venv-install / model-download phases + a 'done'
    // nudge so the Settings panel refreshes its diagnostics after a download/delete.
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript', 'transcript:partial', 'stt:status', 'stt:progress'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
