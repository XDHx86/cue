const DEBUG = false;
// Rolling conversation summary. A background compaction loop folds finalized transcript turns
// into a short running summary injected into later prompts as conversation memory.
//
// Persistence/ownership (ADR-008 / the plan): the rolling summary + its watermark persist to
// userData/cue-memory.json — SEPARATE from settings. Only the user's hand-edited notes live in
// settings.memory.notes (read by composeSystem, not here). The watermark IS transcriptState's
// `lastSummarizedTs` (transcript.js exposes it "for memory.js to advance"); this module advances
// it through injected get/set callbacks so main.js — not memory.js — owns the wiring to
// transcriptState.
//
// Invariants from the plan:
//   - 60 s setInterval, started/stopped next to the STT stream loop in setCapturing.
//   - compact only when ≥10 finalized turns exist beyond the watermark (MIN_NEW_TURNS).
//   - its own `summarizing` latch — NEVER touches state.busy. A compaction call is invisible to
//     the feature runner and to streaming UI tokens; a hung summary cannot block an assist, and an
//     assist never waits on a summary.
//   - the compaction call accumulates the full text (MEMORY_SUMMARY_PROMPT is the system prompt);
//     it does NOT stream tokens to the renderer.
//
// Pure-Node + electron-free: the LLM call, persistence path, finals, and the watermark accessors
// are param-injected via createMemoryRunner deps, so the logic is unit-tested without electron or
// the SDK (the src/profile-context.js param-injection precedent). The pure decision helpers below
// carry no IO at all.

const fs = require('fs');
const { MEMORY_SUMMARY_PROMPT, formatTranscript } = require('./prompts');

const MIN_NEW_TURNS = 10;          // only compact once this many finalized turns are past the watermark
const SUMMARY_INTERVAL_MS = 60000; // compaction loop cadence
const MAX_SUMMARY_CHARS = 2000;     // rolling-summary cap injected into prompts (matches the prompt)

// ---- pure helpers (exported for testing; no IO) ----

// Finalized turns strictly newer than the watermark. A turn with no ts reads as 0, so on the first
// pass (watermark 0) every turn qualifies.
function newTurnsSince(finals, watermark) {
  const wm = typeof watermark === 'number' ? watermark : 0;
  return (finals || []).filter((t) => (t.ts || 0) > wm);
}

function shouldSummarize(finals, watermark) {
  return newTurnsSince(finals, watermark).length >= MIN_NEW_TURNS;
}

// The compaction user message: lead with the existing running summary so the model EXTENDS it
// (not restates), then present only the NEW turns to fold in. formatTranscript keeps the
// "You/Them" labels consistent with the rest of the prompt pipeline.
function buildSummaryUserMessage(finals, watermark, existingSummary) {
  const turns = newTurnsSince(finals, watermark);
  const body = formatTranscript(turns, 0) || '(none)';
  const summary = (existingSummary || '').trim();
  const prefix = summary
    ? 'Current running summary (extend it; do not drop prior facts):\n' + summary + '\n\n'
    : '';
  return prefix + 'New conversation turns to incorporate:\n' + body;
}

// Advance the watermark to the newest turn ts actually summarized. No new turns → unchanged.
function nextWatermark(finals, watermark) {
  const turns = newTurnsSince(finals, watermark);
  if (!turns.length) return typeof watermark === 'number' ? watermark : 0;
  return turns.reduce((m, t) => Math.max(m, t.ts || 0), 0);
}

// Merge a fresh batch summary into the rolling summary. The model is instructed to reply "(none)"
// when nothing substantive — that is a no-op (the existing summary stands). Output is capped at
// MAX_SUMMARY_CHARS so the memory section never grows unbounded across a long session.
function appendSummary(existing, batchSummary) {
  const batch = (batchSummary || '').trim();
  if (!batch || batch === '(none)') return existing || '';
  const base = (existing || '').trim();
  const merged = base ? base + '\n\n' + batch : batch;
  return merged.slice(0, MAX_SUMMARY_CHARS);
}

// ---- runner: own latch, interval, persistence; all IO injected ----

// deps:
//   getFinals()           → finalized turns [] (wired to transcriptState.getFinals)
//   getWatermark()/setWatermark(ts) → the watermark (wired to transcriptState.lastSummarizedTs)
//   summarize({system,userMessage}) → Promise<string> LLM compaction call; injected so tests
//                                     don't need electron or the SDK. main wires it to createLLM.
//   filePath              → cue-memory.json path (null skips persistence entirely)
//   intervalMs            → override the loop cadence (testing)
function createMemoryRunner(deps) {
  const getFinals = deps.getFinals || (() => []);
  const getWatermark = deps.getWatermark || (() => 0);
  const setWatermark = deps.setWatermark || function () {};
  const summarize = deps.summarize || (async () => '');
  const filePath = deps.filePath || null;
  const intervalMs = typeof deps.intervalMs === 'number' ? deps.intervalMs : SUMMARY_INTERVAL_MS;

  let summary = '';
  let summarizing = false; // overlap guard — never touches state.busy
  let timer = null;

  function load() {
    if (!filePath) return;
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; } // missing → start empty
    try {
      const data = JSON.parse(text);
      summary = typeof data.summary === 'string' ? data.summary : '';
      setWatermark(typeof data.lastSummarizedTs === 'number' ? data.lastSummarizedTs : getWatermark());
    } catch { /* corrupt → start empty, leave watermark as-is */ }
  }

  function persist() {
    if (!filePath) return;
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        summary,
        lastSummarizedTs: getWatermark(),
      }, null, 2), 'utf8');
    } catch { /* persistence is best-effort; never block compaction on a write failure */ }
  }

  // One compaction pass. Returns true if a compaction was attempted (success or failure), false if
  // skipped (not enough new turns, or already summarizing).
  async function tick() {
    const finals = getFinals();
    const watermark = getWatermark();
    if (!shouldSummarize(finals, watermark)) return false;
    if (summarizing) return false; // a slow compaction must not double-run or block
    summarizing = true;
    try {
      const userMessage = buildSummaryUserMessage(finals, watermark, summary);
      let result;
      try {
        result = await summarize({ system: MEMORY_SUMMARY_PROMPT, userMessage });
      } catch (e) {
        // A failed compaction does NOT advance the watermark — those turns will be retried on the
        // next tick once the provider is healthy. The latch is released in the finally below.
        if (DEBUG) console.log('[memory] summarize failed (will retry next tick):', e && e.message);
        return true;
      }
      // A non-throwing completion (including "(none)") advances the watermark past these turns so
      // we never re-process them; the summary is the merged result (no-op when "(none)").
      summary = appendSummary(summary, result);
      const wm = nextWatermark(finals, watermark);
      setWatermark(wm);
      persist();
      return true;
    } finally {
      summarizing = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive for compaction
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function getSummary() { return summary; }
  function isSummarizing() { return summarizing; }
  function running() { return timer !== null; }

  return { load, persist, tick, start, stop, getSummary, isSummarizing, running };
}

module.exports = {
  MIN_NEW_TURNS, SUMMARY_INTERVAL_MS, MAX_SUMMARY_CHARS,
  newTurnsSince, shouldSummarize, buildSummaryUserMessage, nextWatermark, appendSummary,
  createMemoryRunner,
};
