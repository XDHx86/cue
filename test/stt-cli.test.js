const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { resolveUserDataDir, parseArgs, usage, STT_MODEL_SIZES } = require('../scripts/stt-cli');

// resolveUserDataDir replicates Electron's app.getPath('userData') WITHOUT requiring electron
// (the env.js precedent). It must resolve to the same userData the app uses so a CLI setup
// prepares the exact venv + models the app reuses.

test('resolveUserDataDir: win32 uses %APPDATA%/cue', () => {
  const d = resolveUserDataDir({ platform: 'win32', env: { APPDATA: 'C:\\U\\AppData\\Roaming' } });
  assert.equal(d, path.join('C:\\U\\AppData\\Roaming', 'cue'));
});

test('resolveUserDataDir: win32 falls back to ~/AppData/Roaming when APPDATA unset', () => {
  const d = resolveUserDataDir({ platform: 'win32', env: {}, homedir: 'C:\\U' });
  assert.equal(d, path.join('C:\\U', 'AppData', 'Roaming', 'cue'));
});

test('resolveUserDataDir: darwin uses ~/Library/Application Support/cue', () => {
  const d = resolveUserDataDir({ platform: 'darwin', env: { HOME: '/u/h' } });
  assert.equal(d, path.join('/u/h', 'Library', 'Application Support', 'cue'));
});

test('resolveUserDataDir: linux honors $XDG_CONFIG_HOME', () => {
  const d = resolveUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/u/cfg' } });
  assert.equal(d, path.join('/u/cfg', 'cue'));
});

test('resolveUserDataDir: linux defaults to ~/.config/cue', () => {
  const d = resolveUserDataDir({ platform: 'linux', env: { HOME: '/u/h' } });
  assert.equal(d, path.join('/u/h', '.config', 'cue'));
});

test('parseArgs parses command, --data-dir, and a positional model name', () => {
  assert.deepEqual(parseArgs(['node', 'stt-cli.js', 'status']),
    { command: 'status', dataDir: null, name: null });
  assert.deepEqual(parseArgs(['node', 'stt-cli.js', 'status', '--data-dir', '/x']),
    { command: 'status', dataDir: '/x', name: null });
  assert.deepEqual(parseArgs(['node', 'stt-cli.js', 'download', 'tiny', '-d', '/x']),
    { command: 'download', dataDir: '/x', name: 'tiny' });
  assert.deepEqual(parseArgs(['node', 'stt-cli.js', 'delete', 'large-v3']),
    { command: 'delete', dataDir: null, name: 'large-v3' });
});

test('parseArgs maps --help/-h to the help command', () => {
  assert.equal(parseArgs(['node', 'stt-cli.js', '--help']).command, 'help');
  assert.equal(parseArgs(['node', 'stt-cli.js', '-h']).command, 'help');
});

test('usage() documents every command and the model list', () => {
  const u = usage();
  for (const cmd of ['setup', 'status', 'models', 'download', 'delete', 'help']) {
    assert.ok(u.includes(cmd), 'usage mentions ' + cmd);
  }
  for (const name of STT_MODEL_SIZES) {
    assert.ok(u.includes(name), 'usage lists model ' + name);
  }
});
