const assert = require('node:assert/strict');
const test = require('node:test');

const {
  registerLocalManager, unregisterLocalManager,
  getLocalManager, localManagerReady, stopAllLocalManagers,
  _resetLocalManagers,
} = require('../src/stt-managers');

function fakeManager({ ready = true, stopped = false } = {}) {
  let venvReady = ready;
  return {
    isVenvReady: () => venvReady,
    stop: () => { venvReady = false; stopped = true; },
    _stopped: () => stopped,
  };
}

test('registerLocalManager builds lazily and caches the instance', () => {
  _resetLocalManagers();
  let built = 0;
  registerLocalManager('funasr', () => { built++; return fakeManager(); });
  const a = getLocalManager('funasr');
  const b = getLocalManager('funasr');
  assert.equal(built, 1, 'factory runs exactly once');
  assert.equal(a, b, 'same cached instance');
});

test('getLocalManager returns null for an unregistered engine', () => {
  _resetLocalManagers();
  assert.equal(getLocalManager('never'), null);
});

test('localManagerReady is false when the factory returned nothing', () => {
  _resetLocalManagers();
  registerLocalManager('broke', () => null);
  assert.equal(localManagerReady('broke'), false);
});

test('localManagerReady reflects the manager isVenvReady()', () => {
  _resetLocalManagers();
  registerLocalManager('fw', () => fakeManager({ ready: true }));
  assert.equal(localManagerReady('fw'), true);
  registerLocalManager('noVenv', () => fakeManager({ ready: false }));
  assert.equal(localManagerReady('noVenv'), false);
});

test('registerLocalManager rejects bad args', () => {
  _resetLocalManagers();
  assert.throws(() => registerLocalManager('', () => null), /engineId/);
  assert.throws(() => registerLocalManager('x', null), /factory/);
});

test('unregisterLocalManager removes the slot and stops returning it', () => {
  _resetLocalManagers();
  registerLocalManager('temp', () => fakeManager());
  assert.ok(getLocalManager('temp'));
  unregisterLocalManager('temp');
  assert.equal(getLocalManager('temp'), null);
});

test('stopAllLocalManagers calls stop on every built manager and awaits promises', async () => {
  _resetLocalManagers();
  let syncStopped = false;
  registerLocalManager('sync', () => ({ isVenvReady: () => true, stop: () => { syncStopped = true; } }));
  let asyncResolved = false;
  registerLocalManager('async', () => ({
    isVenvReady: () => true,
    stop: () => new Promise((res) => setImmediate(() => { asyncResolved = true; res(); })),
  }));
  registerLocalManager('neverBuilt', () => fakeManager()); // not built → stop skipped
  // Build the two that should be stopped.
  getLocalManager('sync');
  getLocalManager('async');
  await stopAllLocalManagers();
  assert.equal(syncStopped, true, 'sync stop() ran');
  assert.equal(asyncResolved, true, 'async stop() awaited');
});

test('stopAllLocalManagers is best-effort: a throwing stop() does not break the others', async () => {
  _resetLocalManagers();
  let secondStopped = false;
  registerLocalManager('throws', () => ({ isVenvReady: () => true, stop: () => { throw new Error('boom'); } }));
  registerLocalManager('ok', () => ({ isVenvReady: () => true, stop: () => { secondStopped = true; } }));
  // Build both so stopAll has instances to tear down — stopAll only touches built managers.
  getLocalManager('throws');
  getLocalManager('ok');
  await stopAllLocalManagers();
  assert.equal(secondStopped, true, 'second stop ran despite the first throwing');
});
