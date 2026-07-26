// Dependency-free .env loader. cue is plain HTML/CSS/JS with no build step and no native
// modules by design — adding `dotenv` would pull a dep chain for a feature this small.
//
// loadDotenv() resolves, in order: process.env.CUE_ENV_PATH → userData/.env → cwd/.env,
// parses the first one that exists as KEY=value lines (skipping blank lines and `#`
// comments), strips a SINGLE pair of surrounding quotes (single or double), and applies
// each value to process.env ONLY if that key is not already set by the shell — so an
// explicit shell export always wins over a .env file.
//
// It parses; it does NOT know about cue's settings schema. The schema-aware mapping
// (CUE_OPENAI_API_KEY → data.apiKeys.openai, etc.) lives in store.js, which runs after
// loadDotenv() has populated process.env.

const fs = require('fs');
const path = require('path');

// Lazily resolve userData — env.js is required before app.whenReady(), and
// app.getPath('userData') throws if called before the app is ready. Resolve from disk
// on first use instead of at module load.
let _electronApp = null;
function electronApp() {
  if (_electronApp) return _electronApp;
  try { _electronApp = require('electron').app; } catch { _electronApp = null; }
  return _electronApp;
}

function resolveEnvPath() {
  if (process.env.CUE_ENV_PATH) return path.resolve(process.env.CUE_ENV_PATH);
  const app = electronApp();
  if (app && typeof app.getPath === 'function') {
    try { return path.join(app.getPath('userData'), '.env'); } catch { /* not ready yet */ }
  }
  return path.join(process.cwd(), '.env');
}

// Parse a single KEY=value line into [key, value] or null (blank/comment/malformed).
function parseLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq < 1) return null; // no '=' or empty key
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null; // illegal env-var name
  let value = line.slice(eq + 1).trim();
  // Strip a SINGLE surrounding pair of matching quotes; preserve internal quotes.
  if (value.length >= 2) {
    const first = value[0], last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  // Inline `# comment` after a value is intentionally NOT treated as a comment — values like
  // `URL=http://x/#anchor` would be truncated. Use a full-line `#` for comments.
  return [key, value];
}

// Parse a .env file body into a plain object. Exported for unit testing.
function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const kv = parseLine(raw);
    if (kv) out[kv[0]] = kv[1];
  }
  return out;
}

// Apply parsed env to process.env WITHOUT overriding shell-set vars. Returns the count applied.
function applyEnv(parsed) {
  let n = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) { process.env[k] = v; n++; }
  }
  return n;
}

// Load .env from the resolved path and apply it. Missing file is a silent no-op.
// Returns the number of vars freshly applied (0 if the file is missing or empty).
function loadDotenv() {
  const candidates = [resolveEnvPath()];
  // Also try cwd/.env alongside the preferential path (CUE_ENV_PATH/userData may not exist).
  const cwdEnv = path.join(process.cwd(), '.env');
  if (cwdEnv !== candidates[0]) candidates.push(cwdEnv);
  for (const p of candidates) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const applied = applyEnv(parseDotenv(text));
    if (applied > 0 && process.env.CUE_ENV_DEBUG) console.log('[cue env] loaded', applied, 'vars from', p);
    return applied;
  }
  return 0;
}

module.exports = { loadDotenv, parseDotenv, resolveEnvPath, applyEnv, parseLine };
