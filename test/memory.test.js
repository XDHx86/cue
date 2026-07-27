const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  MIN_NEW_TURNS, MAX_SUMMARY_CHARS, SUMMARY_INTERVAL_MS,
  newTurnsSince, shouldSummarize, buildSummaryUserMessage, nextWatermark, appendSummary,
  createMemoryRunner,
} = require('../src/memory');
const { MEMORY_SUMMARY_PROMPT } = require('../src/prompts');

// Turns carry explicit ts so the rolling watermark is exercised deterministically. A turn with no
// ts reads as 0.
function turn(channel, text, ts) { return { channel, text, ts: ts || 0 }; }

function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

// ---- pure helpers ----

test('newTurnsSince returns turns with ts strictly greater than the watermark', () => {
  const finals = [turn('you', 'a', 1), turn('them', 'b', 2), turn('you', 'c', 3)];
  assert.equal(newTurnsSince(finals, 0).length, 3);
  assert.deepEqual(newTurnsSince(finals, 2).map((t) => t.text), ['c']);
  assert.deepEqual(newTurnsSince(finals, 3), []);
});

test('newTurnsSince tolerates a missing ts (reads as 0) and empty finals', () => {
  assert.equal(newTurnsSince([{ channel: 'you', text: 'x' }], 0).length, 0); // ts 0 is not > 0
  assert.equal(newTurnsSince([{ channel: 'you', text: 'x' }], -1).length, 1);
  assert.deepEqual(newTurnsSince([], 0), []);
});

test('shouldSummarize is false below MIN_NEW_TURNS and true at exactly MIN_NEW_TURNS', () => {
  const finals = Array.from({ length: MIN_NEW_TURNS - 1 }, (_, i) => turn('you', 't' + i, i + 1));
  assert.equal(shouldSummarize(finals, 0), false); // 9 → no
  finals.push(turn('them', 'tenth', MIN_NEW_TURNS));
  assert.equal(shouldSummarize(finals, 0), true); // 10 → yes
  assert.equal(shouldSummarize(finals, MIN_NEW_TURNS), false); // all at/below the watermark → no
});

test('buildSummaryUserMessage leads with the existing summary and presents only new turns as You/Them', () => {
  const finals = [turn('them', 'old', 5), turn('you', 'new one', 10)];
  const msg = buildSummaryUserMessage(finals, 5, 'prior facts');
  assert.ok(msg.startsWith('Current running summary (extend it; do not drop prior facts):\nprior facts'));
  assert.ok(msg.includes('You: new one'), 'new turn rendered with the You/Them formatter');
  assert.ok(!msg.includes('Them: old'), 'turns at or before the watermark are excluded');
});

test('buildSummaryUserMessage has no summary prefix when there is none yet', () => {
  const msg = buildSummaryUserMessage([turn('you', 'first', 1)], 0, '');
  assert.ok(!msg.includes('Current running summary'));
  assert.ok(msg.startsWith('New conversation turns to incorporate:'));
});

test('nextWatermark is the max new-turn ts; unchanged when there are no new turns', () => {
  const finals = [turn('you', 'a', 4), turn('them', 'b', 9), turn('you', 'c', 6)];
  assert.equal(nextWatermark(finals, 3), 9);
  assert.equal(nextWatermark(finals, 9), 9); // nothing newer → stays at 9
  assert.equal(nextWatermark([], 7), 7);
});

test('appendSummary: "(none)" and empty are no-ops; otherwise joins with a blank line; capped at MAX', () => {
  assert.equal(appendSummary('existing', '(none)'), 'existing');
  assert.equal(appendSummary('existing', ''), 'existing');
  assert.equal(appendSummary(null, '(none)'), '');
  assert.equal(appendSummary('prior', 'breadth'), 'prior\n\nbreadth');
  assert.equal(appendSummary(null, 'fresh'), 'fresh');
  const long = 'x'.repeat(MAX_SUMMARY_CHARS + 500);
  assert.equal(appendSummary(null, long).length, MAX_SUMMARY_CHARS);
  assert.equal(appendSummary('p'.repeat(MAX_SUMMARY_CHARS - 3), 'breadth').length, MAX_SUMMARY_CHARS);
});

// ---- runner (deps injected: no electron, no SDK, no real timers for logic) ----

function runnerWith({ summarize, finals, filePath }) {
  let watermark = 0;
  const wm = { get: () => watermark, set: (v) => { watermark = v; } };
  const calls = [];
  const summarizeFn = summarize || (async () => '');
  const runner = createMemoryRunner({
    getFinals: () => finals || [],
    getWatermark: wm.get,
    setWatermark: wm.set,
    summarize: (req) => { calls.push(req); return summarizeFn(req); },
    filePath,
  });
  return { runner, calls, watermark: wm };
}

function tenTurns() {
  return Array.from({ length: MIN_NEW_TURNS }, (_, i) => turn(i % 2 ? 'them' : 'you', 't' + i, i + 1));
}

test('tick skips a compaction when fewer than MIN_NEW_TURNS are past the watermark', async () => {
  const finals = Array.from({ length: MIN_NEW_TURNS - 2 }, (_, i) => turn('you', 't' + i, i + 1));
  const { runner, calls, watermark } = runnerWith({ finals });
  const ran = await runner.tick();
  assert.equal(ran, false);
  assert.equal(calls.length, 0);
  assert.equal(watermark.get(), 0);
});

test('tick compacts ≥10 new turns: calls summarize with the memory prompt, sets the summary, advances the watermark', async () => {
  const { runner, calls, watermark } = runnerWith({
    finals: tenTurns(),
    summarize: async ({ system, userMessage }) => {
      assert.equal(system, MEMORY_SUMMARY_PROMPT, 'system is exactly the rolling-summary prompt');
      assert.ok(userMessage.includes('t0') && userMessage.includes('t9'), 'all new turns are in the message');
      return 'A rolling summary of the meeting.';
    },
  });
  const ran = await runner.tick();
  assert.equal(ran, true);
  assert.equal(calls.length, 1);
  assert.equal(runner.getSummary(), 'A rolling summary of the meeting.');
  assert.equal(watermark.get(), 10); // max ts of the new turns
});

test('a "(none)" compaction leaves the summary empty but still advances the watermark past the turns', async () => {
  const { runner, watermark } = runnerWith({ finals: tenTurns(), summarize: async () => '(none)' });
  await runner.tick();
  assert.equal(runner.getSummary(), '');
  assert.equal(watermark.get(), 10);
  assert.equal(runner.isSummarizing(), false);
});

test('a failed summarize does not advance the watermark or summary so it retries on the next tick', async () => {
  const { runner, calls, watermark } = runnerWith({
    finals: tenTurns(),
    summarize: async () => { throw new Error('provider down'); },
  });
  const ran = await runner.tick();
  assert.equal(ran, true); // attempted
  assert.equal(runner.getSummary(), '');
  assert.equal(watermark.get(), 0, 'watermark NOT advanced on failure');
  assert.equal(runner.isSummarizing(), false, 'latch released even after failure');
  calls.length = 0;
  const ran2 = await runner.tick();
  assert.equal(ran2, true);
  assert.equal(calls.length, 1, 'retried — watermark still 0, turns still qualify');
});

test('summarizing latch prevents a concurrent tick from double-running a compaction', async () => {
  let resolveFirst;
  const { runner, calls } = runnerWith({
    finals: tenTurns(),
    summarize: () => new Promise((res) => { resolveFirst = res; }),
  });
  const first = runner.tick(); // starts, awaits pending summarize
  const overlapping = await runner.tick();
  assert.equal(overlapping, false, 'second tick skipped: latch held');
  assert.equal(calls.length, 1, 'summarize not called a second time');
  resolveFirst('summary body');
  const firstRan = await first;
  assert.equal(firstRan, true);
  assert.equal(runner.getSummary(), 'summary body');
  assert.equal(runner.isSummarizing(), false, 'latch released once the first compaction completes');
});

// ---- persistence (real temp file, no timers) ----

test('persist/load round-trip restores the summary and the watermark', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-mem-'));
  try {
    const file = path.join(dir, 'cue-memory.json');
    const { runner, watermark } = runnerWith({
      finals: tenTurns(), filePath: file, summarize: async () => 'first summary.',
    });
    runner.load();
    await runner.tick();
    assert.equal(watermark.get(), 10);
    assert.ok(fs.existsSync(file));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.version, 1);
    assert.equal(written.summary, 'first summary.');
    assert.equal(written.lastSummarizedTs, 10);

    // a fresh runner loading the same file picks up both
    let recovered = 0;
    const r2 = createMemoryRunner({
      getFinals: () => tenTurns(),
      getWatermark: () => recovered,
      setWatermark: (v) => { recovered = v; },
      summarize: async () => 'should-not-be-needed',
      filePath: file,
    });
    r2.load();
    assert.equal(r2.getSummary(), 'first summary.');
    assert.equal(recovered, 10);
  } finally {
    rm(dir);
  }
});

test('load on a missing or corrupt file starts empty and leaves the watermark unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-mem-'));
  try {
    const file = path.join(dir, 'cue-memory.json');
    const r1 = createMemoryRunner({ filePath: file, getFinals: () => [], getWatermark: () => 0, setWatermark: () => {} });
    r1.load();
    assert.equal(r1.getSummary(), '', 'missing file → empty summary');

    fs.writeFileSync(file, '{ not valid json', 'utf8');
    let kept = 42;
    const r2 = createMemoryRunner({
      filePath: file, getFinals: () => [], getWatermark: () => kept, setWatermark: (v) => { kept = v; }, summarize: async () => '',
    });
    r2.load();
    assert.equal(kept, 42, 'corrupt file does not clobber the watermark with garbage');
  } finally {
    rm(dir);
  }
});

test('a null filePath (no persistence) still compacts in-memory', async () => {
  const { runner } = runnerWith({ finals: tenTurns(), filePath: null, summarize: async () => 'transient' });
  runner.load();
  runner.persist();
  const ran = await runner.tick();
  assert.equal(ran, true);
  assert.equal(runner.getSummary(), 'transient');
});

// ---- interval glue (start/stop) ----

test('running() reports the interval state; double-start and stop are safe', () => {
  const { runner, calls } = runnerWith({ finals: tenTurns(), summarize: async () => 's' });
  assert.equal(runner.running(), false);
  runner.start();
  assert.equal(runner.running(), true);
  runner.start(); // idempotent — must not double-schedule
  runner.stop();
  assert.equal(runner.running(), false);
  runner.stop(); // idempotent
  assert.equal(calls.length, 0, 'start schedules but has not ticked yet');
});

test('the interval ticks on its own at intervalMs', async () => {
  const finals = tenTurns();
  const calls = [];
  const r = createMemoryRunner({
    getFinals: () => finals,
    getWatermark: () => 0,
    setWatermark: () => {}, // no-op so every tick still sees ≥10 new turns
    summarize: (req) => { calls.push(req); return Promise.resolve('s'); },
    intervalMs: 20,
  });
  r.start();
  try {
    const start = Date.now();
    while (calls.length < 2 && Date.now() - start < 1000) {
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(calls.length >= 2, 'interval fired multiple compactions on its own');
  } finally {
    r.stop();
  }
  const before = calls.length;
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(calls.length, before, 'stop halts further ticks');
});

test('SUMMARY_INTERVAL_MS is 60000 (60 s, per the plan)', () => {
  assert.equal(SUMMARY_INTERVAL_MS, 60000);
});
