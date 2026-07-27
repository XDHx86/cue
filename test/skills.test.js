const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadSkillDir, clearSkillCache, parseSkillFile,
  splitFrontmatter, parseFrontmatter, capSkills, MAX_SKILLS_CHARS,
} = require('../src/skills');

// Skills are loaded from a real temp `.claude/skills/` tree (pure fs/path — no electron).
// Directory-mtime cache behavior is exercised with fs.utimesSync so tests don't depend on the
// filesystem's coarse mtime resolution or on overwrite-vs-create semantics.

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function makeTempSkillDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-skills-'));
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  return root;
}

function writeSkill(root, file, text) {
  fs.writeFileSync(path.join(root, '.claude', 'skills', file), text, 'utf8');
}

// ---- frontmatter parsing (the building blocks) ----

test('splitFrontmatter pulls off a leading fenced block, body follows the closing fence', () => {
  const { frontmatter, body } = splitFrontmatter('---\nname: a\ndescription: d\n---\n# Title\n\npara');
  assert.equal(frontmatter, 'name: a\ndescription: d');
  assert.equal(body, '# Title\n\npara');
});

test('splitFrontmatter passes the whole text as body when there is no fence', () => {
  const { frontmatter, body } = splitFrontmatter('# Just a body\nno frontmatter');
  assert.equal(frontmatter, null);
  assert.equal(body, '# Just a body\nno frontmatter');
});

test('splitFrontmatter treats an opening fence with no closing line as no frontmatter', () => {
  const { frontmatter, body } = splitFrontmatter('---\nname: a\nbody continues');
  assert.equal(frontmatter, null);
  assert.equal(body, '---\nname: a\nbody continues');
});

test('parseFrontmatter reads key:value, strips one quote pair, ignores comments and unknown keys', () => {
  const m = parseFrontmatter('name: "a"\ndescription: \'b c\'\n# a comment\nkey: 1\nbadline');
  assert.deepEqual(m, { name: 'a', description: 'b c', key: '1' });
});

test('parseFrontmatter on empty text yields an empty object', () => {
  assert.deepEqual(parseFrontmatter(''), {});
});

// ---- parseSkillFile (frontmatter + fallback name + body trimming) ----

test('parseSkillFile parses name+description+body from a fenced file', () => {
  const s = parseSkillFile('first.md', frontmatter('first', 'a skill') + 'Do the thing.');
  assert.equal(s.name, 'first');
  assert.equal(s.description, 'a skill');
  assert.equal(s.body, 'Do the thing.');
});

test('parseSkillFile falls back to the filename (sans .md) when frontmatter omits a name', () => {
  const s = parseSkillFile('my-skill.md', '---\ndescription: d\n---\nbody');
  assert.equal(s.name, 'my-skill');
  assert.equal(s.description, 'd');
  assert.equal(s.body, 'body');
});

test('parseSkillFile with no frontmatter uses the filename as name and the whole text as body', () => {
  const s = parseSkillFile('plain.md', '# Just a body\nno frontmatter');
  assert.equal(s.name, 'plain');
  assert.equal(s.description, '');
  assert.equal(s.body, '# Just a body\nno frontmatter');
});

test('parseSkillFile trims leading blank lines after the fence and trailing whitespace', () => {
  const s = parseSkillFile('x.md', frontmatter('x', 'd') + '\n\n\nbody\n\n');
  assert.equal(s.body, 'body');
});

// ---- loadSkillDir (discovery + sort + empty handling) ----

test('loadSkillDir reads .claude/skills/*.md sorted by name', () => {
  const root = makeTempSkillDir();
  writeSkill(root, 'b.md', frontmatter('bravo', 'b desc') + 'body b');
  writeSkill(root, 'a.md', frontmatter('alpha', 'a desc') + 'body a');
  clearSkillCache();
  const skills = loadSkillDir(root);
  assert.deepEqual(skills.map((s) => s.name), ['alpha', 'bravo']);
  assert.equal(skills[0].body, 'body a');
});

test('loadSkillDir on a missing directory returns []', () => {
  clearSkillCache();
  assert.deepEqual(loadSkillDir(path.join(os.tmpdir(), 'cue-nope-' + process.pid)), []);
});

test('loadSkillDir ignores dotfiles and non-.md files', () => {
  const root = makeTempSkillDir();
  writeSkill(root, 'keep.md', frontmatter('keep', 'd') + 'body');
  fs.writeFileSync(path.join(root, '.claude', 'skills', '.hidden.md'), '# secret');
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'notes.txt'), 'ignore me');
  clearSkillCache();
  const skills = loadSkillDir(root);
  assert.deepEqual(skills.map((s) => s.name), ['keep']);
});

// ---- size cap (MAX_SKILLS_CHARS = 8000) ----

test('capSkills drops later skills once the body budget is exhausted, keeping complete earlier ones', () => {
  const skills = [
    { name: 'a', description: 'd', body: 'A'.repeat(3000) },
    { name: 'b', description: 'd', body: 'B'.repeat(5000) },
    { name: 'c', description: 'd', body: 'C'.repeat(3000) }, // would total 11000
  ];
  const out = capSkills(skills);
  assert.deepEqual(out.map((s) => s.name), ['a', 'b']);
  const total = out.reduce((n, s) => n + s.body.length, 0);
  assert.equal(total, MAX_SKILLS_CHARS);
  assert.ok(total <= MAX_SKILLS_CHARS);
});

test('capSkills truncates a single oversized skill rather than dropping it', () => {
  const out = capSkills([{ name: 'big', description: 'd', body: 'Y'.repeat(10000) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].body.length, MAX_SKILLS_CHARS);
});

test('loadSkillDir enforces the size cap end-to-end on a real tree', () => {
  const root = makeTempSkillDir();
  writeSkill(root, 'a.md', frontmatter('a', 'd') + 'A'.repeat(3000));
  writeSkill(root, 'b.md', frontmatter('b', 'd') + 'B'.repeat(5000));
  writeSkill(root, 'c.md', frontmatter('c', 'd') + 'C'.repeat(3000)); // over budget → dropped
  clearSkillCache();
  const out = loadSkillDir(root);
  assert.deepEqual(out.map((s) => s.name), ['a', 'b']);
  const total = out.reduce((n, s) => n + s.body.length, 0);
  assert.equal(total, MAX_SKILLS_CHARS);
});

// ---- cache (directory mtime key + clearSkillCache) ----

test('loadSkillDir caches by directory mtime: hit returns the same array, a bump re-reads', () => {
  const root = makeTempSkillDir();
  writeSkill(root, 'a.md', frontmatter('a', 'd') + 'body-one');
  const dir = path.join(root, '.claude', 'skills');
  const t0 = Math.floor(Date.now() / 1000);
  fs.utimesSync(dir, t0, t0);           // pin dir mtime so the cache key is deterministic
  clearSkillCache();
  const r1 = loadSkillDir(root);       // miss → read, cache under mtime t0
  const r2 = loadSkillDir(root);       // same mtime → cache hit
  assert.equal(r1, r2, 'unchanged dir mtime → same cached array (reference equal)');

  fs.utimesSync(dir, t0 + 100, t0 + 100); // bump dir mtime
  const r3 = loadSkillDir(root);       // miss → re-read
  assert.notEqual(r3, r2, 'changed dir mtime → new array (re-read)');
  assert.equal(r3[0].body, 'body-one', 'content is unchanged across the bump');
});

test('clearSkillCache(dir) forces a re-read even when dir mtime is unchanged', () => {
  const root = makeTempSkillDir();
  writeSkill(root, 'a.md', frontmatter('a', 'd') + 'body-one');
  const dir = path.join(root, '.claude', 'skills');
  const t0 = Math.floor(Date.now() / 1000);
  fs.utimesSync(dir, t0, t0);           // pin so a content edit alone won't bump mtime
  clearSkillCache();
  const r1 = loadSkillDir(root);
  assert.equal(r1[0].body, 'body-one');

  // edit CONTENT in place, keep dir mtime pinned → would still be a cache hit (stale) without clear
  writeSkill(root, 'a.md', frontmatter('a', 'd') + 'body-two');
  fs.utimesSync(dir, t0, t0);
  const r2 = loadSkillDir(root);
  assert.equal(r2, r1, 'cache key unchanged → same (stale) array returned');
  assert.equal(r2[0].body, 'body-one', 'content edit not visible until cache cleared');

  clearSkillCache(root);               // explicit invalidation
  const r3 = loadSkillDir(root);
  assert.equal(r3[0].body, 'body-two', 'clearSkillCache forces a re-read of the edit');
});
