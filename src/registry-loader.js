// Folder-based provider discovery: scan src/providers/llm/<id>/index.js and
// src/providers/stt/<id>/index.js, require each, and the provider's module calls defineProvider()
// (from src/registry.js) at load. Adding a provider = create one folder whose index.js calls
// defineProvider with a self-describing descriptor. Nothing else — no switch edits, no Settings UI
// edits, no DEFAULTS fan-out. The loader is the ONLY thing that knows the on-disk layout.
//
// Pure given an injected `fs`/`path` so the pure-Node test suite can point it at a temp dir of fake
// providers and assert discovery, without spawning Electron or touching the real src/providers tree.
// In the app, main.js calls loadProviders({ fs, path }) exactly once at startup, before any
// createLLM/createSTT. Each provider module is responsible for lazy-requiring its SDK INSIDE
// createEngine (never at module load), so requiring the provider folder never pulls a network SDK.

const path = require('path');
const fs = require('fs');
const registry = require('./registry');

// Resolve the on-disk providers root. Default: src/providers adjacent to this module; overridable
// (tests pass an absolute `root`). `require.resolve` would walk node_modules; we want a fixed dir.
function defaultRoot() {
  // require('..') won't help — this lives in src/, one level under the repo root, so the providers
  // tree is `<this dir>/providers`. (package.json `files` ships src/providers/** unpacked.)
  return path.join(__dirname, 'providers');
}

// Discover provider folders under <root>/<type>/<id>/index.js. A provider folder is any immediate
// child directory of <root>/<type> that contains an index.js. Hidden dirs (starting with '.') and
// files are skipped. Returns the ordered list of require-paths to load. Pure given injected fs/path.
function discoverProviderFiles(type, root, fsObj = fs, pathObj = path) {
  const dir = pathObj.join(root, type);
  let entries;
  try { entries = fsObj.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; } // no dir = no providers of this type (e.g. before any STT provider exists)
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const index = pathObj.join(dir, e.name, 'index.js');
    if (fsObj.existsSync(index)) out.push({ type, id: e.name, path: index });
  }
  return out;
}

// Load all provider modules for the given types (default both 'llm' and 'stt'). Each module is
// require()'d; its side effect is expected to be one or more defineProvider() calls. Returns the
// descriptors registered by THIS load (so a test can assert what it found) without re-listing the
// whole registry. Re-requiring is safe because Node caches modules by resolved path; calling
// loadProviders twice is a no-op for files already loaded (subsequent loads only pick up folders
// added since, and those re-require cleanly).
function loadProviders({ types = registry.PROVIDER_TYPES, root, fsObj = fs, pathObj = path, _require = require } = {}) {
  const base = root || defaultRoot();
  const loaded = [];
  for (const type of types) {
    for (const f of discoverProviderFiles(type, base, fsObj, pathObj)) {
      _require(f.path); // side effect: defineProvider()
      const desc = registry.getProvider(type, f.id);
      loaded.push({ type, id: f.id, desc: desc ? registry.renderSafe(desc) : null });
    }
  }
  return loaded;
}

// Convenience for code that wants just one type — preserves the same discovery + require side effect.
function loadProvidersOfType(type, opts = {}) { return loadProviders({ ...opts, types: [type] }); }

module.exports = { defaultRoot, discoverProviderFiles, loadProviders, loadProvidersOfType };
