const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  composeSystem, resolvePrePrompt, skillsSection, memorySection,
  PRE_PROMPT_TEMPLATES, DEFAULT_PRE_PROMPT_TEMPLATE,
  MAX_NOTES_CHARS, MAX_MEMORY_SUMMARY_CHARS,
} = require('../src/prompt-compose');
const { clearSkillCache } = require('../src/skills');

// A mode def with a recognizable system marker and résumé opted in (not small → full tier).
function mkDef(over = {}) {
  return { system: 'MODE-SYSTEM-MARKER', wantsResume: true, small: false, ...over };
}
function before(a, b, s) { return s.indexOf(a) > -1 && s.indexOf(b) > -1 && s.indexOf(a) < s.indexOf(b); }

// ---- ordering: pre-prompt → mode → skills → memory → résumé ----

test('composeSystem concatenates the five sections in the fixed order when all are present', () => {
  clearSkillCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-compose-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'zebra.md'),
      '---\nname: zebra\ndescription: stripes\n---\nDo zebra things.', 'utf8');

    const settings = {
      promptOverrides: { prePrompt: { option: 'custom', text: 'PRE-MARKER' } },
      skillEnabled: true,
      skillDir: root,
      memory: { notes: 'NOTES-MARKER' },
      resumeContext: 'A real résumé body.',
    };
    const out = composeSystem({ def: mkDef(), settings, memoryState: { summary: 'SUMMARY-MARKER' } });

    assert.ok(before('PRE-MARKER', 'MODE-SYSTEM-MARKER', out), 'pre-prompt before mode system');
    assert.ok(before('MODE-SYSTEM-MARKER', 'apply these as behavioral guidance', out), 'mode before skills');
    assert.ok(before('apply these as behavioral guidance', 'Conversation memory (apply as context)', out), 'skills before memory');
    assert.ok(before('Conversation memory (apply as context)', '--- BEGIN RÉSUMÉ REFERENCE ---', out), 'memory before résumé');
  } finally {
    clearSkillCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('the résumé is always the last section, so skills can never appear inside its fence', () => {
  clearSkillCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-compose-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'a.md'),
      '---\nname: alpha\ndescription: d\n---\nDo alpha things.', 'utf8');
    const settings = { skillEnabled: true, skillDir: root, resumeContext: 'My résumé.' };
    const out = composeSystem({ def: mkDef(), settings, memoryState: { summary: '' } });
    assert.ok(out.endsWith('--- END RÉSUMÉ REFERENCE ---'), 'résumé is the final section');
    const fenceStart = out.indexOf('--- BEGIN RÉSUMÉ REFERENCE ---');
    const fenceEnd = out.indexOf('--- END RÉSUMÉ REFERENCE ---');
    const skillsHead = out.indexOf('apply these as behavioral guidance');
    assert.ok(skillsHead > -1 && skillsHead < fenceStart, 'skills section precedes the résumé fence, not inside it');
    assert.ok(!out.slice(fenceStart, fenceEnd).includes('behavioral guidance'),
      'no skills framing leaks between the résumé fences');
  } finally {
    clearSkillCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

test('composeSystem returns "" without a def', () => {
  assert.equal(composeSystem({ settings: {}, memoryState: {} }), '');
  assert.equal(composeSystem({}), '');
});

// ---- pre-prompt resolution ----

test('resolvePrePrompt: custom text wins; else the selected template; else the default', () => {
  // Custom text wins over any selected template (trimmed).
  assert.equal(resolvePrePrompt({ promptOverrides: { prePrompt: { option: 'custom', text: '  be brief  ' } } }), 'be brief');
  // An edited built-in template also wins via non-empty text.
  assert.equal(resolvePrePrompt({ promptOverrides: { prePrompt: { option: 'interview', text: 'my own interview lead' } } }), 'my own interview lead');
  // Empty text → the selected option's default text.
  assert.equal(resolvePrePrompt({ promptOverrides: { prePrompt: { option: 'interview', text: '' } } }), PRE_PROMPT_TEMPLATES.interview);
  // Empty text + unknown/missing option → the default template.
  assert.equal(resolvePrePrompt({ promptOverrides: { prePrompt: { option: 'no-such', text: '' } } }), PRE_PROMPT_TEMPLATES[DEFAULT_PRE_PROMPT_TEMPLATE]);
  // No override at all → the default template.
  assert.equal(resolvePrePrompt({}), PRE_PROMPT_TEMPLATES[DEFAULT_PRE_PROMPT_TEMPLATE]);
});

// ---- skills section ----

test('skillsSection is empty when skills are disabled or no skill dir has skills', () => {
  assert.equal(skillsSection({ skillEnabled: false, skillDir: '/nonexistent' }), '');
  clearSkillCache();
  assert.equal(skillsSection({}), ''); // no skillDir → loadSkillDir('') → cwd, typically empty here
});

test('skillsSection renders each skill under an INSTRUCTIONS framing header', () => {
  clearSkillCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-compose-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'be-terse.md'),
      '---\nname: be-terse\ndescription: stay short\n---\nShort answers only.', 'utf8');
    const s = skillsSection({ skillEnabled: true, skillDir: root });
    assert.match(s, /apply these as behavioral guidance when relevant/);
    assert.match(s, /### be-terse/);
    assert.ok(s.includes('stay short') && s.includes('Short answers only.'));
  } finally {
    clearSkillCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// ---- memory section ----

test('memorySection frames summary + notes as context, accepting a runner (getSummary) or a plain .summary', () => {
  const s1 = memorySection({ memory: { notes: 'prefers async' } }, { summary: 'discussed the API structure' });
  assert.match(s1, /## Conversation memory \(apply as context\)/);
  assert.ok(s1.includes('Rolling summary of the conversation so far:\ndiscussed the API structure'));
  assert.ok(s1.includes('User notes (things the user wants remembered):\nprefers async'));

  const s2 = memorySection({}, { getSummary: () => 'a runner-backed summary' });
  assert.ok(s2.includes('a runner-backed summary'));
});

test('memorySection emits only what is present (summary alone, notes alone, nothing)', () => {
  assert.ok(memorySection({}, { summary: 'only summary' }).includes('only summary'));
  assert.ok(!memorySection({}, { summary: 'only summary' }).includes('User notes'));
  assert.ok(memorySection({ memory: { notes: 'only notes' } }, { summary: '' }).includes('only notes'));
  assert.ok(!memorySection({ memory: { notes: 'only notes' } }, { summary: '' }).includes('Rolling summary'));
  assert.equal(memorySection({}, { summary: '' }), '');
});

test('memorySection truncates the summary at 2000 chars and notes at 4000 chars', () => {
  const s = memorySection({ memory: { notes: 'n'.repeat(MAX_NOTES_CHARS + 50) } }, { summary: 's'.repeat(MAX_MEMORY_SUMMARY_CHARS + 50) });
  assert.ok(s.includes('s'.repeat(MAX_MEMORY_SUMMARY_CHARS)));
  assert.ok(!s.includes('s'.repeat(MAX_MEMORY_SUMMARY_CHARS + 1)));
  assert.ok(s.includes('n'.repeat(MAX_NOTES_CHARS)));
  assert.ok(!s.includes('n'.repeat(MAX_NOTES_CHARS + 1)));
});

// ---- résumé gating ----

test('the résumé section appears only when wantsResume is true, and never for opted-out modes', () => {
  const settings = { resumeContext: 'body' };
  assert.ok(composeSystem({ def: mkDef({ wantsResume: true }), settings, memoryState: {} }).includes('--- BEGIN RÉSUMÉ REFERENCE ---'));
  assert.ok(!composeSystem({ def: mkDef({ wantsResume: false }), settings, memoryState: {} }).includes('RÉSUMÉ REFERENCE'));
});

test('sections are joined with a blank line, never run together', () => {
  const out = composeSystem({
    def: { system: 'SYSTEM', wantsResume: false },
    settings: { promptOverrides: { prePrompt: { option: 'custom', text: 'PRE' } } },
    memoryState: {},
  });
  assert.ok(out.indexOf('PRE\n\nSYSTEM') > -1, 'pre-prompt and mode separated by \\n\\n');
});

test('the summary tier résumé still lands last, after the mode + memory sections', () => {
  const out = composeSystem({
    def: mkDef({ small: true }),
    settings: { resumeContext: 'FULL', resumeSummary: 'DIGEST' },
    memoryState: { summary: 'SMRY' },
  });
  assert.ok(before('MODE-SYSTEM-MARKER', 'Conversation memory', out));
  assert.ok(before('Conversation memory', '--- BEGIN CAREER DIGEST ---', out));
  assert.ok(out.endsWith('--- END CAREER DIGEST ---'), 'digest is the final section');
  assert.ok(!out.includes('FULL'), 'full résumé body is not sent when a digest exists');
});
