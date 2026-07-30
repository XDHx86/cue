// Settings-shaped helpers for the Assistant-style (pre-prompt) control.
//
// The renderer's preprompt-seg + custom textarea must reflect the *same* value composeSystem
// ends up sending. composeSystem → resolvePrePrompt → resolveField('prePrompt', settings)
// [src/prompt-registry.js]; the override lives at settings.promptOverrides.prePrompt and the
// resolution rule is:
//   non-empty `text` wins (custom text, or a hand-edited built-in) → behaves as "Custom";
//   otherwise the selected builtin option's template text → that builtin is the lit seg;
//   an unknown/missing option → the default template.
//
// These two functions mirror that precedence *for the UI*: getPrePromptChoice says which seg is
// lit + what text to show; buildPrePromptOverride writes the live-home override shape back.
// Electron-free (requires only prompt-registry → prompts, both pure), so it's unit-tested in
// test/preprompt.test.js and exposed to the renderer synchronously via preload's contextBridge.

const { PRE_PROMPT_TEMPLATES, DEFAULT_PRE_PROMPT_TEMPLATE } = require('./prompt-registry');

const BUILTINS = Object.keys(PRE_PROMPT_TEMPLATES); // ['concise','interview','engineer','copilot']
const isBuiltin = (id) => BUILTINS.includes(id);

// settings.promptOverrides.prePrompt → { option, text }.
//   option: 'custom' | one of BUILTINS (falls back to DEFAULT_PRE_PROMPT_TEMPLATE)
//   text:   the custom/hand-edited text to show in the textarea (empty for a plain builtin)
// Matches resolveField('prePrompt'): non-empty text ⇒ 'custom' lit; else the builtin / default.
function getPrePromptChoice(settings) {
  const ov = (settings && settings.promptOverrides && settings.promptOverrides.prePrompt) || null;
  const o = (ov && typeof ov === 'object' && !Array.isArray(ov)) ? ov : {};
  const text = (typeof o.text === 'string' ? o.text : '').trim();
  if (text) return { option: 'custom', text };
  const option = typeof o.option === 'string' && isBuiltin(o.option) ? o.option : DEFAULT_PRE_PROMPT_TEMPLATE;
  return { option, text: '' };
}

// Renderer seg selection → the live-home override shape written to settings.promptOverrides.prePrompt.
// 'custom' carries the textarea text; a builtin carries empty text so the registry default applies.
function buildPrePromptOverride({ option, customText } = {}) {
  if (option === 'custom') return { option: 'custom', text: (customText || '').trim() };
  const opt = typeof option === 'string' && isBuiltin(option) ? option : DEFAULT_PRE_PROMPT_TEMPLATE;
  return { option: opt, text: '' };
}

module.exports = { getPrePromptChoice, buildPrePromptOverride, BUILTINS };
