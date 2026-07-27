<!--
  tier:     current → long-term
  owner:    claude
  updates:  when a phase changes status (commit lands / phase starts / scope shifts)
  scope:    the phased MVP roadmap + verified integration points + the compose-system seam
  no-grow:  bound by the roadmap. COMPRESSION RULE: once a phase is committed, reduce its
            detailed section to a one-line status + commit pointer, keeping full detail only
            for in-flight and not-started phases. Never append status history.
  belongs:  what we are building and in what order
  excludes: per-session micro-progress (state.md); why decisions exist (decisions.md)
  migrates: a completed phase's rationale → decisions.md; its lessons → memory.md
-->

# implementation-plan — the cue overhaul roadmap

Re-homed from the prior ad-hoc `.claude/docs/plan.md` (content preserved in full; phase
status added). This is the dependency-ordered plan for the `feat/mvp-overhaul` branch.
Track live progress in [state.md](state.md); track line-numbers from the planning snapshot
below by **navigating to the named symbol**, not the raw line (lines drift with each commit).

## Phase status (detailed plan, below)

| Phase | Scope | Status |
|---|---|---|
| **0a** | B1 re-render / ring buffer / watchdog | ✅ committed (`5422c30` `a3ad3f0` `cf8debb` `8cbd467`) — detail below archived |
| **0b** | B2 Zoom overlay + primary display | ✅ committed (`2faec2b`) — detail below archived |
| **1** | F1 `.env` system | ✅ committed (`b10fa03`) — detail below archived |
| **2** | F3 Ollama provider | ✅ committed (`48c6552`) — detail below archived |
| **3** | F4 faster-whisper + F6 continuous streaming + F13 `Ctrl+Alt+A` | ✅ committed (`93bcf58` `a3f3a4b` `ee29e56` `9d17ac9`) — detail below archived |
| **4** | F8/F9/F10/F11 composition-point refactor (skills, memory, pre-prompt, résumé) | 🟡 next |
| **5** | F5 show/hide (`Ctrl+Alt+C`), F2 drag, F12 vision speed | ⬜ not started |
| **4** | F8/F9/F10/F11 composition-point refactor (skills, memory, pre-prompt, résumé) | ⬜ not started |
| **5** | F5 show/hide (`Ctrl+Alt+C`), F2 drag, F12 vision speed | ⬜ not started |
| **6** | F7 HTTP error codes + polish | ✅ committed (`fdbe892`) — detail below archived |

Compression note: the detailed sections for committed phases (0a/0b/1/6) are retained below
for reference until the work has fully settled, then they will be reduced to the status line
above. Detail is kept in full for the in-flight phase (2) and not-started phases (3–5).

---

# MVP Roadmap (high-level, 9 phases)

- **Phase 0 — Stability Foundation** — memory leak / rerender loop; ring-buffer transcript;
  resource cleanup; streaming watchdog; Zoom overlay fix; window ownership; correct display
  selection; diagnostics foundation; Resource Manager skeleton.
- **Phase 1 — Core Infrastructure** — `.env` system; configuration; persistence abstraction;
  event bus; cache manager; versioned data models; HTTP error normalization; provider
  capability abstraction; diagnostics subsystem.
- **Phase 2 — Provider Platform** — Ollama; capability-based providers.
- **Phase 3 — Streaming Audio Platform** — faster-whisper; continuous streaming STT; live
  transcription; `Ctrl+Alt+A`.
- **Phase 4 — Context Platform** — context providers; prompt composer; context budget
  manager; resume optimization; pre-prompts; Claude skills.
- **Phase 5 — Meetings & Memory** — meeting sessions; rolling summaries; persistent memory;
  session recorder; artifacts.
- **Phase 6 — Commands** — command system; AI task queue.
- **Phase 7 — UX** — `Ctrl+Alt+C`; draggable window; vision improvements.
- **Phase 8 — Polish** — documentation; setup guides; benchmarks.

---

# cue — features & bug-fix overhaul (detailed plan)

## Context

cue is a plain HTML/CSS/JS Electron overlay (no build step, no native modules by design). It
captures screen + mic + meeting audio, transcribes, and streams AI answers from a
bring-your-own-key provider. The audio pipeline today is **batched**: a fixed 3.5 s flush
loop, silence-gated, sent per chunk (`FLUSH_MS=3500`). It repeatedly sends the full 12 k
résumé on **every** LLM call, has **no** memory/RAG, vague HTTP error messages, a slow
full-res PNG vision path, and no window show/hide or live-assist shortcuts. Two bugs degrade
it: a re-render/memory-pressure issue during long streams, and Zoom's share overlay hiding
cue (a Windows always-on-top z-order bug).

This change adds 13 features and fixes 2 bugs, organized into dependency-ordered phases. The
four materially-ambiguous design decisions are already resolved (logged as
[ADR-006…009](decisions.md)):

1. **faster-whisper** runs as a **local WebSocket streaming server** you start; cue is the WS
   client (POST fallback). No native modules.
2. **Memory/RAG** = **rolling summary + user-curated persistent notes** injected into prompts.
   No embeddings / vector store.
3. **Audio** = **continuous streaming STT is the default pipeline**: capture never pauses, the
   assistant tracks live **partial + finalized** transcripts, **VAD is used only for endpoint
   detection / segmentation** (not to start transcription), and a user can request an
   **immediate response at any time without interrupting** the ongoing transcription stream.
4. **claude-code skills support** = cue **loads `.claude/skills/*.md`** from a project dir and
   applies them as behavioral guidance in prompts.

Ground truth — verified integration points (line numbers are from the planning snapshot;
navigate by symbol, not by line, lines drift with commits):

- **Settings** — [src/store.js](../../src/store.js) `DEFAULTS`, auto-switch `validProviders`,
  `deepMerge`, `getSettings`/`setSettings`.
- **Main** — [main.js](../../main.js) `state`, `transcript` (now the ring-buffered
  `transcriptState` from `src/transcript.js`), the flush loop, `runFeature` (calls
  `appendResumeContext(def.system, settings.resumeContext)` at the single system-prompt
  composition point), `createWindow`, `RESERVED_SHORTCUTS`, `registerAssistShortcut`/`registerShortcuts`,
  IPC handlers, `setDisplayMediaRequestHandler` (returns `sources[0]` — the Phase-0b fix picks
  the primary display source instead), the Windows `setAlwaysOnTop` level (Phase-0b raised to
  `'screen-saver',1`).
- **LLM** — [src/llm.js](../../src/llm.js) provider switch (nvidia = `streamOpenAI` + `baseURL`
  — the clone pattern reused by Ollama), all `streamX` re-throw through `normalizeSDKError`
  (Phase-6), `maxTokens=4096` pinned, `stripDataUrl`.
- **STT** — [src/stt.js](../../src/stt.js) chain by `apiKeys` presence; no early-exit on error;
  no "local" concept yet.
- **Resume** — [src/profile-context.js](../../src/profile-context.js) `appendResumeContext`
  (single call site, the composition point).
- **Prompts** — [src/prompts.js](../../src/prompts.js); `recap` uses
  `formatTranscript(transcript, 0)` (unbounded; the ring buffer bounds it).
- **Renderer token path** — `renderer/renderer.js` per-token `<span>` (now rAF-coalesced per
  Phase-0a); `mousemove` click-through (now rAF-throttled); drag region already exists
  (`#toolbar { -webkit-app-region: drag; }` in `renderer/styles.css`).
- The `transcript` channel is allowlisted in [preload.js](../../preload.js) but **never
  consumed** by the renderer — Phase 3b adds the consumer.

## Shared: system-prompt composition (Phase 4 seam)

Four features (pre-prompt, skills, memory, résumé-efficiency) all edit the one composition
point in `runFeature`. Introduce a single seam so they don't collide:

NEW `src/prompt-compose.js`: `composeSystem({ def, settings,
memoryState })` concatenates, in this order:

1. **Pre-prompt** (`settings.prePrompt`, or a built-in template) — user instructions, frames
   "who you are to me". Placed **first**, before the mode system.
2. **Mode system** (`def.system`) — as today.
3. **Skills** — from `src/skills.js`: `loadSkillDir(settings.skillDir)`
   parses `.claude/skills/*.md` frontmatter `{name, description}` + body, capped
   (`MAX_SKILLS_CHARS=8000`). Framing is **instructions** ("Apply these as behavioral guidance
   when relevant.") — the opposite of résumé's untrusted-data framing; must **never** appear
   inside the résumé fence.
4. **Memory** — rolling summary (≤2000 chars) + user notes (`settings.memory.notes`, ≤4000
   chars) as `## Conversation memory (apply as context)`.
5. **Résumé** — only when `def.wantsResume === true`; two tiers (full vs `settings.resumeSummary`).

The single `appendResumeContext(...)` call becomes
`system: composeSystem({ def, settings, memoryState })`.

## Phased plan

### Phase 0a — B1: re-rendering / memory pressure  ✅ committed
- `renderer/renderer.js` `appendToken`: accumulate into a single `<span class="w">` text node,
  coalesced on `requestAnimationFrame` (drop per-token nodes + `insertBefore` reflow); reset in
  `finalizeAi` and `clearMessages`.
- `renderer/renderer.js` `mousemove`: wrap `elementFromPoint`/`closest` in a `requestAnimationFrame`
  coalescer (cap 60 Hz); add `#transcript-strip` to the hit-test selector once Phase 3 adds it.
- `main.js`: replace the flat `transcript=[]` with the ring-buffered `transcriptState` from
  `src/transcript.js` (`TR_MAX_TURNS=200`). Update the lone read site (`runFeature`'s
  `def.build`) to pass `getFinals()`.
- `main.js` `runFeature`: 30 s idle watchdog — if no token within 30 s, emit `llm:error`,
  release `state.busy`, null the renderer's `aiEl`. Prevents the stuck-`state.busy`-forever
  lock when an SDK stream hangs.

### Phase 0b — B2: Zoom share overlay hides cue  ✅ committed
- `main.js` Windows branch: `win.setAlwaysOnTop(true, 'screen-saver', 1)` (was default-level)
  + `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. macOS already uses
  `'screen-saver', 1`.
- `main.js` `setDisplayMediaRequestHandler`: pick the source matching
  `screen.getPrimaryDisplay().id` instead of always `sources[0]`.

### Phase 1 — F1: `.env` system (dependency-free)  ✅ committed
- NEW [src/env.js](../../src/env.js): hand-rolled `.env` parser (no `dotenv` dep); `loadDotenv()`
  resolves `CUE_ENV_PATH` → `userData/.env` → `cwd/.env`, applies `KEY=value` (skipping `#`
  comments and shell-set vars), strips surrounding quotes.
- `main.js`: call `loadDotenv()` as the first line after `DEBUG`, **before** `require('./src/store')`
  so env is populated before store reads it.
- [src/store.js](../../src/store.js) `load()`: after `deepMerge`, apply `CUE_*` overrides (keys:
  `CUE_OPENAI/ANTHROPIC/GEMINI/NVIDIA/OLLAMA/DEEPGRAM_API_KEY`, `CUE_OLLAMA_BASE_URL`,
  `CUE_FASTER_WHISPER_URL`, `CUE_STT_PROVIDER`, etc.). Env overrides are **runtime-only**, never
  persisted to `cue-data.json`.
- Docs: README "Configuration via .env" section + ship a `.env.example` (dev-only, not in the
  `files` allowlist).

### Phase 2 — F3: Ollama provider  🟡 in-flight
- [src/llm.js](../../src/llm.js) provider switch: `if (provider === 'ollama') return
  streamOpenAI({ ...args, baseURL: (settings.ollama && settings.ollama.baseURL) ||
  'http://localhost:11434/v1', apiKey: 'ollama' })` (OpenAI SDK needs a non-empty `apiKey`;
  Ollama ignores it).
- [src/store.js](../../src/store.js) DEFAULTS: `ollama:''` → actually the sentinel `'ollama'`
  in `apiKeys` (see ADR-005); `ollama:{ fast:'llama3.2', smart:'llama3.3' }` in `models`;
  `ollama:{ baseURL:'' }`; push `'ollama'` to `validProviders`. Ollama needs a special-case
  in the auto-switch and `createLLM` `ready` check (llm.js) since it has no real key (treat the
  dummy `'ollama'` as ready).
- [renderer/index.html](../../renderer/index.html) `#provider-seg` + key/baseURL fields;
  [renderer/renderer.js](../../renderer/renderer.js) `fillSettings`/`saveSettings`/`statusText`
  enumerate `ollama`.
- Docs: README "Use Ollama (local models)".

### Phase 3 — faster-whisper + continuous streaming + immediate assist  ⬜ (largest)

**3a — F4 faster-whisper provider:**
- NEW `src/stt-stream.js`: `createStreamSTT(settings) → { available, provider,
  sessions:{ you, them } }`. `FasterWhisperStreamSession` opens WS to `ws://localhost:9080`
  (env-overridable), sends a JSON handshake `{sample_rate:16000,channels:1,language:null}`,
  then binary Int16 frames every ≤60 ms; parses `{type:'partial'|'final', text, ts}` with
  `onPartial`/`onFinal`/`onError`. Reconnect with exponential backoff; on 3 auth/connect
  failures set `sttDisabled`. Also add `transcribeFasterWhisperHTTP`/chain entry for the batch
  fallback in `src/stt.js`.
- [src/store.js](../../src/store.js) DEFAULTS: `stt:{ provider:'auto',
  fasterWhisperURL:'ws://localhost:9080', deepgramURL:'wss://api.deepgram.com/v1/listen',
  model:'' }` (migrate any existing top-level `sttModel`). `auto` picks
  faster-whisper if URL set → Deepgram if key → else batch.
- Renderer settings: STT provider seg + endpoint + model fields.
- Docs: NEW `docs/faster-whisper-setup.md` with a reference Python WS server (faster-whisper +
  VAD endpoint detection, binary-frame protocol spec) + `pip install faster-whisper`. README
  links it.

**3b — F6 continuous streaming pipeline:**
- `main.js`: replace `flushChannel`/`startFlushLoop` with stream-session lifecycle —
  `openStreamSessions()` on `setCapturing(true)`, `closeStreamSessions()` on
  `setCapturing(false)`. `mic:pcm`/`system:pcm` handlers feed the active session (never gated
  by `state.busy`) instead of buffering. Final → push to `transcriptState.finals` (the ring),
  clear `partials[channel]`, `send('transcript', turn)`; partial → set `partials[channel]`,
  `send('transcript:partial', {channel,text,ts})`. If no streaming provider available, degrade
  to a 2 s batch loop using existing `createSTT` (capture never pauses).
- `sttDisabled` rethink: per-session `streamErrorStreak`; latch on 3 failures; reset on
  `settings:set` (already there). `openStreamSessions()` checks the latch, emits
  `stt:status {active:false, reason}` otherwise.
- [preload.js](../../preload.js) allowlist: add `'transcript:partial'`, `'stt:status'`.
- `renderer/renderer.js`: add `cue.on('transcript', …)` (finalized turns) and
  `cue.on('transcript:partial', …)` (live partial cell) — the `transcript` channel finally
  gets a consumer.
- `renderer/index.html`: add `<div id="transcript-strip">` inside `#panel` above `#messages`;
  `renderer/styles.css`: muted `.turn` / `.turn.you` / `.turn.them` / `.turn.partial` styling.

**3c — F13 `Ctrl+Alt+A` immediate assist:**
- `main.js`: add `'control+alt+a'` to `RESERVED_SHORTCUTS`; `registerShortcuts()` registers
  `Control+Alt+A` → `runFeature('assist','')`. `runFeature` composes the prompt from
  `getFinals()` **+ current partials** (`liveTranscriptForPrompt()` from `src/transcript.js`)
  so the assistant answers from the live state. Because STT sessions are owned by `setCapturing`
  and never gated by `state.busy`, requesting an answer never interrupts the transcription stream.

### Phase 4 — Composition-point refactor (F8 + F9 + F10 + F11, bundle together)  ⬜
- NEW `src/skills.js`: `loadSkillDir(dir)` reads `dir/.claude/skills/*.md`,
  parses frontmatter, returns `[{name,description,body}]` capped at 8000 chars; cache per
  capture session with directory mtime check.
- NEW `src/memory.js`: rolling summary on a 60 s `setInterval` (started/stopped next to the
  flush/stream loop in `setCapturing`); when ≥10 new finalized turns exist beyond
  `lastSummarizedTs`, run an LLM compaction call (`MEMORY_SUMMARY_PROMPT`, its own
  `summarizing` latch — never touches `state.busy`) appending to the summary and bumping the
  watermark. Persist rolling summary to `userData/cue-memory.json` (separate from settings);
  user notes live in `settings.memory.notes`.
- [src/prompts.js](../../src/prompts.js): add `wantsResume` to each mode
  (assist/say/ask `true`; followup/recap/leetcode `false`); add `MEMORY_SUMMARY_PROMPT` +
  `RESUME_SUMMARY_PROMPT`. `formatTranscript` already works on the ring shape — no change.
- [src/profile-context.js](../../src/profile-context.js): add `composeResumeSection(def,
  settings)` returning full résumé (when `def.wantsResume && !def.small`) vs
  `settings.resumeSummary` (≤1500 chars, auto-generated on save). Keeps the existing
  untrusted-data framing inside the gate.
- [src/store.js](../../src/store.js) DEFAULTS: add `prePrompt`, `prePromptTemplate`,
  `skillDir`, `skillEnabled`, `memory:{notes:''}`, `resumeSummary`.
- `main.js`: `runFeature` uses `composeSystem({ def, settings, memoryState })` at the
  composition point; `settings:set` hook regenerates `resumeSummary` when `resumeContext` changes.
- Renderer: pre-prompt textarea + template selector (Concise direct / Interview coach / Senior
  engineer / Friendly meeting copilot / Custom); skills toggle + dir path + reload; memory-notes
  textarea (maxlength 4000). Wire in `fillSettings`/`saveSettings`.

### Phase 5 — F5 show/hide, F2 drag, F12 vision  ⬜
- **F5 `Ctrl+Alt+C`**: `main.js` add `'control+alt+c'` to `RESERVED_SHORTCUTS`; register
  `Control+Alt+C` → toggle `win.isVisible() ? win.hide() : win.showInactive()` (reapply
  `setAlwaysOnTop(true,'screen-saver',1)` on Windows after re-show). Match the existing
  hard-coded `Cmd+H` / `Shift+X` registration pattern; document in README. (Optional polish:
  generalize `registerAssistShortcut` into `registerShortcut(name,…)` + recorder UI so both
  `Ctrl+Alt+C` and `Ctrl+Alt+A` are user-configurable — the Assist recorder in `renderer.js`
  is reusable as-is.)
- **F2 drag**: already exists (`#toolbar` drag region). Optionally extend
  `-webkit-app-region: drag` to the settings/onboard headers. The real "can't move/see" pain
  was B2 (Zoom), fixed in Phase 0b.
- **F12 vision**: [src/screen.js](../../src/screen.js) cap thumbnail longest edge to 1568 px,
  `img.resize({width,height,quality:'good'})` then `img.toJPEG(0.85)` →
  `data:image/jpeg;base64,…`; add a 1.5 s TTL cache for rapid ask bursts. No `src/llm.js` change
  — `stripDataUrl` already passes the mime through to all three providers.

### Phase 6 — HTTP error codes + polish  ✅ committed
- NEW [src/errors.js](../../src/errors.js): `normalizeSDKError(err, provider) → { status, code,
  provider, message, suggestion }`, branching 401 / 403 / 429 / 5xx / `model_not_found` /
  network (see the map in [providers.md](providers.md)).
- `src/llm.js` streamX catches: re-throw `normalizeSDKError(err,'<provider>')`. `main.js`
  `runFeature` catch: build the user-facing string from `e.status/code/provider/suggestion`;
  route streaming errors through the same normalizer.
- README sweep: note continuous streaming, faster-whisper, Ollama, skills, pre-prompt, memory,
  `Ctrl+Alt+C`/`A` — once those phases land.

## Testing (verification)
- **Unit tests** (pure-Node, no `electron` import — keep electron-dependent bits param-injected
  like `src/profile-context.js`): `test/env.test.js`, `test/prompt-compose.test.js` (ordering +
  section framing + résumé gating), `test/skills.test.js` (frontmatter parse + size cap),
  `test/memory.test.js` (rolling summary serialization), `test/errors.test.js`
  (status→suggestion mapping). Run with `npm test`.
- **Pipeline smoke**: `npm start`; confirm `Ctrl+H` leetcode, `Ctrl+Shift+X` quit,
  `Ctrl+Alt+C` hide/show, `Ctrl+Alt+A` immediate assist. Watch console with `DEBUG=true` in
  `main.js` / `src/llm.js` for stream + transcript traces.
- **Streaming STT**: start `faster-whisper` WS server (per docs), set `CUE_FASTER_WHISPER_URL`,
  turn listening on → assert live partials render in `#transcript-strip` and finalize into
  turns; verify asking (Ctrl+Alt+A) during active speech answers from current partials without
  pausing capture. Kill the server to confirm reconnect → `stt:status` badge and batch
  fallback still produce finals.
- **B1/B2**: start a long LLM response then close the lid / drop the network → watchdog
  releases `state.busy` (UI unblocks) and audio keeps transcribing; on Windows running Zoom and
  sharing screen, cue stays visible on top; check DevTools `Performance` for steady memory
  during a multi-minute capture session (per-token span batching + ring cap).
- **Vision/F12**: an `ask` with screen → confirm JPEG payload (network tab) is KB not MB and
  ≤1568 px; two `ask`s within 1.5 s reuse the cached screenshot.
- **`.env`/Ollama**: with a `.env` providing `CUE_OPENAI_API_KEY` and no key in Settings, confirm
  loading works (provider ready); select Ollama provider → a local `ollama serve` answers;
  confirm Settings reflects env-supplied key without persisting it on save.
