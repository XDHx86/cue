Project Handoff — cue registry-driven refactor
1. Project Overview
Goal of cue. cue is an Electron overlay app — a frameless, transparent, always-on-top window that floats over everything, sees the screen, hears the microphone and meeting audio, and streams AI answers. Plain HTML/CSS/JS, bring-your-own-key (OpenAI, Anthropic, Gemini, Nvidia, Ollama), no server, no telemetry. macOS + Windows supported.

The refactor being executed. Make the app driven entirely by registries, capabilities, and configuration — no hardcoded providers, shortcuts, settings, or model lists. Adding a provider/shortcut/prompt must require only creating one folder / one registry entry, with zero edits to switches or Settings UI. Full approved plan: C:\Users\karee\.claude\plans\curried-toasting-badger.md.

Current architecture (three Electron layers).

Main — main.js (828 lines): creates the overlay window, owns global shortcuts, accumulates PCM, runs the flush→transcribe loop, orchestrates runFeature.
Preload — preload.js: tight contextBridge exposing window.cue with an explicit IPC allowlist. contextIsolation:true, nodeIntegration:false, sandbox:false.
Renderer — renderer/: renderer.js (826 lines: UI state, markdown render, settings fill/save, shortcut recorder, transcript strip), index.html (235), styles.css, pcm-processor.js (AudioWorklet float→Int16), icons.js.
Three inputs kept on separate you/them channels end-to-end (central invariant): screen (src/screen.js), mic ("you"), meeting audio ("them"). The channel tag survives transcript→prompt→render. Audio is captured in the renderer (reuses cue's own Screen-Recording grant — no helper binary).

Tech stack. Plain HTML/CSS/JS. Electron (no build step, no bundler, no TS, no linter). asar:false (ships unpacked). Node --test runner. Pino + pino-pretty + pino-roll for logging (pure-JS deps, no native modules). Python (Loguru) for the managed local STT service.

Repository structure relevant to the work.


main.js              # window, shortcuts, STT pipeline, runFeature, IPC handlers
preload.js           # contextBridge + IPC allowlist (three-leg gate)
src/
  registry.js            # NEW (R1a) — provider registry spine
  registry-loader.js    # NEW (R1a) — folder discovery
  store.js               # DEFAULTS, deepMerge, env overrides, migrations
  llm.js                 # createLLM — the if/else provider switch (R1 removes it)
  stt.js                 # createSTT — hardcoded batch chain (R2 removes it)
  stt-engine.js          # LOCAL engine registry (registerEngine) — to fold into R2
  stt-stream.js          # createStreamSTT, resolveProvider, WS framing
  stt-process.js         # createSttProcessManager (Python lifecycle, param-injected)
  stt-models.js          # STT_MODEL_SIZES, scanCachedModels
  prompt-registry.js     # PROMPT_REGISTRY, resolveField, registrySpec (server-ready, UI unwired)
  preprompt.js           # getPrePromptChoice, buildPrePromptOverride (preload pass-through)
  prompt-compose.js      # composeSystem
  prompts.js             # MODES, formatTranscript, summary prompts
  logger.js              # Pino singleton (no per-module levels / live reconfigure / UI yet)
  errors.js, screen.js, env.js, wav.js, profile-context.js, skills.js, memory.js, transcript.js
renderer/ index.html renderer.js styles.css pcm-processor.js icons.js
python/ cue_stt_service.py cue_stt_logging.py   # managed STT service
test/  (21 files, pure-Node, param-injected)
2. Current Progress
Task	Status	Notes
R1a — registry foundation	Completed	src/registry.js, src/registry-loader.js, test/registry.test.js (11 tests pass)
R1b — migrate LLM providers to folders	Completed	5 providers under src/providers/llm/<id>/index.js + openai-compat.js + shared.js; test/providers.test.js (7 tests pass)
R1c — rewrite createLLM + store defaults	Completed	src/llm.js is a thin registry delegate; store.js folds provider defaultSettings into DEFAULTS; loadProviders() at startup. 238/238 tests pass.
R2 — STT provider registry	Not Started	next
R3 — auto-generated provider Settings UI	Not Started	
R4 — configurable shortcuts + actions	Not Started	
R5 — prompt editing UI	Not Started	
R6 — live transcription popup	Not Started	
R7 — configurable logging	Not Started	
R8 — docs & governance	Not Started (partial: ADR-017 + state/providers/conventions updated as R1 landed)
What was implemented (R1a).

src/registry.js: defineProvider(desc), listProviders({type}), getProvider(type,id), hasProvider, renderSafe, listProvidersSafe, resolveSupportedModels. Providers keyed ${type}:${id} so same-named LLM/STT providers coexist. Validates descriptor shape (throws on malformed). renderSafe strips function values for IPC. resolveSupportedModels handles static array ∣ function(ctx)→Promise<array> ∣ null. _resetProviders test hook.
src/registry-loader.js: folder discovery — scans src/providers/llm/<id>/index.js and src/providers/stt/<id>/index.js via fs.readdirSync. Pure given injected fs/path/_require. loadProviders({types,root,fsObj,pathObj,_require}), loadProvidersOfType, discoverProviderFiles.
test/registry.test.js: 11 tests covering namespacing, ordering, validation, unsubscribe, renderSafe, resolveSupportedModels (static/function/null), folder discovery, loadProviders scoping — all param-injected (temp dirs, no real src/providers).
Why this way. Two registries (LLM, STT) sharing one descriptor shape preserves the CLAUDE.md invariant that LLM and STT are decoupled ("Anthropic has no audio API"). Pure JS, no electron/eager-SDK require → tests stay electron-free (conventions.md). Providers lazy-require their SDK inside createEngine so store can fold defaultSettings without pulling SDKs.

Shared provider descriptor shape (defined in src/registry.js):


{
  id, displayName, description,
  providerType,            // 'llm' | 'stt'
  capabilities,            // { streaming, batch, transcription, vision, local, ... }
  supportedModels,         // [{id,label}] | function(ctx)=>array|Promise | null
  configurableSettings,    // [{id,label,type,placeholder,secret,options?,default?}] → drives Settings UI
  defaultSettings,         // partial settings contributed to store DEFAULTS (auto-folded)
  order,                   // STT fallback priority; LLM Settings display order
  createEngine(ctx),       // LLM → {provider,model,apiKey,ready,stream(params)}; STT-batch → {transcribe(pcm)}
  createStreamSession(ctx) // STT-only optional → {start,sendAudio,close} + onFinal/onPartial/onStatus/onError
}
Allowed field kinds (in FIELD_KINDS): text, secret, number, select, seg, boolean. The renderer's buildProviderFields is the one place field-types are enumerated.

3. Detailed TODO
R1b — Migrate LLM providers into src/providers/llm/<id>/index.js
Objective. Move the 5 LLM providers (openai, anthropic, gemini, nvidia, ollama) into self-describing folders, each calling defineProvider.
Why. Delete the if/else switch in src/llm.js createLLM; Settings auto-builds from descriptors.
Expected. Port streamOpenAI/streamAnthropic/streamGemini (in src/llm.js L27–122) into each createEngine. nvidia = OpenAI clone with baseURL: https://integrate.api.nvidia.com/v1. ollama = OpenAI clone + sentinel apiKey:'ollama' + settings.ollama.baseURL||http://localhost:11434/v1. Each declares capabilities, configurableSettings (apiKey/secret, model tiers, baseURL/text, temperature/number), defaultSettings (matching today's DEFAULTS), supportedModels (suggested list; free-text override remains), order. SDK require inside createEngine. Each provider calls defineProvider at module load.
Dependencies. R1a (done).
Priority. High — next.
Pitfalls. Must preserve exact ready logic (ollama: !!model; others: !!apiKey && !!model); maxTokens=4096 pinned (Anthropic requires it); stripDataUrl mime preservation; normalizeSDKError re-throw per provider; the child('llm') lazy logging guard (getLogger outside app → noopLogger). Image attachment differs per provider (OpenAI image_url, Anthropic source.type:'base64', Gemini inlineData) — port verbatim.
Files. New src/providers/llm/{openai,anthropic,gemini,nvidia,ollama}/index.js. Likely a shared helper for the OpenAI-clone providers.
R1c — Rewrite src/llm.js createLLM + fold defaults in src/store.js
Objective. createLLM → getProvider('llm', settings.provider).createEngine({settings}); store DEFAULTS built from provider defaultSettings.
Why. Completes the LLM registry conversion.
Expected. src/llm.js keeps stripDataUrl, logging, but delegates to registry. src/store.js load(): fold each LLM provider's defaultSettings into DEFAULTS.apiKeys/models — values must equal today's so nothing migrates (or keep literal DEFAULTS and assert equivalence). Keep test/store-defaults.test.js green. main.js calls loadProviders() once at startup before any createLLM.
Dependencies. R1b.
Priority. High.
Pitfalls. store.js requires electron for app.getPath and DEFAULT_PRE_PROMPT_TEMPLATE from prompt-registry (don't break the load-time migration). The auto-switch-provider logic in store.load() (line 139) and ENV_OVERRIDES (lines 154–182) must keep working. deepMerge never deletes keys (sentinel model for overrides).
Files. src/llm.js, src/store.js, main.js (loadProviders call), maybe test/store-defaults.test.js.
R2 — STT provider registry (§2, §3) — port, don't fix (§9)
Objective. Migrate STT providers into src/providers/stt/<id>/index.js: faster-whisper (local), openai (Whisper), gemini, external-ws.
Why. Delete hardcoded chain.push in src/stt.js; stt:engine:list reads the registry.
Expected. faster-whisper provider: createBatchEngine→transcribeFasterWhisperLocal (from src/stt.js L63), createStreamSession→LocalFasterWhisperSession (from src/stt-engine.js), supportedModels from cache scan (scanCachedModels with ctx.fs), configurableSettings={model,device,computeType,language,vad,threads,beamSize}, capabilities={streaming,batch,local}. openai Whisper: supportedModels=[whisper-1, gpt-4o-mini-transcribe, …], settings={apiKey,baseURL,model,language,temperature}. gemini: settings={apiKey,endpoint,model,language}. external-ws: capabilities={streaming}, settings={url}. createSTT builds chain from listProviders({type:'stt'}) filtered by readiness + order. stt-stream.js resolves stream sessions via provider createStreamSession. Fold stt-engine.js's registerEngine/engineMeta into the provider registry (keep LocalFasterWhisperSession class + localLoadParams; update stt:engine:list + test/stt-engine.test.js).
Dependencies. R1.
Priority. High.
Pitfalls. §9: do NOT fix the local/offline transcription bug — port it faithfully. Keep test/stt-engine.test.js, test/stt-stream.test.js, test/stt-models.test.js, test/stt.test.js green. The local-only-on-venv-ready gate (manager.isVenvReady()) must stay. download_root must pass on model ops. Keep the watch-dog / degrade-to-batch contract in main.js. resolveProvider in stt-stream must stay pure (readiness is a passed-in hint).
Files. New src/providers/stt/*/index.js. src/stt.js, src/stt-stream.js, src/stt-engine.js (trim), main.js (stt:engine:list), tests.
R3 — Auto-generated provider Settings UI (§3, §4)
Objective. providers:spec IPC → {llm:[…], stt:[…]} render-safe descriptors; renderer builds provider buttons + key/baseURL/model fields + provider-specific options from configurableSettings, model <select> from supportedModels.
Why. Replace hardcoded #provider-seg, #key-*, #ollama-baseurl, Models-tab fast/smart inputs, and Transcription-tab hardcoded language/compute/device lists.
Expected. IPC providers:spec (invoke). Preload providersSpec() + allowlist. Renderer buildProviderFields(spec) (text/secret/number/select/seg) + buildModelSelect (free-text override for LLM). Generalize fillSettings/saveSettings/statusText over the spec. STT-local model list already dynamic (cache scan) — extend pattern to LLM/cloud-STT.
Dependencies. R1, R2.
Priority. High.
Pitfalls. Keep settings shape stable through R1–R3 so prior commits stay green; swap UI last. The three-leg IPC (preload+main+renderer). index.html and renderer/renderer.js are the bulk. Manual field-reachability check needed (headless Electron can't open the panel).
Files. preload.js, main.js, renderer/renderer.js, renderer/index.html.
R4 — Configurable shortcuts (§1) + build shortcut actions
Objective. New src/shortcuts.js registry (defineShortcut({id,label,scope:'global'|'local',defaultAccelerator,defaultEnabled,category,handler})). main registerShortcuts() built from registry. Persist settings.shortcuts[id]={accelerator,enabled}. Conflict detection across all enabled globals + OS in-use. Per-shortcut disable, reset-to-default (per + global), live apply (re-register on set). IPC shortcuts:spec/set/reset.
Why. Today only assist is editable; leetcode/quit/immediateAssist/showHide are hardcoded in registerShortcuts() + RESERVED_SHORTCUTS.
Expected. Migrate 4 hardcoded shortcuts into the registry with today's defaults (behavior unchanged). Renderer generates Shortcuts tab from spec (record buttons + enable toggles + reset), generalizing the existing Assist recorder (keyEventToAccelerator/applyAssistShortcut). Show global vs local scope. Build the missing actions (per clarifying Q4): mute (renderer mic suspend/gain-0, keep system audio), pushToTalk (local scope only — Electron globalShortcut has no key-release event; keydown=start/keyup=stop, works while overlay focused), screenshot (captureScreenshot → save PNG to userData/screenshots/clipboard), ocr (new ocr mode: capture → vision model extracts text → render; uses R5's ocrPrompt/screenAnalysis), toggleMemory (memoryRunner.enable flag), toggleLogs (open log window / toggle destination).
Dependencies. None strictly (R5's prompts needed for ocr mode).
Priority. Medium-High.
Pitfalls. Push-to-talk can't be a true OS-global hold-to-talk without a native hook (forbidden by no-native-modules). RESERVED_SHORTCUTS conflict logic must extend to all enabled globals. Live apply must unregister-before-register. keyEventToAccelerator platform modifiers (CommandOrControl, macOS dual-mod). The toggleVisibility re-applies Windows setAlwaysOnTop('screen-saver',1) on re-show.
Files. New src/shortcuts.js. main.js, preload.js, renderer/renderer.js, renderer/index.html.
R5 — Prompt editing UI (§5)
Objective. Wire the existing registrySpec(): IPC prompts:spec, preload promptsSpec(), allowlist. Add a Prompts tab; generic buildPromptFields(spec). Per-field reset-to-default (writes defaultOverride(id)), live saving (settings.promptOverrides[id]), import/export JSON (prompts:import/prompts:export), variable placeholders ({{transcript}}, {{screen}}, {{userText}}, {{date}}) + applyPromptVars(template,ctx)).
Why. registrySpec() is server-ready but unwired (no IPC, no UI tab — confirmed by grep; .claude/docs/memory.md flagged it).
Expected. Add missing registry entries with defaults: systemContext, conversationSummary, screenAnalysis, ocrPrompt, transcriptionCleanupPrompt (the 8 §5 prompts). Wire consumers: composeSystem inserts systemContext first; recap mode uses conversationSummary; new ocr mode uses ocrPrompt/screenAnalysis; transcriptionCleanupPrompt hook stub. Safety boundary stays (ADR-014): never register structural/fence prompt-injection defenses.
Dependencies. R4 produces the ocr mode that consumes ocrPrompt/screenAnalysis.
Priority. Medium.
Pitfalls. prompt-registry.js resolveField/defaultOverride/isOverridden already exist — reuse. composeSystem (in src/prompt-compose.js) is the single composition seam. settings.promptOverrides[id] is a delta; empty sentinel = default (deepMerge never deletes).
Files. src/prompt-registry.js (add entries), src/prompt-compose.js, main.js (IPC), preload.js, renderer/renderer.js, renderer/index.html.
R6 — Live transcription popup (§6) — both surfaces
Objective. Keep inline #transcript-strip. New src/transcript-window.js: frameless, transparent, always-on-top ('screen-saver',1), resizable:true BrowserWindow from renderer/transcript-popup.html+transcript-popup.js+css. main fans transcript/transcript:partial/stt:status to it.
Why. §6 wants a floating, draggable, resizable, transparent, always-on-top popup (clarifying Q3 = "both surfaces").
Expected. Drag region + resized size/position persisted. Settings settings.transcriptPopup (fontSize, opacity, colors, maxHistory, position, hideAfterMs, showTimestamp, showConfidence). Thread confidence only if Python service emits it (else omit gracefully). Hide-after-inactivity timer, auto-scroll, partial→final replacement.
Dependencies. None strictly; benefits from R7 logging.
Priority. Medium.
Pitfalls. Three-input channel separation must survive (popup must not collapse channels). asar:false files allowlist — add renderer/transcript-popup.*, src/transcript-window.js. setContentProtection(true) best-effort. Click-through handling for the new surface.
Files. New src/transcript-window.js, renderer/transcript-popup.{html,js,css}, main.js, preload.js, renderer/renderer.js (settings section), package.json files.
R7 — Global logging config + per-module levels (§7, §8)
Objective. src/logger.js: LOG_MODULES registry (the §7 subsystem list); per-module overrides (settings.logging.levels); live setModuleLevel (Node live; Python applies on next service start — document it); reconfigureLogging(settings). IPC logging:get/set/export/clear/openDir (shell.openPath).
Why. Logger is a Pino singleton (P2 committed) but no per-module levels, no live reconfigure, no Settings UI, no export/clear/open-dir.
Expected. Logging Settings tab: global level, per-module rows from LOG_MODULES, export/clear/open-dir buttons. Colored console (pino-pretty) + rotating files (pino-roll) surfaced/configured. Enforce every subsystem logs via child(name) with a registered module id (warn on unknown). Confirm no stray console.*.
Dependencies. None.
Priority. Medium.
Pitfalls. Singleton is cached — live reconfigure must update children. _resetSttLogger test pattern (logger tests reset per-case). stt:logging legacy block vs top-level logging block (getLogger falls back). Python level via env on spawn. Keep _resetLogger import working (test/logger.test.js).
Files. src/logger.js, main.js, preload.js, renderer/renderer.js, renderer/index.html, test/logger.test.js.
R8 — Docs & governance
Objective. Update .claude/docs/ (architecture, conventions, providers, decisions, state, implementation-plan) — compress, don't append; one owner per topic. Update human docs (README, docs/architecture.md) by linking.
Why. CLAUDE.md "Repository Knowledge Maintenance" requirement.
Expected. New ADRs: shared-descriptor/two-registry, live popup, per-module logging, shortcut registry. New seams + blast-radius in architecture.md. Registry pattern replaces switches in conventions.md.
Dependencies. After R1–R7.
Priority. Do continuously, finalize at end.
Files. .claude/docs/*.md, README.md, docs/architecture.md.
4. Completed Work (chronological)
Exploration & planning. Read CLAUDE.md, .claude/docs/*, all core src/renderer files. Discovered existing seams: prompt-registry (server-ready, UI unwired), Pino logger (no per-module/UI), stt-engine local registry (minimal metadata). Launched Plan agent; wrote 8-phase plan; ran 4 clarifying questions; plan approved.
R1a — Registry foundation.
Created src/registry.js (provider registry, pure JS, validated, renderSafe, resolveSupportedModels, namespaced by type).
Created src/registry-loader.js (folder discovery, param-injected).
Created test/registry.test.js (11 tests). Fixed one test (string-replace dropped createEngine) → 11/11 pass.
Diagnosed baseline test state. npm test hung ~5min. Root-caused to uncommitted WIP in working tree (opening git status): src/stt-process.js had RPC-timeout block commented out (→ stt-process.test.js hangs ~45s); src/logger.js had DEFAULT_LEVEL 'info'→'debug'. Per user direction ("Revert them"), ran git checkout -- src/stt-process.js src/logger.js. Also found pre-existing committed stale test in test/screen.test.js (expects JPEG_QUALITY === 0.85, but src/screen.js correctly uses 85 — Electron toJPEG takes 0–100). Fixed the test to 85 with an explanatory comment.
After revert + fix: npm test = 231 tests, 230 pass, 1 fail (the screen test — now fixing). The stt-process hang is gone.
R1b — Migrate LLM providers into folders.
Created src/providers/llm/shared.js (lazy child('llm') logger guard + stripDataUrl, kept BELOW llm.js in the require graph so providers never pull llm.js → no load-time cycle).
Created src/providers/llm/openai-compat.js (makeOpenAICompatEngine — one OpenAI-compatible streaming path for openai/nvidia/ollama, diverging only by baseURL + the ollama sentinel; verbatim port of the old streamOpenAI).
Created 5 provider folders, each calling defineProvider at module load with a full self-describing descriptor:
  src/providers/llm/openai/index.js (order 1, baseURL undefined)
  src/providers/llm/anthropic/index.js (order 2, messages.create stream loop, maxTokens=4096 pinned, stripDataUrl base64 image — verbatim port of streamAnthropic)
  src/providers/llm/gemini/index.js (order 3, generateContentStream, inlineData image, assistant→model role remap — verbatim port of streamGemini)
  src/providers/llm/nvidia/index.js (order 4, OpenAI-compat + fixed baseURL https://integrate.api.nvidia.com/v1)
  src/providers/llm/ollama/index.js (order 5, OpenAI-compat + sentinel apiKey:'ollama' + baseURL settings.ollama.baseURL||localhost:11434/v1, ready=!!model)
Created test/providers.test.js (7 tests). Hit a test-design pitfall: _resetProviders() between cases + real (cached) provider modules are incompatible — Node caches the module by path so the top-level defineProvider() never re-runs on re-require, leaving the registry empty after the first case. Fixed by loading the real tree ONCE at module scope (per-file worker isolation protects other suites). 7/7 pass.
R1c — Rewrite createLLM + fold defaults in store.
src/llm.js: deleted the if/else switch + streamOpenAI/streamAnthropic/streamGemini + stripDataUrl (moved to providers). createLLM is now a one-line delegate: getProvider('llm', settings.provider).createEngine({settings}); unknown provider → a not-ready engine (degrades to the "add your key" prompt, never crashes runFeature).
src/store.js: requires registry + loadProviders at module load (pure — providers lazy-require SDKs inside createEngine, logger spawns no transport at require). BASE_DEFAULTS holds the non-LLM skeleton (STT block, deepgram apiKeys seed, toggles); foldLlmDefaults() deep-merges every registered LLM provider's defaultSettings into DEFAULTS. The folded result is byte-identical to the pre-R1c literals — test/providers.test.js asserts the equivalence; test/store-defaults.test.js (10 tests) stays green unchanged.
main.js: loadProviders({ _require: require }) call at startup (idempotent — store already triggers it at require; documents the contract that providers register before any createLLM).
package.json: src/providers/** already covered by src/**/* in the files allowlist (asar:false) — no change needed.
Verification: node smoke (store fold equivalence + llm delegate ready logic) + per-file suites (store-defaults 10/10, providers 7/7, registry 11/11, screen 10/10) + full npm test = 238/238 pass, 0 fail, ~1.75s, no hangs. The slow-logger-suite note (Pino worker transports) did not materialize this run.
Architectural decisions made.

Two registries, one shape (not one merged registry) — preserves LLM/STT decoupling invariant. (Logged ADR-017 after R1b/R1c proved the shape for LLM.)
Folder discovery via fs.readdirSync+require (no new deps) — respects no-native-modules.
Providers keyed ${type}:${id} so openai LLM and openai STT coexist.
Lazy SDK require inside createEngine so store can fold defaultSettings without pulling SDKs.
Render-safe descriptors strip function values before IPC.
Shared OpenAI-compatible helper (openai-compat.js) for openai/nvidia/ollama — one streaming path, diverges by baseURL + sentinel.
defaultSettings auto-fold into store DEFAULTS (foldLlmDefaults) — provider descriptors are the single source for apiKeys/models/ollama; no per-provider DEFAULTS fan-out.
Compromises/notes.

Push-to-talk is explicitly local-only (Electron globalShortcut has no key-release) — documented in plan.
§9: the local/offline STT provider bug is out of scope — ported faithfully, not fixed.
5. Current Working State
Immediate objective. R1b + R1c are complete and verified (238/238 tests pass). The tree is a clean slice ready to commit. Next: R2 (STT provider registry).

Files edited this session (uncommitted, this branch).

src/providers/llm/shared.js            # NEW — lazy child('llm') logger guard + stripDataUrl
src/providers/llm/openai-compat.js    # NEW — shared OpenAI-compatible engine (openai/nvidia/ollama)
src/providers/llm/{openai,anthropic,gemini,nvidia,ollama}/index.js  # NEW — 5 descriptors
test/providers.test.js               # NEW — 7 tests (real-provider load + default-fold equivalence)
src/llm.js                           # rewritten — thin getProvider().createEngine() delegate (switch + streamX deleted)
src/store.js                         # loadProviders at require + foldLlmDefaults into BASE_DEFAULTS
main.js                              # loadProviders() at startup (idempotent)
test/screen.test.js                  # JPEG_QUALITY 0.85 -> 85 (committed-stale-test fix from R1a, now verified 10/10)
.claude/docs + CLAUDE.md + docs/contributing.md  # docs refresh (ADR-017 + stale streamX/DEBUG references)
Remaining steps (immediate).

Commit the R1b+R1c slice — atomic conventional commit, e.g. feat(registry): migrate LLM providers to a folder registry (R1b+R1c). Review the staged diff first (CLAUDE.md git workflow); providers/* + llm.js + store.js + main.js + test/providers.test.js + docs are one logical unit (not independently shippable, so one commit is the precedent).

Then start R2 (see Section 3 + Section 10).

Note on the test suite. npm test this run was ~1.75s with no hangs (the prior "~2 min / may hang if a transport dangles" note did not reproduce). Still: per-file node --test test/<file> for fast iteration; hard-timeout the full run (timeout 150 npm test) as a standby in case a Pino worker transport dangles on another machine.

Next action I would have taken. Commit the R1b+R1c slice, then begin R2: scaffold src/providers/stt/ and port transcribeFasterWhisperLocal (src/stt.js) + LocalFasterWhisperSession (src/stt-engine.js) into a faster-whisper provider folder, declaring capabilities:{streaming,batch,local}, configurableSettings={model,device,computeType,language,vad,threads,beamSize}, and a createStreamSession. Then openai-Whisper / gemini / external-ws providers. createSTT builds the batch chain from listProviders({type:'stt'}). Fold stt-engine.js registerEngine/engineMeta into the provider registry (keep LocalFasterWhisperSession + localLoadParams; update stt:engine:list + test/stt-engine.test.js). Port, don't fix, the local/offline bug (§9).

6. Known Problems
Local/offline transcription provider bug (§9 — DO NOT FIX). Per the task spec, leave the architecture ready; do not spend time on it. Port faithfully in R2.
Cause: unknown/deferred.
Impact: local whisper may not transcribe correctly.
Suggested fix: deferred (dedicated branch).
Pre-existing committed stale test (being fixed). test/screen.test.js expected JPEG_QUALITY === 0.85 but src/screen.js uses 85 (Electron toJPEG 0–100).
Fix: changed test to 85 (done, unverified).
Long full test suite. npm test takes ~2 min (Pino worker transports in test/logger.test.js). Not a bug — a workflow note.
Mitigation: per-file node --test test/<file> iteration; hard-timeout the full run.
Unwired prompt registry. src/prompt-registry.js registrySpec() is built and resolveField is consumed by runFeature/memoryRunner/regenerateResumeSummary, but no IPC channel and no Prompts tab. (Addressed in R5.)
Hardcoded Settings UI. fillSettings/saveSettings/statusText + index.html enumerate every provider/field by id; STT language list (11 langs) and compute list are static <option>s. (Addressed in R3.)
Hardcoded shortcuts. Only assist is configurable; 4 others hardcoded. (Addressed in R4.)
LLM/STT provider switches. if/else in llm.js/stt.js. (Addressed R1/R2.)
7. Architecture Decisions
Two registries, one descriptor shape (LLM, STT). Chosen over a unified single registry (most "future-proof" but merges deliberately-decoupled paths → risk to working LLM/image flow) and over STT-only plugin model. Invariant: LLM and STT stay decoupled ("Anthropic has no audio API; STT builds its own fallback chain").
Folder-based discovery. Adding a provider = one folder calling defineProvider. No switch edits, no Settings UI edits, no DEFAULTS fan-out.
Render-safe descriptors. strip function values before IPC — createEngine/createStreamSession live in main only.
Live transcription popup = both inline strip + separate BrowserWindow (clarifying Q3).
Scope = arch + explicitly-requested UI (not a full build of every standalone feature); but build the missing shortcut actions so every requested shortcut works (clarifying Q1+Q4).
Invariants that must never break: no build step / no native modules; three-input you/them/screen channel separation; IPC three legs (preload allowlist + main handler + renderer consumer, missing any = silent no-op); asar:false files allowlist; tests pure-Node/param-injected (no electron import); DEBUG flags never committed true; atomic conventional commits per feature.
8. Important Context
Coding conventions (from CLAUDE.md / conventions.md).

Plain HTML/CSS/JS — NO bundler, TS, linter, native modules. npm start runs electron . directly.
package.json files allowlist = main.js, preload.js, src/**, renderer/**, python/**. Must add new top-level assets (src/providers/**, src/shortcuts.js, src/registry.js, src/registry-loader.js, src/transcript-window.js, renderer/transcript-popup.*) or they won't ship.
Tests: npm test = node --test over test/. Electron-dependent bits must be param-injected (createSttProcessManager({spawn,spawnSync,fs,getPath}), src/profile-context.js, src/stt-engine.js, src/env.js, src/logger.js defaultGetPath). Tests must not require('electron'). Run one: node --test test/<file>.test.js; filter: node --test --test-name-pattern="…" ..
_resetSttLogger (logger tests), _resetProviders (registry tests reset per-case for throwaway fixtures — already implemented). NOTE: real provider modules + _resetProviders-between-cases are incompatible (Node caches the module by path, so top-level defineProvider() never re-runs on re-require); real-provider tests (test/providers.test.js) load ONCE at module scope — see .claude/docs/memory.md.
Debug logging: const DEBUG = false at top of main.js — flip for traces, don't commit true. (src/llm.js no longer has a DEBUG flag — it's a thin registry delegate; LLM traces flow through the lazy child('llm') Pino logger in src/providers/llm/shared.js, debug-level and silent at the default info level.) CUE_ENV_DEBUG=1 for .env loader.
Model names drift — DEFAULTS models are user-editable defaults, not constraints.
Platform branches scattered — grep process.platform/cue.platform, don't assume.
Global shortcuts owned by main. Cmd/Ctrl+H→leetcode, Cmd/Ctrl+Shift+X→quit, configurable Assist (default Cmd/Ctrl+Return).
Git: atomic conventional commit per feature/chore/docs. Never rewrite/squash existing commits or force-push unless told. Branch feat/registry-refactor.
Existing abstractions to reuse (do not reinvent).

src/prompt-registry.js: PROMPT_REGISTRY, resolveField(id,settings), defaultOverride(id), isOverridden(id,settings), registrySpec(). The pattern for R4/R5/R7 registries.
src/logger.js: child(name) for module-scoped loggers; noopLogger for param-injected defaults; _resetSttLogger for tests; mapPyLevelToPino/parsePyLogLine/logPyStderrLine Python bridge.
src/stt-engine.js: LocalFasterWhisperSession, localLoadParams, registerEngine/engineMeta (to fold into provider registry in R2).
src/stt-models.js: scanCachedModels(modelsDir, fs) — the precedent for dynamic model lists (cache scan before Python starts).
src/store.js: deepMerge, applyEnvOverrides, ENV_OVERRIDES, migrations.
Renderer: keyEventToAccelerator (shortcut capture), getPrePromptChoice/buildPrePromptOverride (preload sync pass-throughs — not IPC).
Configuration today (src/store.js DEFAULTS). provider, smart, resumeContext, resumeSummary, promptOverrides{}, skillDir, skillEnabled, memory{notes}, shortcuts{assist}, apiKeys{openai,anthropic,gemini,deepgram,nvidia,ollama:'ollama'}, models{<p>:{fast,smart}}, ollama{baseURL}, stt{provider:'auto', enabled, engine:'faster-whisper', local{model,device,computeType,language,vad}, fasterWhisperURL, deepgramURL, model, logging{level,logDir,console,file,pretty,rotate}}, onboarded. STT env overrides: CUE_STT_PROVIDER/ENABLED/ENGINE/LOCAL_*/FASTER_WHISPER_URL/DEEPGRAM_URL/LOG_*.

Build/test. npm install (no native modules — clean postinstall). npm start (electron .). npm test. npm run pack (--dir). npm run dist/dist:win. Releasing is tag-driven (v* → GitHub release workflow). No CI test gate — run npm test locally.

9. Relevant Files
C:\Users\karee\.claude\plans\curried-toasting-badger.md — the approved 8-phase plan (read this first).
src/registry.js — NEW — provider registry spine. defineProvider/listProviders/getProvider/renderSafe/resolveSupportedModels.
src/registry-loader.js — NEW — loadProviders folder discovery.
test/registry.test.js — NEW — 11 tests.
src/llm.js — the LLM if/else switch (R1c rewrites createLLM). Has streamOpenAI/streamAnthropic/streamGemini, stripDataUrl, child('llm') lazy logging.
src/stt.js — hardcoded batch chain (R2 rewrites). transcribeFasterWhisperLocal, transcribeOpenAI, transcribeGemini.
src/stt-engine.js — LocalFasterWhisperSession, localLoadParams, registerEngine/engineMeta (fold into R2).
src/stt-stream.js — createStreamSTT, resolveProvider (pure), WS framing.
src/stt-process.js — createSttProcessManager (Python lifecycle, param-injected).
src/store.js — DEFAULTS + deepMerge + env + migrations.
src/prompt-registry.js — the self-describing prompt registry (R5 wires its UI).
src/logger.js — Pino singleton (R7 adds per-module + UI).
main.js — window, RESERVED_SHORTCUTS, registerAssistShortcut/registerShortcuts, runFeature, IPC handlers (settings:get/set, shortcut:assist:set, stt:*), getSttManager().
preload.js — IPC allowlist (on allowed list: capture:state, llm:start/token/done/error, status, transcript, transcript:partial, stt:status, stt:progress).
renderer/renderer.js — fillSettings/saveSettings/statusText, keyEventToAccelerator/applyAssistShortcut, transcript strip, STT diagnostics.
renderer/index.html — settings tabs (Providers/Transcription/Models/Context/Shortcuts) — no Prompts tab.
.claude/docs/ — operational docs (architecture.md, conventions.md, providers.md, decisions.md, state.md, implementation-plan.md, memory.md). R8 updates these.
10. Suggested Continuation Plan
Order: R1b → R1c → R2 → R3 → R4 → R5 → R6 → R7 → R8 (dependency-ordered). Run npm test green after each phase; manual UI check (user's machine) for R3/R5/R6/R7.

Immediate Next Task
Verify the green baseline, then start R1b.

Run node --test test/screen.test.js to confirm the JPEG_QUALITY fix (expect pass), then timeout 150 npm test to confirm the full suite is green (expect ~232 tests — 231 prior + R1a's 11 new registry tests, minus the formerly-failing screen test now passing).
Mark R1a complete in the todo list (TodoWrite).
Start R1b: create src/providers/llm/openai/index.js by porting streamOpenAI (src/llm.js:27-57) into a createEngine(ctx) that returns {provider, model, apiKey, ready, stream(params)}. Declare:

providerType: 'llm', id: 'openai', displayName: 'OpenAI', order: 1,
capabilities: { streaming: true, vision: true },
configurableSettings: [
  { id: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...' },
  { id: 'fast', label: 'Fast model', type: 'text' },
  { id: 'smart', label: 'Smart model', type: 'text' },
],
defaultSettings: { apiKeys: { openai: '' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } },
supportedModels: [{id:'gpt-4o-mini',label:'GPT-4o mini'},{id:'gpt-4o',label:'GPT-4o'}],
createEngine({settings}) { /* lazy require('openai'); build client; stream */ }
Then anthropic (streamAnthropic, order 2, maxTokens=4096 pinned), gemini (streamGemini, order 3, inlineData), nvidia (OpenAI-clone + baseURL, order 4), ollama (OpenAI-clone + sentinel key + baseURL, ready = !!model, order 5). Keep normalizeSDKError re-throws, stripDataUrl, and the child('llm') lazy logging guard in each. Add a shared OpenAI-compatible helper to avoid duplicating streamOpenAI for openai/nvidia/ollama. Then R1c rewrites src/llm.js createLLM to getProvider('llm', settings.provider).createEngine({settings}) and folds defaultSettings into src/store.js DEFAULTS, keeping test/store-defaults.test.js green. Add loadProviders() call in main.js startup (before any createLLM). Add src/providers/** to package.json files.