// Pure decision logic for the overlay's screen-capture exclusion (win.setContentProtection).
// The Electron wiring lives in main.js; this module keeps the boolean logic dependency-free so it
// runs in the pure-Node test suite (same pattern as src/screen.js exporting scaleToMaxEdge).
//
// The decision has two inputs:
//   1. settings.screen.contentProtection — the user-facing Advanced-setting toggle (default ON).
//   2. CUE_NO_PROTECT — a developer-only debug override that forces protection OFF regardless of
//      settings, so the overlay appears in screen captures for debugging (documented as =1).
// Protection is ON unless either input turns it off.

// A boolean env flag counts as "set" only for explicit truthy-enable values. CUE_NO_PROTECT=0 or
// =false does NOT disable protection — the documented contract is `CUE_NO_PROTECT=1`, and a stray
// "0"/"false" must not silently lift the overlay's invisibility. Fail-closed: anything else
// (garbage, empty) is treated as unset → protection stays on.
function envFlagSet(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// settings: live store settings object (may be null/partial on first boot).
// noProtectEnv: process.env.CUE_NO_PROTECT (string | undefined).
// Returns true when the overlay window should be excluded from screen capture.
function captureProtectionEnabled({ settings, noProtectEnv }) {
  const on = !(settings && settings.screen) || settings.screen.contentProtection !== false; // default true (also for missing key)
  return on && !envFlagSet(noProtectEnv);
}

module.exports = { captureProtectionEnabled, envFlagSet };
