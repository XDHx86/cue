// The single registration place for user-configurable prompt templates & prompts.
//
// Before this module, every built-in prompt/template was a hardcoded constant the user could
// never see or change (e.g. PRE_PROMPT_TEMPLATES, MODES.*.system, MEMORY_SUMMARY_PROMPT). Now each
// configurable prompt is declared ONCE here; the Settings UI (renderer) fetches `registrySpec()`
// over IPC and GENERATES its controls from that, and resolution at compose time reads the user's
// override from settings.promptOverrides[id] (the delta) or this registry's default (the single
// physical home — the entries REFERENCE the existing prompt constants in src/prompts.js, they do
// not copy them).
//
// Adding a new configurable prompt = add ONE entry to PROMPT_REGISTRY. No renderer UI edits, no
// fill/save fan-out: the generic renderer + resolver handle it.
//
// Safety boundary (ADR-014): only pure-text prompts/templates are exposed here. Structural or
// safety-critical framing is deliberately NOT registered — `frameResumeSection` untrusted-data
// disclaimers/fences, the skills & memory section headers, and the `You:`/`Them:` channel labels
// stay hardcoded so a user cannot strip prompt-injection defenses or the channel invariant.

const { MODES, MEMORY_SUMMARY_PROMPT, RESUME_SUMMARY_PROMPT } = require('./prompts');

// --- pre-prompt templates (moved here from prompt-compose.js; this is now their home) ---
// Built-in assistant styles. The Settings UI offers these as a selector plus a Custom box; the
// resolution rule in resolveField (custom text wins; edited built-in text wins; else the selected
// template; else the default) reproduces the old resolvePrePrompt behavior exactly.
const DEFAULT_PRE_PROMPT_TEMPLATE = 'concise';
const PRE_PROMPT_TEMPLATES = {
  concise: 'You are my discreet copilot. Be terse and direct: no preamble, no hedging.',
  interview: 'You are my interview coach. Anticipate tough questions and help me answer them calmly and concretely.',
  engineer: 'You are a senior engineer pairing with me. Call out bad ideas; optimize for correctness and clarity over cleverness.',
  copilot: 'You are a friendly meeting copilot. Help me follow the discussion and chime in helpfully and on time.',
};

// Each entry:
//   { id, label, hint, tab, kind, order, ...kind-specific }
//     id            — override key under settings.promptOverrides
//     tab           — Settings tab the renderer places the control into ('assistant' | 'prompts')
//     kind 'select' — { options:{ id:{label,text} }, defaultOption, allowCustom }
//       override shape in settings: { option:<id|'custom'>, text:<string> } (always both keys)
//       'custom' is a synthetic option present only when allowCustom; its text is free-form.
//     kind 'text'   — { default:<string> }
//       override shape in settings: a string ('' = use the default)
// `order` only orders fields within a tab.
const MODE_PROMPTS = [
  ['assist', 'Assist'],
  ['say', '"What should I say?"'],
  ['followup', 'Follow-up questions'],
  ['recap', 'Recap'],
  ['ask', 'Ask (free-form)'],
  ['leetcode', 'LeetCode solver'],
];

const PROMPT_REGISTRY = [
  {
    id: 'prePrompt',
    label: 'Assistant style',
    hint: 'how cue frames its help; sent first in every system prompt',
    tab: 'assistant',
    kind: 'select',
    order: 1,
    options: Object.fromEntries(
      Object.entries(PRE_PROMPT_TEMPLATES).map(([k, v]) => [
        k, { label: k.charAt(0).toUpperCase() + k.slice(1), text: v },
      ])
    ),
    defaultOption: DEFAULT_PRE_PROMPT_TEMPLATE,
    allowCustom: true,
  },
  // The six per-mode system prompts. The default REFERENCES MODES.<mode>.system (one physical home);
  // the override is what the user edits in Settings. composeSystem receives an effective def whose
  // .system is resolveField('mode.<id>', settings) (see main.js runFeature).
  ...MODE_PROMPTS.map(([m, label], i) => ({
    id: 'mode.' + m,
    label,
    hint: 'system prompt sent for this mode',
    tab: 'prompts',
    kind: 'text',
    order: i + 1,
    default: MODES[m].system,
  })),
  {
    id: 'memorySummaryPrompt',
    label: 'Memory summary prompt',
    hint: 'compacts the rolling conversation summary (background)',
    tab: 'prompts',
    kind: 'text',
    order: 100,
    default: MEMORY_SUMMARY_PROMPT,
  },
  {
    id: 'resumeSummaryPrompt',
    label: 'Résumé digest prompt',
    hint: 'condenses your résumé into the short career digest',
    tab: 'prompts',
    kind: 'text',
    order: 101,
    default: RESUME_SUMMARY_PROMPT,
  },
];

const byId = new Map(PROMPT_REGISTRY.map((f) => [f.id, f]));

// Effective value for a registered field: the override (settings.promptOverrides[id]) wins, else the
// registry default. Override is a DELTA — absent or empty-sentinel means "use the default".
//
// 'select' resolution (matches the legacy resolvePrePrompt precedence):
//   - non-empty `text` wins — either a Custom text or a hand-edited built-in template
//   - otherwise the selected option's default text
//   - an unknown/missing option falls back to defaultOption
// 'text' resolution:
//   - non-empty override string wins, else field.default
function resolveField(id, settings) {
  const field = byId.get(id);
  if (!field) return '';
  const ov = (settings && settings.promptOverrides && settings.promptOverrides[id]) || null;
  if (field.kind === 'select') {
    const o = (ov && typeof ov === 'object' && !Array.isArray(ov)) ? ov : {};
    const text = (typeof o.text === 'string' ? o.text : '').trim();
    if (text) return text;
    const opt = (o.option && field.options[o.option]) ? o.option : field.defaultOption;
    return (field.options[opt] && field.options[opt].text) || '';
  }
  const t = typeof ov === 'string' ? ov.trim() : '';
  return t || field.default || '';
}

// The override value meaning "restored to default" — what the renderer writes to
// settings.promptOverrides[id] on Restore-default. Empty-sentinel model (deepMerge never deletes,
// so we never rely on key deletion): '' for 'text', { option: defaultOption, text: '' } for 'select'.
// After this is written, resolveField returns the registry default exactly.
function defaultOverride(id) {
  const field = byId.get(id);
  if (!field) return '';
  if (field.kind === 'select') return { option: field.defaultOption, text: '' };
  return '';
}

// Whether the field currently has a non-default override. Used by the renderer to show a
// "modified / Restore" affordance without needing to diff against the default text.
function isOverridden(id, settings) {
  const field = byId.get(id);
  if (!field) return false;
  const ov = (settings && settings.promptOverrides && settings.promptOverrides[id]) || null;
  if (!ov) return false;
  if (field.kind === 'select') {
    if (!ov || typeof ov !== 'object') return false;
    const text = (typeof ov.text === 'string' ? ov.text : '').trim();
    const option = typeof ov.option === 'string' ? ov.option : '';
    const onCustom = option === 'custom';
    const editedBuiltin = !!option && field.options[option] && text && text !== field.options[option].text;
    return onCustom ? !!text : editedBuiltin;
  }
  return typeof ov === 'string' && ov.trim().length > 0;
}

// Serializable, renderer-safe spec (the default texts are included so the UI can show the
// template/prompt text when an override is empty). Sent over the 'prompts:registry' IPC channel.
function registrySpec() {
  return PROMPT_REGISTRY.map((f) => {
    if (f.kind === 'select') {
      return {
        id: f.id, label: f.label, hint: f.hint, tab: f.tab, kind: f.kind, order: f.order,
        options: f.options, defaultOption: f.defaultOption, allowCustom: !!f.allowCustom,
      };
    }
    return { id: f.id, label: f.label, hint: f.hint, tab: f.tab, kind: f.kind, order: f.order, default: f.default };
  });
}

module.exports = {
  PROMPT_REGISTRY,
  PRE_PROMPT_TEMPLATES,
  DEFAULT_PRE_PROMPT_TEMPLATE,
  resolveField,
  defaultOverride,
  isOverridden,
  registrySpec,
};
