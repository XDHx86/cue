const assert = require('node:assert/strict');
const test = require('node:test');
const { TR_MAX_TURNS, transcriptState, pushFinal, setPartial, clearPartial, getFinals, getPartial, liveTranscriptForPrompt, reset } = require('../src/transcript');

function turn(channel, text, ts) { return { channel, text, ts }; }

// Each test resets the shared module state so they don't leak into each other.
test('pushFinal appends and getFinals returns the live array', () => {
  reset();
  pushFinal(turn('you', 'hi', 1));
  pushFinal(turn('them', 'hello', 2));
  const finals = getFinals();
  assert.ok(Array.isArray(finals), 'getFinals must return an array for formatTranscript .slice/.map compatibility');
  assert.equal(finals.length, 2);
  assert.deepEqual(finals[0], { channel: 'you', text: 'hi', ts: 1 });
  assert.equal(getFinals(), finals, 'getFinals returns the same array reference (no hidden copy)');
});

test('ring evicts the oldest turn once it exceeds TR_MAX_TURNS', () => {
  reset();
  for (let i = 0; i < TR_MAX_TURNS + 5; i++) pushFinal(turn('you', 't' + i, i));
  const finals = getFinals();
  assert.equal(finals.length, TR_MAX_TURNS, 'ring caps at TR_MAX_TURNS');
  assert.equal(finals[0].text, 't5', 'oldest 5 evicted (shift)');
  assert.equal(finals[finals.length - 1].text, 't' + (TR_MAX_TURNS + 4), 'newest retained');
});

test('partials set, read, and clear per channel independently', () => {
  reset();
  setPartial('you', 'parsing you');
  setPartial('them', 'parsing them');
  assert.equal(getPartial('you'), 'parsing you');
  assert.equal(getPartial('them'), 'parsing them');
  clearPartial('you');
  assert.equal(getPartial('you'), '');
  assert.equal(getPartial('them'), 'parsing them', 'clearing one channel leaves the other intact');
  assert.equal(getPartial('you'), '', 'clearPartial empties the slot, not undefined');
});

test('liveTranscriptForPrompt concatenates finals with current partials', () => {
  reset();
  pushFinal(turn('you', 'past you', 1));
  pushFinal(turn('them', 'past them', 2));
  setPartial('you', 'live you');
  const live = liveTranscriptForPrompt();
  assert.ok(Array.isArray(live));
  assert.equal(live.length, 3, 'two finals + the one non-empty partial');
  assert.equal(live[0].text, 'past you');
  assert.equal(live[1].text, 'past them');
  assert.equal(live[2].channel, 'you');
  assert.equal(live[2].text, 'live you');
  assert.ok(live[2].ts > 0, 'synthesized partial turn carries a timestamp');
});

test('liveTranscriptForPrompt clones finals so callers cannot mutate transcriptState', () => {
  reset();
  pushFinal(turn('you', 'orig', 1));
  const live = liveTranscriptForPrompt();
  assert.notEqual(live, getFinals(), 'returns a fresh array, not the live ring reference');
  live[0].text = 'mutated';
  assert.equal(getFinals()[0].text, 'orig', 'mutating the cloned turn does not touch the ring');
});

test('reset clears finals, partials, and the summary watermark', () => {
  reset();
  pushFinal(turn('you', 'x', 1));
  setPartial('them', 'y');
  transcriptState.lastSummarizedTs = 99;
  reset();
  assert.equal(getFinals().length, 0);
  assert.equal(getPartial('you'), '');
  assert.equal(getPartial('them'), '');
  assert.equal(transcriptState.lastSummarizedTs, 0);
});
