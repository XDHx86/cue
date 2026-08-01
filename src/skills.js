// Loads `.claude/skills/*.md` from a project directory as behavioral-guidance instructions.
// Skills are authored as claude-code skill files: an optional YAML frontmatter fence
// (`---`-delimited) carrying `name` and `description`, over a markdown body. cue injects them
// into the composed system prompt with INSTRUCTIONS framing — the opposite of résumé's
// untrusted-data framing (ADR-009). composeSystem (src/prompt-compose.js) calls loadSkillDir;
// the framing lives there, not here — skills.js only discovers and parses.
//
// No native modules / no dep chain (the env.js hand-rolled parser is the precedent): the
// frontmatter is parsed with a minimal `key: value` reader, no YAML library. Pure fs/path, so it
// is pure-Node and unit-tested without electron.
//
// Caching: results are memoized per resolved skills directory, keyed by the directory's mtimeMs.
// Directory mtime changes on entry add/remove/rename — so new/deleted skills are picked up — but
// NOT on in-place content edits. clearSkillCache() (the settings UI "reload" button, and
// settings:set) forces a re-read to pick up edits. The frontmatter parser, cap, and cache are all
// independently exported for testing.

const fs = require('fs');
const path = require('path');

// Total body length budget injected into the system prompt (ADR-009). The compose system renders
// the body, so body length is the proxy for injected size.
const MAX_SKILLS_CHARS = 8000;

// resolved skills dir → { mtimeMs, skills }
const _cache = new Map();

// Pull off a leading `---\n ... \n---` YAML fence if present. A file that opens with `---` but
// has no closing `---` on its own line is treated as having no frontmatter (whole file is body).
function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return { frontmatter: null, body: text };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const frontmatter = lines.slice(1, i).join('\n');
      const body = lines.slice(i + 1).join('\n').replace(/^[\r\n]+/, '');
      return { frontmatter, body };
    }
  }
  return { frontmatter: null, body: text };
}

// Minimal `key: value` frontmatter reader. Strips one surrounding quote pair (single/double,
// like src/env.js). Single-line values only — skill descriptions are expected on one line. Unknown
// keys are tolerated and ignored. Returns a plain object.
function parseFrontmatter(text) {
  const out = {};
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2) {
      const first = value[0], last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

// parseSkillFile(filename, text) → { name, description, body }. Falls back to the filename (sans
// `.md`) when frontmatter is absent or omits a name. Leading blank lines after the fence and
// trailing whitespace are trimmed; internal formatting is preserved.
function parseSkillFile(filename, text) {
  const { frontmatter, body } = splitFrontmatter(text);
  const meta = frontmatter ? parseFrontmatter(frontmatter) : {};
  const fallbackName = filename.replace(/\.md$/i, '');
  return {
    name: meta.name || fallbackName,
    description: meta.description || '',
    body: body.replace(/\s+$/, ''),
  };
}

// Cap total body length at maxChars (default MAX_SKILLS_CHARS). Greedily include whole skills in
// sorted order; if a skill would overflow, truncate its body to the remaining capacity rather
// than drop it (a single large skill still surfaces something). Compose-system renders body,
// so body length is the proxy.
function capSkills(skills, maxChars) {
  const cap = typeof maxChars === 'number' ? maxChars : MAX_SKILLS_CHARS;
  let used = 0;
  const out = [];
  for (const s of skills) {
    if (used >= cap) break;
    const remaining = cap - used;
    const body = s.body.length > remaining ? s.body.slice(0, remaining) : s.body;
    out.push({ name: s.name, description: s.description, body });
    used += body.length;
  }
  return out;
}

// Read and parse every `.claude/skills/*.md` under skillsPath. Returns [] when the directory is
// missing or unreadable. Skills with neither a body nor a description are skipped (nothing to
// inject). Output is sorted by name for deterministic capping.
function readSkills(skillsPath, maxChars) {
  let files;
  try { files = fs.readdirSync(skillsPath); } catch { return []; }
  const parsed = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    let text;
    try { text = fs.readFileSync(path.join(skillsPath, f), 'utf8'); } catch { continue; }
    const skill = parseSkillFile(f, text);
    if (!skill.body && !skill.description) continue;
    parsed.push(skill);
  }
  parsed.sort((a, b) => a.name.localeCompare(b.name));
  return capSkills(parsed, maxChars);
}

// loadSkillDir(dir, { maxChars }) reads dir/.claude/skills/*.md, returning
// [{name, description, body}] capped at maxChars (default MAX_SKILLS_CHARS) total body length.
// dir is a project root (the claude-code convention); a missing or non-directory skills path
// is a silent no-op → []. Results are cached by directory mtime.
function loadSkillDir(dir, { maxChars } = {}) {
  const skillsPath = path.join(dir || '', '.claude', 'skills');
  const abs = path.resolve(skillsPath);
  let stat;
  try { stat = fs.statSync(abs); } catch { _cache.delete(abs); return []; }
  if (!stat.isDirectory()) { _cache.delete(abs); return []; }
  const mtimeMs = stat.mtimeMs;
  const cached = _cache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.skills;
  const skills = readSkills(abs, maxChars);
  _cache.set(abs, { mtimeMs, skills });
  return skills;
}

// Invalidate the cache. With a dir, drop just that project's entry; without, clear all. Called by
// the settings UI "reload" button and on settings:set so edited skill CONTENTS (which do not bump
// directory mtime) are re-read on the next loadSkillDir.
function clearSkillCache(dir) {
  if (dir) {
    _cache.delete(path.resolve(path.join(dir, '.claude', 'skills')));
  } else {
    _cache.clear();
  }
}

module.exports = {
  loadSkillDir,
  clearSkillCache,
  parseSkillFile,
  parseFrontmatter,
  splitFrontmatter,
  capSkills,
  MAX_SKILLS_CHARS,
};
