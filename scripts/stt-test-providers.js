#!/usr/bin/env node
// Transcription provider verification harness (Priority 1).
//
// Feeds ONE audio file through every configured STT path and prints each result, so you can
// confirm the SAME captured audio transcribes with every supported provider — without a mic,
// without running the Electron app. Run AFTER `npm run stt:setup` (local engine) and with the
// cloud keys you want to test exported:
//
//   npm run stt:setup                                            # one-time: creates the local venv
//   node scripts/stt-test-providers.js ./sample.wav              # test every available provider
//   node scripts/stt-test-providers.js ./sample.wav --only local
//   node scripts/stt-test-providers.js ./sample.wav --only openai,gemini
//
// Exit code is 0 only if every AVAILABLE provider returned non-empty text; a provider you did not
// configure (no key / venv absent) is reported as SKIPPED (not a failure). This is the manual
// half of the P1 verification the automated pure-Node test suite cannot cover (no audio hardware,
// no keys, no Electron). Keys are read from process.env (CUE_* / OPENAI_API_KEY / GEMINI_API_KEY).
// `--data-dir <path>` overrides userData resolution (matches scripts/stt-cli.js).

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const { createSTT } = require('../src/stt');
const { createSttProcessManager } = require('../src/stt-process');
const { pcmToWav } = require('../src/wav');

// userData resolution WITHOUT Electron (same helper in scripts/stt-cli.js).
function resolveUserDataDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const app = 'cue';
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), app);
  if (platform === 'darwin') return path.join(env.HOME || homedir, 'Library', 'Application Support', app);
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir, '.config'), app);
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { wav: null, only: null, dataDir: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--only') { out.only = a[++i].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (a[i] === '--data-dir') { out.dataDir = a[++i]; continue; }
    if (!a[i].startsWith('--')) out.wav = a[i];
  }
  return out;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.slice(0, 4).toString() !== 'RIFF') {
    // raw Int16 PCM — wrap it (16kHz mono, matching the capture pipeline)
    return pcmToWav(buf, 16000, 1);
  }
  return buf; // already a WAV
}

// Read cloud keys from env (the app would read these from the store; this harness skips the store
// so it needs no Electron). CUE_* take precedence, then the conventional bare names.
function cloudKeys() {
  return {
    openai: process.env.CUE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
    gemini: process.env.CUE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
  };
}

function settingsFor(keys) {
  return {
    apiKeys: { openai: keys.openai, gemini: keys.gemini, anthropic: '', nvidia: '', ollama: '', deepgram: '' },
    stt: { model: '', fasterWhisperURL: '' },
  };
}

// createSTT builds its chain from available keys; a single-key settings probes ONE cloud
// provider in isolation (fasterWhisperURL is empty, so the local-first entry never fires).
async function probeCloud(provider, keys, wav) {
  const key = provider === 'openai' ? keys.openai : (provider === 'gemini' ? keys.gemini : '');
  if (!key) return { skipped: true };
  const settings = {
    apiKeys: { openai: provider === 'openai' ? key : '', gemini: provider === 'gemini' ? key : '',
               anthropic: '', nvidia: '', ollama: '', deepgram: '' },
    stt: { model: 'whisper-1', fasterWhisperURL: '' },
  };
  const res = await createSTT(settings).transcribe(wav);
  if (res.error) return { error: res.error.message || String(res.error), provider };
  return { text: res.text, provider };
}

async function probeLocal(wav, userDataPath) {
  const m = createSttProcessManager({ spawn, spawnSync, fs,
    getPath: (n) => n === 'userData' ? userDataPath : (() => { throw new Error('unexpected getPath ' + n); })() });
  m.setModelsDir(path.join(userDataPath, 'stt-models'));
  const venv = await m.ensureVenv({ onVenvProgress: (p) => process.stderr.write('  ' + p + '\n') });
  if (!venv.ok) return { error: venv.error || 'venv setup failed' };
  if (!await m.ensureRunning()) return { error: 'service failed to start' };
  const model = (process.env.CUE_STT_LOCAL_MODEL) || 'small';
  await m.call('model_download', { name: model, download_root: m.getModelsDir() }, { timeout: 10 * 60 * 1000 });
  await m.call('load', { name: model, device: 'cpu', compute_type: 'int8', download_root: m.getModelsDir(), local_files_only: true }, { timeout: 120000 });
  const res = await m.call('transcribe', { wav_b64: wav.toString('base64') }, { timeout: 60000 });
  try { await m.stop(); } catch {}
  return { text: res && res.text, provider: 'local' };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.wav) { process.stderr.write('usage: node scripts/stt-test-providers.js <wav> [--only a,b] [--data-dir <dir>]\n'); process.exit(2); }
  const wav = readWav(opts.wav);
  const keys = cloudKeys();
  const userDataPath = opts.dataDir || resolveUserDataDir();
  let want = opts.only || ['local', 'openai', 'gemini'];

  // Provisional: also probe the app's full batch chain order to surface which effective
  // provider wins (matches the batch flush loop's real selection).
  const chain = createSTT(settingsFor(keys));

  let allOk = true;
  process.stderr.write(`intent: providers=${want.join(',')} | batchChain=[${chain.providers.join(',')}] | wav=${wav.length}B\n\n`);

  for (const p of want) {
    process.stderr.write(`== ${p} ==\n`);
    let r;
    try {
      if (p === 'local') r = await probeLocal(wav, userDataPath);
      else r = await probeCloud(p, keys, wav);
    } catch (e) { r = { error: (e && e.message) || String(e), provider: p }; }
    if (r && r.skipped) { process.stderr.write(`  SKIPPED (no key configured for ${p})\n\n`); continue; }
    const text = (r && r.text && r.text.trim()) || '';
    process.stdout.write(`[${p}] ${r && r.error ? 'ERROR: ' + r.error : (text ? 'OK (' + text.length + ' chars)' : 'EMPTY')}\n`);
    if (text) process.stdout.write(`    ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}\n`);
    else if (r && r.error) allOk = false;
    process.stderr.write('\n');
  }
  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write('harness failed: ' + (e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = { parseArgs, readWav, cloudKeys, resolveUserDataDir };
