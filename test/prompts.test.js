const assert = require('node:assert/strict');
const test = require('node:test');
const { MODES, formatTranscript, MEMORY_SUMMARY_PROMPT, RESUME_SUMMARY_PROMPT } = require('../src/prompts');

// wantsResume gates the résumé section in composeSystem (Phase 4). Career-relevant modes opt in;
// pure conversational / coding modes opt out so a 12k résumé isn't sent to a recap or LeetCode solve.

test('wantsResume is a defined boolean on every mode', () => {
  for (const [name, def] of Object.entries(MODES)) {
    assert.equal(typeof def.wantsResume, 'boolean', `${name} must declare wantsResume as a boolean`);
  }
});

test('assist / say / ask want the résumé; followup / recap / leetcode do not', () => {
  assert.equal(MODES.assist.wantsResume, true);
  assert.equal(MODES.say.wantsResume, true);
  assert.equal(MODES.ask.wantsResume, true);
  assert.equal(MODES.followup.wantsResume, false);
  assert.equal(MODES.recap.wantsResume, false);
  assert.equal(MODES.leetcode.wantsResume, false);
});

test('MEMORY_SUMMARY_PROMPT asks for a concise third-person summary capped at 2000 chars', () => {
  assert.match(MEMORY_SUMMARY_PROMPT, /summar/i);
  assert.match(MEMORY_SUMMARY_PROMPT, /third person/);
  assert.match(MEMORY_SUMMARY_PROMPT, /2000 characters/);
  assert.match(MEMORY_SUMMARY_PROMPT, /\(none\)/, 'asks for "(none)" when there is nothing substantive');
});

test('RESUME_SUMMARY_PROMPT asks for a ≤1500-char career digest and forbids invention', () => {
  assert.match(RESUME_SUMMARY_PROMPT, /1500/);
  assert.match(RESUME_SUMMARY_PROMPT, /do not invent or embellish/i);
  assert.match(RESUME_SUMMARY_PROMPT, /only the digest prose/);
});

test('formatTranscript still works on the ring shape (channel + text), unbounded when limit=0', () => {
  const turns = [
    { channel: 'them', text: 'hi' },
    { channel: 'you', text: 'hello' },
    { channel: 'them', text: 'bye' },
  ];
  assert.equal(formatTranscript(turns, 0), 'Them: hi\nYou: hello\nThem: bye');
  assert.equal(formatTranscript(turns, 2), 'You: hello\nThem: bye'); // slice(-2)
});
