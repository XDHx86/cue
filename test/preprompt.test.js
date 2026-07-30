const assert = require('node:assert/strict');
const test = require('node:test');
const { PRE_PROMPT_TEMPLATES, DEFAULT_PRE_PROMPT_TEMPLATE } = require('../src/prompt-registry');
const { getPrePromptChoice, buildPrePromptOverride, BUILTINS } = require('../src/preprompt');

// getPrePromptChoice positions the Assistant-style seg exactly as resolveField resolves it:
// non-empty text ⇒ 'custom'; else the selected builtin; else the default. Mirrors the legacy
// renderer rule ("Custom is the effective selection whenever custom text is set") but reads the
// live promptOverrides.prePrompt home instead of the deleted top-level prePrompt/prePromptTemplate.

test('getPrePromptChoice: no override ⇒ default template', () => {
  assert.deepEqual(getPrePromptChoice({}), { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' });
  assert.deepEqual(getPrePromptChoice(undefined), { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' });
  assert.deepEqual(getPrePromptChoice({ promptOverrides: {} }), { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' });
});

test('getPrePromptChoice: custom text ⇒ custom lit, text returned', () => {
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'custom', text: '  be brief  ' } } }),
    { option: 'custom', text: 'be brief' },
  );
});

test('getPrePromptChoice: builtin with empty text ⇒ that builtin lit', () => {
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'interview', text: '' } } }),
    { option: 'interview', text: '' },
  );
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'engineer' } } }),
    { option: 'engineer', text: '' },
  );
});

test('getPrePromptChoice: non-empty text with a builtin option ⇒ custom wins (matches resolveField)', () => {
  // A hand-edited built-in (resolveField returns the text, not the template) is surfaced as Custom
  // — the seg reflects what composeSystem actually sends, not the stored option label.
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'interview', text: 'my own lead' } } }),
    { option: 'custom', text: 'my own lead' },
  );
});

test('getPrePromptChoice: whitespace-only text ⇒ falls back to default, not custom', () => {
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'custom', text: '   \n  ' } } }),
    { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' },
  );
});

test('getPrePromptChoice: unknown/missing option ⇒ default template', () => {
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: { option: 'no-such', text: '' } } }),
    { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' },
  );
  assert.deepEqual(
    getPrePromptChoice({ promptOverrides: { prePrompt: 'oops-not-an-object' } }),
    { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' },
  );
});

// buildPrePromptOverride writes the live-home shape (the one composeSystem/resolveField reads).

test('buildPrePromptOverride: custom ⇒ {option:"custom", text} trimmed', () => {
  assert.deepEqual(buildPrePromptOverride({ option: 'custom', customText: ' my lead ' }), { option: 'custom', text: 'my lead' });
  assert.deepEqual(buildPrePromptOverride({ option: 'custom', customText: '' }), { option: 'custom', text: '' });
});

test('buildPrePromptOverride: builtin ⇒ empty text (registry default applies)', () => {
  assert.deepEqual(buildPrePromptOverride({ option: 'interview', customText: 'ignored' }), { option: 'interview', text: '' });
});

test('buildPrePromptOverride: bad input ⇒ default option', () => {
  assert.deepEqual(buildPrePromptOverride({}), { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' });
  assert.deepEqual(buildPrePromptOverride({ option: 'nonsense' }), { option: DEFAULT_PRE_PROMPT_TEMPLATE, text: '' });
});

test('BUILTINS matches the registry templates', () => {
  assert.deepEqual(BUILTINS, Object.keys(PRE_PROMPT_TEMPLATES));
});

// Round-trip: writing then reading reproduces a user's seg selection for both custom & builtin.
test('round-trip: getPrePromptChoice(buildPrePromptOverride(x)) reproduces x', () => {
  const cases = [
    { in: { option: 'custom', customText: 'stay terse' }, exp: { option: 'custom', text: 'stay terse' } },
    { in: { option: 'interview', customText: '' }, exp: { option: 'interview', text: '' } },
    { in: { option: 'engineer' }, exp: { option: 'engineer', text: '' } },
  ];
  for (const c of cases) {
    const written = buildPrePromptOverride(c.in);
    assert.deepEqual(getPrePromptChoice({ promptOverrides: { prePrompt: written } }), c.exp,
      'round-trip failed for ' + JSON.stringify(c.in));
  }
});
