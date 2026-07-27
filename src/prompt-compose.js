const DEBUG = false;
// The single system-prompt composition seam. Four features (pre-prompt, skills, memory,
// résumé-efficiency) all edit this one point, so they don't collide: composeSystem concatenates
// them in a fixed order and returns the full system string.
//
// Order (the contract — ADR-009, the plan):
//   1. PRE-PROMPT   — user instructions framing "who you are to me". FIRST, before the mode system.
//   2. MODE SYSTEM  — def.system, as today.
//   3. SKILLS       — .claude/skills/*.md applied as INSTRUCTIONS ("behavioral guidance"). The
//      opposite framing from résumé. Must never appear inside the résumé fence — it can't, because
//      it is a top-level section joined before the résumé, never nested in it.
//   4. MEMORY       — rolling summary (≤2000 chars) + user notes (≤4000 chars) as CONTEXT.
//   5. RÉSUMÉ       — only when def.wantsResume === true; two tiers (full vs career digest). Framed
//      as UNTRUSTED DATA. Always LAST, so no other section can be mistaken for it.
//
// Sections are joined with a blank line. Empty sections are dropped entirely (no stray labels).
// Pure-Node + electron-free: skills load via the cached src/skills.js reader (pure fs), the résumé
// via composeResumeSection (pure). The runner-backed memoryState is read through getSummary() OR a
// plain .summary, so tests pass a literal string and main.js passes the runner.

const { loadSkillDir } = require('./skills');
const { composeResumeSection } = require('./profile-context');

const MAX_NOTES_CHARS = 4000;
const MAX_MEMORY_SUMMARY_CHARS = 2000; // bound of the rolling summary (matches MEMORY_SUMMARY_PROMPT)

// Built-in pre-prompt templates. The settings UI offers these as a selector plus a Custom text;
// the resolution rule in resolvePrePrompt picks the effective pre-prompt.
const DEFAULT_PRE_PROMPT_TEMPLATE = 'concise';
const PRE_PROMPT_TEMPLATES = {
  concise: 'You are my discreet copilot. Be terse and direct: no preamble, no hedging.',
  interview: 'You are my interview coach. Anticipate tough questions and help me answer them calmly and concretely.',
  engineer: 'You are a senior engineer pairing with me. Call out bad ideas; optimize for correctness and clarity over cleverness.',
  copilot: 'You are a friendly meeting copilot. Help me follow the discussion and chime in helpfully and on time.',
};

// Effective pre-prompt = the user's custom text if set, else the text of the selected template
// (defaulting to "concise" when the template id is unset or unknown — a forward-compat fallback).
function resolvePrePrompt(settings) {
  const s = settings || {};
  const custom = typeof s.prePrompt === 'string' ? s.prePrompt.trim() : '';
  if (custom) return custom;
  const id = PRE_PROMPT_TEMPLATES[s.prePromptTemplate] ? s.prePromptTemplate : DEFAULT_PRE_PROMPT_TEMPLATE;
  return PRE_PROMPT_TEMPLATES[id];
}

// Skills injected as INSTRUCTIONS. Opt-out gate (settings.skillEnabled === false); an empty or
// missing skillDir yields no skills, so this is naturally a no-op until the user points cue at a
// project. Framing is behavioral guidance, deliberately distinct from résumé's untrusted-data
// framing — and a top-level section, so it can never land inside the résumé fence.
function skillsSection(settings) {
  const s = settings || {};
  if (s.skillEnabled === false) return '';
  const skills = loadSkillDir(s.skillDir || '');
  if (!skills.length) return '';
  const body = skills.map((sk) => {
    const head = `### ${sk.name}`;
    const desc = sk.description ? `${sk.description}\n` : '';
    return `${head}\n${desc}${sk.body}`;
  }).join('\n\n');
  return '## Skills — apply these as behavioral guidance when relevant\n\n' + body;
}

// memoryState may be the memory runner (getSummary()) or a plain {summary}. Notes live in settings
// (user-edited) — separate from the persisted rolling summary in cue-memory.json.
function readSummary(memoryState) {
  if (!memoryState) return '';
  if (typeof memoryState.getSummary === 'function') return memoryState.getSummary();
  return typeof memoryState.summary === 'string' ? memoryState.summary : '';
}

function memorySection(settings, memoryState) {
  const s = settings || {};
  const summary = readSummary(memoryState).slice(0, MAX_MEMORY_SUMMARY_CHARS).trim();
  const notes = (s.memory && typeof s.memory.notes === 'string' ? s.memory.notes : '').slice(0, MAX_NOTES_CHARS).trim();
  if (!summary && !notes) return '';
  const parts = [];
  if (summary) parts.push('Rolling summary of the conversation so far:\n' + summary);
  if (notes) parts.push('User notes (things the user wants remembered):\n' + notes);
  return '## Conversation memory (apply as context)\n\n' + parts.join('\n\n');
}

// The résumé section is delegated to composeResumeSection, which already gates on wantsResume and
// picks the tier (full vs digest) as untrusted data. Always emitted LAST below.
function resumeSection(def, settings) {
  return composeResumeSection(def, settings);
}

// composeSystem({ def, settings, memoryState }) → the full system prompt string.
function composeSystem({ def, settings, memoryState } = {}) {
  if (!def) return '';
  const sections = [];

  // 1. pre-prompt first — frames "who you are to me" before the mode describes what to do
  const pre = resolvePrePrompt(settings);
  if (pre) sections.push(pre);

  // 2. the mode system prompt, as today
  if (def.system) sections.push(def.system);

  // 3. skills (instructions framing)
  const skills = skillsSection(settings);
  if (skills) sections.push(skills);

  // 4. memory (context framing)
  const memory = memorySection(settings, memoryState);
  if (memory) sections.push(memory);

  // 5. résumé (untrusted-data framing) — only when the mode opted in; always last
  const resume = resumeSection(def, settings);
  if (resume) sections.push(resume);

  if (DEBUG) console.log('[compose] sections:', sections.length, 'len:', sections.join('\n\n').length);
  return sections.join('\n\n');
}

module.exports = {
  composeSystem,
  resolvePrePrompt,
  skillsSection,
  memorySection,
  resumeSection,
  readSummary,
  PRE_PROMPT_TEMPLATES,
  DEFAULT_PRE_PROMPT_TEMPLATE,
  MAX_NOTES_CHARS,
  MAX_MEMORY_SUMMARY_CHARS,
};
