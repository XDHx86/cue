/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const cmdKey = cue.platform === 'darwin' ? '⌘' : 'Ctrl';
  const isCmdOrCtrl = (e) => cue.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let capturing = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let wordSpan = null;   // single <span class="w"> that grows with the stream (was one <span> per token)
  let pendingText = ''; // tokens buffered since the last rAF flush
  let rafPending = false;
  let rafId = 0;
  let assistShortcut = DEFAULT_ASSIST_SHORTCUT;
  let recordingShortcut = false;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function shortcutParts(accelerator) {
    const labels = {
      CommandOrControl: cue.platform === 'darwin' ? '⌘' : 'Ctrl',
      Command: '⌘', Control: 'Ctrl', Super: 'Super',
      Alt: cue.platform === 'darwin' ? '⌥' : 'Alt',
      Shift: cue.platform === 'darwin' ? '⇧' : 'Shift',
      Return: 'Enter', Escape: 'Esc', Space: 'Space',
      Up: '↑', Down: '↓', Left: '←', Right: '→'
    };
    return (accelerator || DEFAULT_ASSIST_SHORTCUT).split('+').map((part) => labels[part] || part);
  }

  function shortcutKeycapsHtml(accelerator, className) {
    const cls = className || 'keycap';
    return shortcutParts(accelerator).map((part) => '<span class="' + cls + '">' + esc(part) + '</span>').join(' ');
  }

  function syncAssistShortcutLabels() {
    const shortcutBtn = $('#shortcut-assist');
    if (shortcutBtn && !recordingShortcut) shortcutBtn.textContent = shortcutParts(assistShortcut).join(' + ');
    const placeholder = $('#placeholder');
    if (placeholder) placeholder.innerHTML = 'Ask about your screen or conversation, or ' + shortcutKeycapsHtml(assistShortcut) + ' for Assist';
  }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; resetFlush(); aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    resetFlush();
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  // Discard any in-flight rAF and buffered text; called when a stream ends or is replaced.
  function resetFlush() {
    if (rafPending) { cancelAnimationFrame(rafId); rafPending = false; }
    pendingText = '';
    wordSpan = null;
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    pendingText += t;
    if (!rafPending) {
      rafPending = true;
      rafId = requestAnimationFrame(flushTokens);
    }
  }

  // One DOM write per frame, regardless of how many tokens arrived — was one <span> per token.
  function flushTokens() {
    rafPending = false;
    if (!aiEl || !pendingText) return;
    if (wordSpan) {
      wordSpan.textContent += pendingText;
    } else {
      wordSpan = document.createElement('span');
      wordSpan.className = 'w';
      wordSpan.textContent = pendingText;
      aiEl.insertBefore(wordSpan, caretEl);
    }
    pendingText = '';
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    resetFlush();
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function inputMaxHeight() { return (settings && settings.ui && typeof settings.ui.inputMaxHeight === 'number') ? settings.ui.inputMaxHeight : 140; }
  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, inputMaxHeight()) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    const captured = keyEventToAccelerator(e);
    if (captured.accelerator && captured.accelerator.toLowerCase() === assistShortcut.toLowerCase()) {
      e.preventDefault(); runMode('assist', ''); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  $('#hide-btn').addEventListener('click', () => {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  });

  // ---- capture: mic + system audio (renderer side) -----------------------------
  // Shared AudioCapture class (renderer/audio-capture.js) handles AudioContext,
  // worklet setup, and resampling when the platform doesn't honour 16kHz.
  const micCapture = new AudioCapture({
    targetRate: 16000,
    onPcm: (buf) => cue.micPcm(buf),
    log: (msg) => cue.log(msg),
  });
  const sysCapture = new AudioCapture({
    targetRate: 16000,
    onPcm: (buf) => cue.systemPcm(buf),
    log: (msg) => cue.log(msg),
  });

  // System audio factory — stops the video track from getDisplayMedia (we only want audio).
  async function sysMediaFactory() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    return stream;
  }

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) sysCapture.start(sysMediaFactory); // preserve gesture for getDisplayMedia
    cue.captureToggle();
  });

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active }) => {
    capturing = active;
    $('#live-dot').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    if (active) {
      micCapture.start(() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }));
      sysCapture.start(sysMediaFactory);
    } else {
      micCapture.stop();
      sysCapture.stop();
    }
    if (!active) {
      // Listening stopped: freeze the strip (turns stay for review) but drop live partials and
      // the status badge — they're stale once the stream closes.
      if (partialEls.you) { partialEls.you.remove(); partialEls.you = null; }
      if (partialEls.them) { partialEls.them.remove(); partialEls.them = null; }
      sttBadge.textContent = ''; sttBadge.className = 'stt-badge';
    }
    updateStripVisibility();
  });
  cue.on('llm:start', ({ userBubble, small }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });

  // ---- live transcript strip (finals + partials from the streaming STT pipeline) ----
  // The `transcript` channel was allowlisted since Phase 0a but never consumed; this is the
  // consumer. Finals replace a channel's live partial cell (the ring buffer mirrors the same
  // clear-on-final rule in transcriptState). text is always set via textContent (never innerHTML)
  // so a provider-sourced transcript can't inject markup.
  const strip = $('#transcript-strip');
  const tlist = $('#transcript-list');
  const sttBadge = $('#stt-badge');
  const partialEls = { you: null, them: null };
  const whoLabel = (ch) => (ch === 'you' ? 'You' : 'Them');
  function scrollTlist() { tlist.scrollTop = tlist.scrollHeight; }
  function updateStripVisibility() {
    const hasTurns = !!tlist.querySelector('.turn');
    strip.classList.toggle('empty', !hasTurns && !capturing);
  }
  function makeTurn(channel, text, partial) {
    const el = document.createElement('div');
    el.className = 'turn ' + channel + (partial ? ' partial' : '');
    const who = document.createElement('span'); who.className = 'who'; who.textContent = whoLabel(channel);
    const t = document.createElement('span'); t.className = 't'; t.textContent = text;
    el.appendChild(who); el.appendChild(t);
    return el;
  }
  cue.on('transcript', ({ channel, text }) => {
    // A finalized turn replaces that channel's live partial cell, then becomes a real turn.
    if (partialEls[channel]) { partialEls[channel].remove(); partialEls[channel] = null; }
    tlist.appendChild(makeTurn(channel, text, false));
    scrollTlist(); updateStripVisibility();
  });
  cue.on('transcript:partial', ({ channel, text }) => {
    let el = partialEls[channel];
    if (!el) { el = makeTurn(channel, text, true); tlist.appendChild(el); partialEls[channel] = el; }
    else el.querySelector('.t').textContent = text;
    scrollTlist(); updateStripVisibility();
  });
  cue.on('stt:status', ({ active, provider, reason }) => {
    if (active) {
      sttBadge.textContent = (provider === 'faster-whisper') ? 'streaming' : 'live';
      sttBadge.className = 'stt-badge streaming';
    } else {
      const degraded = !!(reason && /batch/i.test(reason));
      sttBadge.textContent = reason || 'inactive';
      sttBadge.className = 'stt-badge ' + (degraded ? 'degraded' : 'inactive');
    }
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    const dur = (settings && settings.ui && typeof settings.ui.statusDurationMs === 'number') ? settings.ui.statusDurationMs : 11000;
    statusTimer = setTimeout(() => el.classList.remove('show'), dur);
  }
  cue.on('status', ({ message }) => { cue.log('[status] ' + message); showStatus(message); });

  // ---- Speech-to-Text settings (registry-driven) -------------------------
  // The active STT provider and model are chosen in the Models tab via the
  // Provider and Model <select>s, both populated from the stt:providers IPC
  // (registry → src/providers/stt/<id>/index.js). The Transcription tab
  // retains the On/Off toggle, local engine config, and diagnostics.
  const sttDiagEl = $('#stt-diagnostics');
  const sttModelStatus = $('#stt-model-status');
  let sttProviderList = [];  // [{id, displayName, capabilities, supportedModels, modelSettingsPath, ...}]
  let sttModelRows = [];     // [{name,cached}] from the diagnostics cache scan

  // Transport pseudo-modes that aren't provider ids: 'auto' maps to the faster-whisper
  // local engine's model slot; 'batch' maps to the OpenAI Whisper model slot.
  const STT_MODEL_SOURCE = { auto: 'faster-whisper', batch: 'openai' };
  const STT_MODEL_PATH = { auto: 'stt.local.model', batch: 'stt.model' };

  // Generic model value read/write via a dotted settings path (e.g. 'stt.deepgramModel').
  function resolveModelValue(stt, path) {
    if (!path) return '';
    const segs = path.split('.');
    let obj = stt;
    for (const s of segs) { obj = obj && obj[s]; }
    return obj || '';
  }
  function setModelValue(stt, path, value) {
    if (!path) return;
    const segs = path.split('.');
    let obj = stt;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!obj[segs[i]] || typeof obj[segs[i]] !== 'object') obj[segs[i]] = {};
      obj = obj[segs[i]];
    }
    obj[segs[segs.length - 1]] = value;
  }

  // Rebuild the model <select> for the ACTIVE provider. Transport pseudo-modes
  // ('auto'/'batch') resolve to a specific provider's model list via STT_MODEL_SOURCE.
  // A configured model that no longer appears in the list still maps if present.
  function syncSttModelOptions() {
    const sel = $('#stt-model');
    const prov = $('#stt-provider').value;
    const modelSource = STT_MODEL_SOURCE[prov] || prov;
    const desc = sttProviderList.find((p) => p.id === modelSource);
    const models = desc && desc.supportedModels;
    const modelPath = STT_MODEL_PATH[prov] || (desc && desc.modelSettingsPath);
    const want = resolveModelValue(settings.stt, modelPath);
    if (!models || !models.length) {
      sel.innerHTML = '<option value="">default model</option>';
      return;
    }
    sel.innerHTML = models.map((o) =>
      '<option value="' + o.id + '">' + o.label + (o.cached ? ' (cached)' : '') + '</option>'
    ).join('');
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
  }

  function renderSttDiagnostics(d) {
    const parts = [];
    parts.push('Service: ' + (d.status || 'stopped'));
    parts.push('Venv ready: ' + (d.venvReady ? 'yes' : 'no'));
    if (d.pythonVersion) parts.push('Python: ' + d.pythonVersion);
    if (d.fasterWhisperVersion) parts.push('faster-whisper: ' + d.fasterWhisperVersion);
    parts.push('CUDA: ' + (d.cuda ? 'available' : 'no'));
    if (d.activeModel) parts.push('Active model: ' + d.activeModel);
    if (d.lastError) parts.push('Last error: ' + d.lastError);
    sttDiagEl.textContent = parts.join('\n');
  }

  async function refreshSttDiagnostics() {
    try {
      const [d, providers] = await Promise.all([
        cue.sttDiagnostics(),
        cue.sttProvidersList(),
      ]);
      sttModelRows = d.models || [];
      sttProviderList = providers;
      renderSttDiagnostics(d);
      syncSttModelOptions();
    } catch (e) {
      sttDiagEl.textContent = 'Diagnostics unavailable.';
    }
  }

  // The Transcription-tab config adapts to the chosen provider (selected in Models tab):
  //   - External-URL field for 'auto' fallback or 'external-ws'.
  //   - Local engine config (device / compute / language / VAD) + Download/Delete/Prepare only
  //     for providers with capabilities.local (auto includes local as a fallback).
  //   - Model field hidden for 'external-ws' (the server owns its model).
  function syncSttConfigVisibility() {
    const prov = $('#stt-provider').value;
    const desc = sttProviderList.find((p) => p.id === prov);
    const isLocal = prov === 'auto' || (desc && desc.capabilities && desc.capabilities.local);
    $('#stt-fw-url').closest('.s-field').style.display = (prov === 'auto' || prov === 'external-ws') ? '' : 'none';
    // Local engine config controls live in the Transcription tab. Hide the wrapping
    // .s-field when present (keeps spacing clean); #stt-device-seg is a bare .s-seg.
    ['#stt-device-seg', '#stt-compute', '#stt-language', '#stt-vad-seg'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const target = el.closest('.s-field') || el;
      target.style.display = isLocal ? '' : 'none';
    });
    // Model lifecycle buttons live in the Models tab and only apply to local providers.
    $('#stt-model-download').style.display = isLocal ? '' : 'none';
    $('#stt-model-delete').style.display = isLocal ? '' : 'none';
    $('#stt-prepare').closest('.s-resume-actions').style.display = isLocal ? '' : 'none';
    $('#stt-model-field').style.display = prov === 'external-ws' ? 'none' : '';
  }

  // Fills every STT control from settings, then fetches diagnostics + providers. Called from
  // fillSettings() (not awaited — the STT block populates a moment after the panel opens,
  // matching the async reload-button pattern above).
  async function fillSttSettings() {
    const stt = settings.stt || {};
    const loc = stt.local || {};
    // On/Off seg: default is On (settings.stt.enabled is true unless explicitly false).
    document.querySelectorAll('#stt-enabled-seg button').forEach((b) => b.classList.toggle('on', b.dataset.sttEnabled === (stt.enabled === false ? 'off' : 'on')));
    // Provider dropdown: transport modes (auto + batch) + all registry STT providers.
    if (!sttProviderList.length) {
      try { sttProviderList = await cue.sttProvidersList(); }
      catch { sttProviderList = []; }
    }
    const STT_TRANSPORT_MODES = [
      { id: 'auto', displayName: 'Auto (managed → external → batch)' },
      { id: 'batch', displayName: 'Batch (cloud) only' },
    ];
    const provSel = $('#stt-provider');
    provSel.innerHTML = [...STT_TRANSPORT_MODES, ...sttProviderList].map((p) =>
      '<option value="' + p.id + '">' + p.displayName + '</option>'
    ).join('');
    provSel.value = stt.provider || 'auto';
    // Local engine config
    $('#stt-compute').value = loc.computeType || 'int8';
    $('#stt-language').value = loc.language || 'auto';
    document.querySelectorAll('#stt-device-seg button').forEach((b) => b.classList.toggle('on', b.dataset.device === (loc.device || 'auto')));
    document.querySelectorAll('#stt-vad-seg button').forEach((b) => b.classList.toggle('on', b.dataset.vad === (loc.vad === false ? 'off' : 'on')));
    $('#stt-fw-url').value = stt.fasterWhisperURL || '';
    // Model <select> is populated from the selected provider's supportedModels (via stt:providers).
    // refreshSttDiagnostics() re-syncs when the diagnostics cache scan returns.
    syncSttConfigVisibility();
    syncSttModelOptions();
    await refreshSttDiagnostics();
  }

  // Seg button handlers — toggle .on within each seg (matches the provider/skill segs).
  ['stt-enabled-seg', 'stt-device-seg', 'stt-vad-seg'].forEach((id) => {
    document.querySelectorAll('#' + id + ' button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#' + id + ' button').forEach((x) => x.classList.toggle('on', x === b));
    }));
  });
  // Provider change re-adapts the Transcription-tab config AND repopulates the Models-tab
  // model select for the newly chosen provider (the segs above handle their own .on state).
  $('#stt-provider').addEventListener('change', () => {
    syncSttConfigVisibility();
    syncSttModelOptions();
  });

  // Model management: prepare (venv) / download / delete. Each updates the inline status
  // hint and refreshes diagnostics + the model select so cached flags stay current. A
  // download can take minutes on a first fetch — live phases arrive over stt:progress.
  $('#stt-prepare').addEventListener('click', async () => {
    sttModelStatus.textContent = 'Preparing…';
    const r = await cue.sttPrepare();
    sttModelStatus.textContent = (r && r.ok) ? 'Service ready' : ('Prepare failed' + (r && r.error ? ': ' + r.error : ''));
    await refreshSttDiagnostics();
  });
  $('#stt-model-download').addEventListener('click', async () => {
    const name = $('#stt-model').value;
    if (!name) { sttModelStatus.textContent = 'Select a model first.'; return; }
    sttModelStatus.textContent = 'Downloading… (see diagnostics)';
    const r = await cue.sttModelDownload(name);
    sttModelStatus.textContent = (r && r.model) ? ('Downloaded ' + r.model) : ('Download failed' + (r && r.error ? ': ' + r.error : ''));
    await refreshSttDiagnostics();
  });
  $('#stt-model-delete').addEventListener('click', async () => {
    const name = $('#stt-model').value;
    if (!name) { sttModelStatus.textContent = 'Select a model first.'; return; }
    sttModelStatus.textContent = 'Deleting…';
    const r = await cue.sttModelDelete(name);
    sttModelStatus.textContent = (r && r.deleted) ? ('Deleted ' + (r.model || name)) : ('Delete failed' + (r && r.error ? ': ' + r.error : ''));
    await refreshSttDiagnostics();
  });

  // venv-install + model-download phases nudge the inline status hint live. The 'done'
  // phase clears it; the managing handler above sets the final "Downloaded/Deleted …"
  // text and refreshes the cache scan — no redundant diagnostics fetch here.
  cue.on('stt:progress', ({ phase }) => {
    sttModelStatus.textContent = (phase && phase !== 'done') ? phase : '';
  });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); }
  function closeSettings() { cancelShortcutRecording(); saveSettings(); scrim.classList.add('hidden'); }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  // Settings tab navigation. The active tab is whichever nav button / page carries `.active`
  // (Providers is set active in index.html; a click toggles it). openSettings leaves the
  // last-active tab in place, so reopens drop you where you left off — no state to persist.
  $('#s-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.s-nav-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#s-nav .s-nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('#settings .s-page').forEach((p) => p.classList.toggle('active', p.dataset.tab === tab));
  });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-nvidia').value = settings.apiKeys.nvidia || '';
    $('#key-assemblyai').value = settings.apiKeys.assemblyai || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-omni').value = settings.apiKeys.omni || '';
    $('#ollama-baseurl').value = (settings.ollama && settings.ollama.baseURL) || '';
    $('#resume-context').value = settings.resumeContext || '';
    // Assistant style: read the live promptOverrides.prePrompt home (the legacy top-level
    // prePrompt/prePromptTemplate were folded here by store.js on load — never read them). The
    // helper mirrors resolvePrePrompt's precedence so the seg reflects what composeSystem sends.
    const choice = cue.getPrePromptChoice(settings);
    document.querySelectorAll('#preprompt-seg button').forEach((b) => b.classList.toggle('on', b.dataset.preprompt === choice.option));
    const customArea = $('#preprompt-custom');
    customArea.value = choice.option === 'custom' ? choice.text : '';
    customArea.style.display = (choice.option === 'custom') ? '' : 'none';
    // Skills: On/Off seg + dir; status is the reload button's transient hint, cleared on open.
    const skillOn = settings.skillEnabled !== false;
    document.querySelectorAll('#skill-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.skill === 'on') === skillOn));
    $('#skill-dir').value = settings.skillDir || '';
    $('#skill-status').textContent = '';
    $('#memory-notes').value = (settings.memory && settings.memory.notes) || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    syncAssistShortcutLabels();
    $('#s-status').textContent = statusText();
    fillSttSettings();
    fillSchemaFields();
  }
  $('#clear-resume').addEventListener('click', async () => {
    $('#resume-context').value = '';
    settings.resumeContext = '';
    await cue.settingsSet({ resumeContext: '' });
  });
  function statusText() {
    const k = settings.apiKeys;
    // Ollama has no real key (apiKeys.ollama is a non-empty sentinel), so it is never listed
    // under "keys: …". The "Active: <provider>" prefix already shows it when selected.
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.nvidia && 'Nvidia', k.groq && 'Groq'].filter(Boolean);
    const sttDesc = sttProviderList.find((p) => p.id === (settings.stt && settings.stt.provider)) || {};
    const stt = sttDesc.displayName || (settings.stt && settings.stt.provider) || 'none';
    return 'Active: ' + settings.provider + ' · keys: ' + (has.join(', ') || 'none set') + ' · transcription: ' + stt;
  }
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  document.querySelectorAll('#preprompt-seg button').forEach((b) => b.addEventListener('click', () => {
    const pp = b.dataset.preprompt;
    document.querySelectorAll('#preprompt-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const customArea = $('#preprompt-custom');
    customArea.style.display = (pp === 'custom') ? '' : 'none';
    if (pp !== 'custom') customArea.value = '';
  }));
  document.querySelectorAll('#skill-seg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#skill-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#skill-reload').addEventListener('click', async () => {
    $('#skill-status').textContent = 'Loading…';
    try {
      const r = await cue.skillsReload();
      $('#skill-status').textContent = 'Loaded ' + (r && r.count != null ? r.count : 0) + ' skill' + (r && r.count === 1 ? '' : 's');
    } catch {
      $('#skill-status').textContent = 'Reload failed';
    }
  });
  async function saveSettings() {
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.nvidia = $('#key-nvidia').value.trim();
    settings.apiKeys.assemblyai = $('#key-assemblyai').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.omni = $('#key-omni').value.trim();
    settings.ollama = { baseURL: $('#ollama-baseurl').value.trim() };
    settings.resumeContext = $('#resume-context').value.trim();
    // Pre-prompt: write the live promptOverrides.prePrompt home (the only override composeSystem
    // reads); the legacy top-level keys are no longer touched.
    const ppOption = [...document.querySelectorAll('#preprompt-seg button.on')].map((b) => b.dataset.preprompt)[0] || 'concise';
    if (!settings.promptOverrides) settings.promptOverrides = {};
    settings.promptOverrides.prePrompt = cue.buildPrePromptOverride({ option: ppOption, customText: $('#preprompt-custom').value });
    // Skills: On/Off gate + project dir. The On/Off state is read from the seg so the user's last
    // click is what persists, regardless of the loaded default.
    const skillOn = [...document.querySelectorAll('#skill-seg button.on')].map((b) => b.dataset.skill)[0] === 'on';
    settings.skillEnabled = skillOn;
    settings.skillDir = $('#skill-dir').value.trim();
    settings.memory = { notes: $('#memory-notes').value.trim() };
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // Speech-to-Text: read every STT control back into settings before persisting. The segs
    // use .on (the same convention as the provider/skill segs); selects read .value.
    const sttOn = [...document.querySelectorAll('#stt-enabled-seg button.on')].map((b) => b.dataset.sttEnabled)[0] === 'on';
    const sttDevice = [...document.querySelectorAll('#stt-device-seg button.on')].map((b) => b.dataset.device)[0] || 'auto';
    const sttVad = [...document.querySelectorAll('#stt-vad-seg button.on')].map((b) => b.dataset.vad)[0] !== 'off';
    const sttProvider = $('#stt-provider').value;
    const sttModelVal = $('#stt-model').value;
    settings.stt = {
      ...(settings.stt || {}),
      enabled: sttOn,
      provider: sttProvider,
      fasterWhisperURL: $('#stt-fw-url').value.trim(),
      deepgramURL: (settings.stt && settings.stt.deepgramURL) || '',
      model: (settings.stt && settings.stt.model) || '',
      assemblyaiSpeechModel: (settings.stt && settings.stt.assemblyaiSpeechModel) || '',
      local: {
        ...((settings.stt && settings.stt.local) || {}),
        model: (settings.stt && settings.stt.local && settings.stt.local.model) || 'small',
        device: sttDevice,
        computeType: $('#stt-compute').value || 'int8',
        language: $('#stt-language').value || 'auto',
        vad: sttVad,
      },
    };
    // Route the Models-tab model select to the ACTIVE provider's slot via the
    // declarative modelSettingsPath on the provider descriptor. Transport pseudo-modes
    // ('auto'/'batch') use the fixed STT_MODEL_PATH lookup.
    const modelPath = STT_MODEL_PATH[sttProvider] ||
      (sttProviderList.find((p) => p.id === sttProvider) || {}).modelSettingsPath;
    if (modelPath) setModelValue(settings.stt, modelPath, sttModelVal);
    saveSchemaFields();
    await cue.settingsSet(settings);
  }

  // Assist shortcut recorder. The renderer captures a key combination and the
  // main process only saves it after Electron confirms the global registration.
  const shortcutBtn = $('#shortcut-assist');
  const shortcutHint = $('#shortcut-hint');

  function setShortcutHint(message, kind) {
    shortcutHint.textContent = message;
    shortcutHint.classList.toggle('error', kind === 'error');
    shortcutHint.classList.toggle('success', kind === 'success');
  }

  function cancelShortcutRecording() {
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    syncAssistShortcutLabels();
  }

  function keyEventToAccelerator(e) {
    const modifierKeys = new Set(['Meta', 'Control', 'Alt', 'Shift']);
    if (modifierKeys.has(e.key)) return { error: 'Press a modifier together with another key.' };

    const parts = [];
    const primaryDown = cue.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (primaryDown) parts.push('CommandOrControl');
    if (cue.platform === 'darwin' && e.ctrlKey) parts.push('Control');
    if (cue.platform !== 'darwin' && e.metaKey) parts.push('Super');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    const named = {
      Enter: 'Return', ' ': 'Space', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right'
    };
    const punctuation = { '+': 'Plus', '-': '-', '=': '=', ',': ',', '.': '.', '/': '/', ';': ';', "'": "'", '[': '[', ']': ']', '\\': '\\', '`': '`' };
    let key = named[e.key] || punctuation[e.key] || '';
    if (!key && /^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
    if (!key && /^[0-9]$/.test(e.key)) key = e.key;
    if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    if (!key) return { error: 'Use a letter, number, function key, arrow, or common navigation key.' };
    if (!parts.length && !/^F/.test(key)) return { error: 'Include Command/Ctrl, Alt, or Shift in the shortcut.' };
    parts.push(key);
    return { accelerator: parts.join('+') };
  }

  async function applyAssistShortcut(accelerator) {
    const wasRecording = recordingShortcut;
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    shortcutBtn.textContent = 'Saving…';
    let result;
    try {
      result = await cue.shortcutAssistSet(accelerator);
    } catch (_) {
      result = { ok: false, error: 'cue could not update the shortcut. Please try again.' };
    }
    if (!result.ok) {
      setShortcutHint(result.error, 'error');
      recordingShortcut = wasRecording;
      shortcutBtn.classList.toggle('recording', recordingShortcut);
      if (recordingShortcut) shortcutBtn.textContent = 'Press keys…';
      else syncAssistShortcutLabels();
      return;
    }
    assistShortcut = result.accelerator;
    if (!settings.shortcuts) settings.shortcuts = {};
    settings.shortcuts.assist = assistShortcut;
    cancelShortcutRecording();
    setShortcutHint('Assist shortcut updated.', 'success');
  }

  shortcutBtn.addEventListener('click', () => {
    recordingShortcut = true;
    shortcutBtn.classList.add('recording');
    shortcutBtn.textContent = 'Press keys…';
    setShortcutHint('Press Escape to cancel.', '');
  });

  $('#shortcut-reset').addEventListener('click', () => applyAssistShortcut(DEFAULT_ASSIST_SHORTCUT));

  document.addEventListener('keydown', (e) => {
    if (!recordingShortcut) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      cancelShortcutRecording();
      setShortcutHint('Shortcut change cancelled.', '');
      return;
    }
    const captured = keyEventToAccelerator(e);
    if (captured.error) {
      setShortcutHint(captured.error, 'error');
      return;
    }
    applyAssistShortcut(captured.accelerator);
  }, true);

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openSettings(); }
    }
  });

  // UI Zoom buttons (text only)
  let currentZoom = 1;
  function uiZoomMin() { return (settings && settings.ui && typeof settings.ui.zoomMin === 'number') ? settings.ui.zoomMin : 0.5; }
  function uiZoomMax() { return (settings && settings.ui && typeof settings.ui.zoomMax === 'number') ? settings.ui.zoomMax : 3; }
  function uiZoomStep() { return (settings && settings.ui && typeof settings.ui.zoomStep === 'number') ? settings.ui.zoomStep : 0.1; }
  function updateZoom(delta) {
    currentZoom = Math.max(uiZoomMin(), Math.min(uiZoomMax(), currentZoom + delta));
    document.documentElement.style.setProperty('--text-zoom', currentZoom);
  }
  $('#zoom-in-btn').addEventListener('click', () => updateZoom(uiZoomStep()));
  $('#zoom-out-btn').addEventListener('click', () => updateZoom(-uiZoomStep()));

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  let moveRafPending = false, lastMoveX = 0, lastMoveY = 0;
  function probeHover() {
    moveRafPending = false;
    const el = document.elementFromPoint(lastMoveX, lastMoveY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  }
  document.addEventListener('mousemove', (e) => {
    lastMoveX = e.clientX; lastMoveY = e.clientY;
    if (moveRafPending) return;
    moveRafPending = true;
    requestAnimationFrame(probeHover);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    ...(cue.platform === 'darwin' ? [{
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen Recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : []),
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'cue uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, <span class="hl">Google Gemini</span>, or <span class="hl">Nvidia</span>. Get a key from your provider, then paste it into cue\'s Settings.<br><br><strong>Tip:</strong> the listening features need speech-to-text access (an OpenAI key with Whisper, or a Gemini key). A chat-only key still powers screen &amp; coding help.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Stay hidden in Zoom',
      body: cue.platform === 'darwin'
        ? 'cue is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals cue.'
        : 'cue is hidden from screen shares automatically. <strong>For Zoom:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong>'
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: () => `How to use cue:<ul><li>${shortcutKeycapsHtml(assistShortcut, 'kbd')} — <strong>Assist</strong> with whatever's on screen or being said</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">H</span> — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>cue logo</strong>. Change Assist's shortcut in <strong>Settings</strong>. Quit with <span class="kbd">${cmdKey}</span><span class="kbd">⇧</span><span class="kbd">X</span>.`
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- schema-driven settings fields ---------------------------------------
  // Settings are generated from the config schema (src/config-schema.js). Each ui-tier
  // entry is placed on its designated tab. Entries with kind:'textarea' render as
  // textareas; numeric entries render as number inputs. Adding a new setting = adding
  // one schema entry; zero HTML changes, zero renderer changes.
  let _schema = null;  // cached schema entries from the main process

  function resolvePath(obj, dottedPath) {
    const keys = dottedPath.split('.');
    let node = obj;
    for (const k of keys) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[k];
    }
    return node;
  }

  function setPath(obj, dottedPath, value) {
    const keys = dottedPath.split('.');
    let node = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
  }

  function schemaInputId(path) { return 'sch-' + path.replace(/\./g, '-'); }

  // Build a single field HTML element from a schema entry. Branches on type:
  //   textarea (kind:'textarea') → multiline text; string → text input;
  //   bool → checkbox; int/float → number input. The earlier code rendered every non-
  //   textarea entry as type="number", so string/bool logging fields showed as numeric.
  function schemaFieldHtml(entry) {
    const id = schemaInputId(entry.path);
    const restartBadge = entry.restart ? ' <span class="s-hint" style="color:#d97706;">⚡ restart</span>' : '';
    const hintHtml = '<div class="s-hint" style="margin:-6px 0 8px 90px;font-size:11px;opacity:0.7;">'
      + esc(entry.hint) + restartBadge + '</div>';
    if (entry.kind === 'textarea') {
      return '<div class="s-field"><span>' + esc(entry.label) + '</span>'
        + '<textarea id="' + id + '" class="s-textarea" rows="2" maxlength="5000"'
        + ' data-path="' + esc(entry.path) + '"'
        + ' placeholder="Empty = built-in default"></textarea></div>'
        + hintHtml;
    }
    if (entry.type === 'bool') {
      return '<div class="s-field"><span>' + esc(entry.label) + '</span>'
        + '<input id="' + id + '" type="checkbox" data-path="' + esc(entry.path) + '" />'
        + '</div>'
        + hintHtml;
    }
    if (entry.type === 'string') {
      return '<div class="s-field"><span>' + esc(entry.label) + '</span>'
        + '<input id="' + id + '" type="text" autocomplete="off"'
        + ' data-path="' + esc(entry.path) + '"'
        + ' placeholder="Empty = built-in default" />'
        + '</div>'
        + hintHtml;
    }
    // numeric input (int / float)
    const step = entry.type === 'float' ? 0.01 : 1;
    return '<div class="s-field"><span>' + esc(entry.label) + '</span>'
      + '<input id="' + id + '" type="number"'
      + ' min="' + entry.min + '" max="' + entry.max + '" step="' + step + '"'
      + ' data-path="' + esc(entry.path) + '"'
      + ' /></div>'
      + hintHtml;
  }

  // Build schema-driven fields into a tab container. Groups by section, skips entries
  // that already have an HTML element (e.g. the pre-prompt selector is manual HTML).
  async function buildSchemaFields() {
    try { _schema = await cue.settingsSchema(); } catch { _schema = []; }
    if (!_schema || !_schema.length) return;

    // Group entries by tab
    const byTab = {};
    for (const entry of _schema) {
      const tab = entry.tab || 'advanced';
      if (!byTab[tab]) byTab[tab] = [];
      byTab[tab].push(entry);
    }

    // For each tab, find the container and append schema fields
    for (const [tab, entries] of Object.entries(byTab)) {
      const container = document.querySelector('.s-page[data-tab="' + tab + '"]');
      if (!container) continue;
      let html = '';
      let currentSection = '';
      for (const entry of entries) {
        // Skip if an element with this id already exists in the DOM (manual HTML takes precedence)
        if (document.getElementById(schemaInputId(entry.path))) continue;
        if (entry.section !== currentSection) {
          if (currentSection) html += '</div>';
          currentSection = entry.section;
          html += '<label class="s-label">' + esc(entry.section) + '</label><div class="s-adv-group">';
        }
        html += schemaFieldHtml(entry);
      }
      if (currentSection) html += '</div>';
      if (html) container.insertAdjacentHTML('beforeend', html);
    }
  }

  // Fill all schema-driven fields from settings.
  function fillSchemaFields() {
    if (!_schema || !settings) return;
    for (const entry of _schema) {
      const el = document.getElementById(schemaInputId(entry.path));
      if (!el) continue;
      const val = resolvePath(settings, entry.path);
      if (entry.type === 'bool') {
        el.checked = !!((val !== undefined && val !== null) ? val : entry.default);
      } else {
        el.value = (val !== undefined && val !== null) ? val : entry.default;
      }
    }
  }

  // Save all schema-driven fields back to settings.
  function saveSchemaFields() {
    if (!_schema || !settings) return;
    let needsRestart = false;
    for (const entry of _schema) {
      const el = document.getElementById(schemaInputId(entry.path));
      if (!el) continue;
      let val;
      if (entry.type === 'bool') {
        val = !!el.checked;
      } else {
        const raw = el.value;
        if (entry.type === 'int') { val = parseInt(raw, 10); if (!Number.isFinite(val)) val = entry.default; }
        else if (entry.type === 'float') { val = parseFloat(raw); if (!Number.isFinite(val)) val = entry.default; }
        else { val = raw; } // string / textarea
        // clamp numeric only
        if (entry.type === 'int' || entry.type === 'float') {
          if (typeof entry.min === 'number' && val < entry.min) val = entry.min;
          if (typeof entry.max === 'number' && val > entry.max) val = entry.max;
        }
      }
      setPath(settings, entry.path, val);
      if (entry.restart) needsRestart = true;
    }
    const banner = document.getElementById('adv-restart-hint');
    if (banner) banner.style.display = needsRestart ? '' : 'none';
  }

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    assistShortcut = (settings.shortcuts && settings.shortcuts.assist) || DEFAULT_ASSIST_SHORTCUT;
    syncAssistShortcutLabels();
    smartBtn.classList.toggle('on', !!settings.smart);
    await buildSchemaFields();
    showExample();
    syncPlaceholder();
    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    if (!settings.onboarded) showOnboard();

  })();
})();
