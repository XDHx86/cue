// Ring-buffered transcript state. Replaces the unbounded `transcript = []` that
// previously grew forever in main.js. `finals` is capped at TR_MAX_TURNS (oldest evicted
// beyond the cap); `partials` holds the live per-channel streaming partial; `lastSummarizedTs`
// is the rolling-summary watermark that memory.js advances.
//
// The finals array shape ({ channel, text, ts }) is preserved, so prompts.js
// formatTranscript — which only reads via .slice()/.map() — keeps working unchanged.

const TR_MAX_TURNS = 200;

const transcriptState = {
  finals: [],                         // { channel, text, ts }[] — ring, oldest evicted beyond maxTurns
  partials: { you: '', them: '' },    // live streaming partial per channel (updated by STT onPartial)
  lastSummarizedTs: 0,               // rolling-summary watermark (advanced by memory.js)
  maxTurns: TR_MAX_TURNS,            // configurable via settings (set by main.js on startup)
};

// Configure transcript ring-buffer limits. Called by main.js on startup from settings.
function setTranscriptConfig({ maxTurns } = {}) {
  if (typeof maxTurns === 'number' && maxTurns > 0) transcriptState.maxTurns = maxTurns;
}

// Append a finalized turn, evicting the oldest once the ring is full. Returns the turn.
function pushFinal(turn) {
  transcriptState.finals.push(turn);
  if (transcriptState.finals.length > transcriptState.maxTurns) transcriptState.finals.shift();
  return turn;
}

function setPartial(channel, text) { transcriptState.partials[channel] = text; }
function clearPartial(channel) { transcriptState.partials[channel] = ''; }
function getPartial(channel) { return transcriptState.partials[channel] || ''; }
function getFinals() { return transcriptState.finals; }

// For Ctrl+Alt+A immediate assist: the assistant answers from the finalized turns plus
// the current live partials (both channels), so asking mid-speech reflects what is being
// said right now without waiting for the partial to finalize.
function liveTranscriptForPrompt() {
  const turns = transcriptState.finals.map((t) => ({ channel: t.channel, text: t.text, ts: t.ts }));
  if (transcriptState.partials.you) turns.push({ channel: 'you', text: transcriptState.partials.you, ts: Date.now() });
  if (transcriptState.partials.them) turns.push({ channel: 'them', text: transcriptState.partials.them, ts: Date.now() });
  return turns;
}

function reset() {
  transcriptState.finals = [];
  transcriptState.partials = { you: '', them: '' };
  transcriptState.lastSummarizedTs = 0;
}

module.exports = {
  TR_MAX_TURNS,
  transcriptState,
  pushFinal,
  setPartial, clearPartial, getPartial,
  getFinals, liveTranscriptForPrompt,
  setTranscriptConfig,
  reset,
};
