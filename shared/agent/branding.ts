/**
 * White-label support. A deployment can hide which providers and models power
 * the agent (config.json "showModels": false, or SHOW_MODELS=false on the
 * server): the UI then names only the persona, and system text that may carry
 * provider or model names from upstream errors goes through scrubModelNames.
 */

export const NEUTRAL_MODEL = 'the model';
export const NEUTRAL_SERVICE = 'the model service';

/** "openrouter/qwen/qwen3.8-27b:free", "gemini/gemini-3.8-flash", "artifact/complex" … */
const MODEL_REF = /\b(?:the\s+)?(?:anthropic|claude|gemini|google|openrouter|zai|z\.ai|zhipu|cf|workers-ai|cloudflare|artifact)\/[\w@.:/-]*[\w-]/gi;
const CF_MODEL = /@cf\/[\w./-]*[\w-]/gi;
/** Provider and service names (before bare model names so that "claude.ai" is treated as a service). */
const PROVIDER =
  /\b(?:the\s+)?(?:anthropic|google gemini|google ai studio|openrouter|z\.ai|zhipu|cloudflare workers ai|workers ai|cloudflare|claude\.ai|api\.anthropic\.com|generativelanguage\.googleapis\.com)\b/gi;
/** "claude-opus-5", "Gemini", "gemini-3.8-flash", "qwen3.8-27b:free", "GLM-4.7-Flash" … */
const BARE_MODEL = /\b(?:the\s+)?(?:claude|gemini|gemma|qwen|glm|llama|mistral|mixtral|deepseek|nex)[\w-]*(?:\.[\w-]+)*(?::free)?/gi;

/** Rewrites provider and model names in a system message so a white-label page never shows them. */
export function scrubModelNames(text: string): string {
  return text
    .replace(MODEL_REF, NEUTRAL_MODEL)
    .replace(CF_MODEL, NEUTRAL_MODEL)
    .replace(PROVIDER, NEUTRAL_SERVICE)
    .replace(BARE_MODEL, NEUTRAL_MODEL)
    .replace(/the model \((?:the model|the model service)\)/g, NEUTRAL_MODEL)
    .replace(/the model service \(the model\)/g, NEUTRAL_SERVICE)
    .replace(/\b(the model(?: service)?)(?:[,;·]?\s+\1\b)+/g, '$1')
    .replace(/^the model/, 'The model');
}
