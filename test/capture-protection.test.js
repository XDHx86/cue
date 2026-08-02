const assert = require('node:assert/strict');
const test = require('node:test');
const { captureProtectionEnabled, envFlagSet } = require('../src/capture-protection');

// captureProtectionEnabled is the pure decision behind main.js's setContentProtection wiring:
// protection is ON by default, OFF when the Advanced setting is turned off, and OFF regardless of
// settings when CUE_NO_PROTECT=1 (the developer-only debug override for screen captures). The
// module has no electron/store deps, so it loads cleanly under plain `node --test`.

// ---- defaults & the Advanced-setting toggle ----

test('protection defaults ON when settings are absent/partial', () => {
  assert.equal(captureProtectionEnabled({ settings: null, noProtectEnv: undefined }), true);
  assert.equal(captureProtectionEnabled({ settings: {}, noProtectEnv: undefined }), true);
  // screen object present but missing the key → default true
  assert.equal(captureProtectionEnabled({ settings: { screen: {} }, noProtectEnv: undefined }), true);
});

test('settings.screen.contentProtection=true → ON; false → OFF', () => {
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: true } }, noProtectEnv: undefined }),
    true
  );
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: false } }, noProtectEnv: undefined }),
    false
  );
});

// ---- CUE_NO_PROTECT override ----

test('CUE_NO_PROTECT=1 forces protection OFF regardless of settings', () => {
  assert.equal(captureProtectionEnabled({ settings: null, noProtectEnv: '1' }), false);
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: true } }, noProtectEnv: '1' }),
    false
  );
  // already off → stays off
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: false } }, noProtectEnv: '1' }),
    false
  );
});

test('CUE_NO_PROTECT=0 or false does NOT disable protection (fail-closed)', () => {
  // The documented contract is `=1`; a stray "0"/"false" must not silently lift invisibility.
  assert.equal(captureProtectionEnabled({ settings: null, noProtectEnv: '0' }), true);
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: true } }, noProtectEnv: 'false' }),
    true
  );
});

test('empty/unset CUE_NO_PROTECT leaves the setting in charge', () => {
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: true } }, noProtectEnv: undefined }),
    true
  );
  assert.equal(
    captureProtectionEnabled({ settings: { screen: { contentProtection: true } }, noProtectEnv: '' }),
    true
  );
});

// ---- envFlagSet token semantics ----

test('envFlagSet: only explicit truthy-enable tokens are set', () => {
  for (const set of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
    assert.equal(envFlagSet(set), true, `"${set}" should count as set`);
  }
  for (const unset of [undefined, null, '', '0', 'false', 'no', 'off', 'garbage', 0]) {
    assert.equal(envFlagSet(unset), false, `"${unset}" should count as unset`);
  }
});
