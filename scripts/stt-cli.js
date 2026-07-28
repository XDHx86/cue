#!/usr/bin/env node
// Command-line entry points for the managed local Speech-to-Text engine.
//
// Wraps the SAME src/stt-process.js manager the app uses (no duplicate abstraction):
// npm run stt:setup     create the venv + pip-install pinned requirements + verify once
// npm run stt:status    venv / Python / faster-whisper / CUDA diagnostics + cached models
// npm run stt:models    list candidate models with cached flags
// npm run stt:download -- tiny|base|small|medium|medium-large-v3|large-v3
// npm run stt:delete   -- <name>
//
// The venv + models live under the Electron userData dir, here resolved WITHOUT Electron
// (the env.js precedent — dependency-free, no native modules, no `electron` require), so
// `npm run stt:setup` prepares the exact `userData/stt-venv` and `userData/stt-models` the
// app reuses on launch. `--data-dir <path>` overrides the resolution for tests/offline use.

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const {
  createSttProcessManager, pickPython, buildVenvPlan, requirementsHash,
} = require('../src/stt-process');
const { scanCachedModels, STT_MODEL_SIZES } = require('../src/stt-models');

// Replicates Electron's app.getPath('userData') without loading Electron:
//   win32  -> %APPDATA%/cue        (APPDATA = ...\AppData\Roaming)
//   darwin -> ~/Library/Application Support/cue
//   linux  -> $XDG_CONFIG_HOME/cue  (default ~/.config/cue)
// Pure given (platform, env, homedir) so it tests with an injected env.
// `homedir` is a STRING (default os.homedir()), not the function — path.join would join a
// function object and crash when APPDATA/HOME are unset. Pure given (platform, env, homedir).
function resolveUserDataDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const app = 'cue';
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(base, app);
  }
  if (platform === 'darwin') {
    return path.join(env.HOME || homedir, 'Library', 'Application Support', app);
  }
  // linux / other
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir, '.config');
  return path.join(base, app);
}

// Minimal argv parse: command + optional --data-dir + a positional model name.
function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { command: null, dataDir: null, name: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--data-dir' || a === '-d') { out.dataDir = args[++i]; continue; }
    if (a === '--help' || a === '-h') { out.command = 'help'; continue; }
    if (!out.command) { out.command = a; continue; }
    if (out.name === null) out.name = a;
  }
  return out;
}

function usage() {
  return [
    'cue STT CLI — manage the local faster-whisper engine',
    '',
    'Usage:',
    '  node scripts/stt-cli.js setup    [--data-dir <path>]   create/refresh the venv + verify deps',
    '  node scripts/stt-cli.js status    [--data-dir <path>]   venv + Python + model-cache diagnostics',
    '  node scripts/stt-cli.js models    [--data-dir <path>]   list candidate models + cached flags',
    '  node scripts/stt-cli.js download <name> [--data-dir <path>]   download a model',
    '  node scripts/stt-cli.js delete   <name> [--data-dir <path>]   delete a cached model',
    '  node scripts/stt-cli.js help',
    '',
    'Models: ' + STT_MODEL_SIZES.join(', '),
    'Without --data-dir the venv/models resolve to the same userData dir the app uses.',
  ].join('\n');
}

function makeManager(userData) {
  const m = createSttProcessManager({
    spawn, spawnSync, fs,
    getPath: () => userData,
    log: (msg) => process.stderr.write('[stt] ' + msg + '\n'),
  });
  m.setModelsDir(path.join(userData, 'stt-models'));
  // Surface download/venv phases to stderr so scripts piping stdout stay clean.
  m.on('progress', (p) => process.stderr.write('progress ' + JSON.stringify(p) + '\n'));
  return m;
}

async function cmdSetup(m) {
  const r = await m.ensureVenv({ onVenvProgress: (p) => process.stderr.write(p + '\n') });
  if (!r.ok) { console.error('Setup failed: ' + r.error); process.exitCode = 1; return; }
  console.log('STT venv ready.');
  console.log('  Python:          ' + (r.pythonVersion || 'unknown'));
  console.log('  faster-whisper:  ' + (r.fasterWhisperVersion || 'unknown'));
  console.log('  CUDA:            ' + (r.cuda ? 'available' : 'no (CPU only)'));
}

async function cmdStatus(m, fs, userData) {
  const modelsDir = m.getModelsDir();
  const py = pickPython(spawnSync);
  const reqsHash = requirementsHash(fs);
  const plan = buildVenvPlan({ userDataPath: userData, platform: process.platform, fs, reqsHash });
  console.log('Data dir:        ' + userData);
  console.log('Models dir:      ' + modelsDir);
  console.log('System Python:   ' + (py ? py.version : 'NOT FOUND (need Python 3.10+ on PATH)'));
  console.log('venv:            ' + (fs.existsSync(plan.venvPython)
    ? (plan.markerOK ? 'ready' : 'present but requirements changed — run `npm run stt:setup`')
    : 'not created — run `npm run stt:setup`'));
  // Run the verify step (read-only) only when the venv is already current, so status never
  // mutates. Reports faster-whisper + CUDA; nothing to stop (manager didn't spawn).
  if (plan.markerOK) {
    const v = await m.ensureVenv({ onVenvProgress: () => {} });
    if (v.ok) {
      console.log('faster-whisper:  ' + (v.fasterWhisperVersion || 'unknown'));
      console.log('CUDA:            ' + (v.cuda ? 'available' : 'no (CPU only)'));
    } else {
      console.log('verify:          failed — ' + v.error);
    }
  }
  console.log('');
  console.log('Models:');
  for (const r of scanCachedModels(modelsDir, fs)) {
    console.log('  ' + (r.cached ? '[cached] ' : '          ') + r.name);
  }
}

function cmdModels(m, fs) {
  const rows = scanCachedModels(m.getModelsDir(), fs);
  if (!rows.length) { console.log('(no candidate models)'); return; }
  for (const r of rows) console.log((r.cached ? 'cached   ' : 'missing  ') + r.name);
}

async function withService(m, fn) {
  if (!m.isRunning()) {
    const ok = await m.start();
    if (!ok) { console.error('STT service failed to start (run `npm run stt:setup` first)'); process.exitCode = 1; return null; }
  }
  try { return await fn(); }
  finally { try { m.stop(); } catch { /* best-effort */ } }
}

async function cmdDownload(m, name) {
  if (!name) { console.error('download needs a model name (see `help`)'); process.exitCode = 1; return; }
  if (!STT_MODEL_SIZES.includes(name)) { console.error('unknown model: ' + name + ' (see `help`)'); process.exitCode = 1; return; }
  const r = await withService(m, () => m.call('model_download', { name, download_root: m.getModelsDir() }));
  if (!r) return;
  if (r.model) console.log('Downloaded: ' + r.model);
  else { console.error('Download failed: ' + (r.error || 'unknown')); process.exitCode = 1; }
}

async function cmdDelete(m, name) {
  if (!name) { console.error('delete needs a model name (see `help`)'); process.exitCode = 1; return; }
  const r = await withService(m, () => m.call('model_delete', { name, download_root: m.getModelsDir() }));
  if (!r) return;
  if (r.deleted) console.log('Deleted: ' + (r.model || name));
  else { console.log('Not cached: ' + name + ' (' + (r.error || 'unknown') + ')'); }
}

async function main(argv) {
  const { command, dataDir, name } = parseArgs(argv);
  if (!command || command === 'help') { console.log(usage()); return; }
  const userData = dataDir || resolveUserDataDir();
  const m = makeManager(userData);
  switch (command) {
    case 'setup':    return cmdSetup(m);
    case 'status':   return cmdStatus(m, fs, userData);
    case 'models':   return cmdModels(m, fs);
    case 'download': return cmdDownload(m, name);
    case 'delete':   return cmdDelete(m, name);
    default:
      console.error('unknown command: ' + command + '\n');
      console.error(usage());
      process.exitCode = 1;
  }
}

// Export pure helpers for the test suite (test/stt-cli.test.js). main() runs only when
// invoked directly, so requiring this module from a test has no side effects.
module.exports = { resolveUserDataDir, parseArgs, usage, STT_MODEL_SIZES };

if (require.main === module) {
  main(process.argv).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
