import type { AgentTask, ProviderId, TaskModels } from '../types.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const AGENT_TASKS: readonly AgentTask[] = ['guide', 'chat', 'quiz', 'grading', 'review'];
export const TASK_LABELS: Record<AgentTask, string> = {
  guide: 'Study guide',
  chat: 'Chat',
  quiz: 'Quiz creation',
  grading: 'Answer grading',
  review: 'Quiz review',
};

/** The study agent's persona name (shown in the UI and used in the prompts). */
export const DEFAULT_AGENT_NAME = 'Kiiku';

/** Fallback when nothing else is configured. */
export const DEFAULT_MODEL = 'claude-opus-5';
/** Per-task defaults for a Claude deployment: the flagship study guide on Opus 5, the lighter tasks on Sonnet 5. */
export const DEFAULT_TASK_MODELS: TaskModels = {
  guide: ['claude-opus-5'],
  chat: ['claude-sonnet-5'],
  quiz: ['claude-sonnet-5'],
  grading: ['claude-sonnet-5'],
  review: ['claude-sonnet-5'],
};
/** Used for maximum-quality guides and whenever a task's model declines or returns nothing. About twice the price of Opus. */
export const DEFAULT_ESCALATION_MODEL = 'claude-fable-5-1';
/**
 * The zero-cost chain: Gemini's free tier first (native PDF, 64k output, JSON schema),
 * then free open-weight models that need the PDF as text.
 */
export const FREE_CHAIN: readonly string[] = [
  'gemini/gemini-3.8-flash',
  'gemini/gemini-3.5-flash-lite',
  'openrouter/qwen/qwen3.8-27b:free',
  'openrouter/nex-agi/nex-n2.5-pro:free',
  'zai/glm-4.6v-flash',
  'cf/@cf/google/gemma-4-26b-a4b-it',
];
export const MODEL_SUGGESTIONS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-haiku-4-5',
  'gemini/gemini-3.8-flash',
  'gemini/gemini-3.5-flash-lite',
  'openrouter/qwen/qwen3.8-27b:free',
  'zai/glm-4.7-flash',
  'cf/@cf/google/gemma-4-26b-a4b-it',
] as const;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  zai: 'Z.ai',
  'workers-ai': 'Cloudflare Workers AI',
  artifact: 'Claude (your claude.ai account)',
};

/** Model tiers the artifact runtime offers; referenced as "artifact/<tier>". */
export const ARTIFACT_TIERS = ['default', 'complex', 'quick'] as const;
export type ArtifactTier = (typeof ARTIFACT_TIERS)[number];
/** Per-task defaults when Claude is reached through the artifact runtime: the guide on the most capable tier, grading on the fastest. */
export const ARTIFACT_TASK_MODELS: TaskModels = {
  guide: ['artifact/complex'],
  chat: ['artifact/default'],
  quiz: ['artifact/default'],
  grading: ['artifact/quick'],
  review: ['artifact/default'],
};

export function isArtifactTier(value: string): value is ArtifactTier {
  return (ARTIFACT_TIERS as readonly string[]).includes(value);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

export interface ModelRef {
  provider: ProviderId;
  /** Provider-specific model id. */
  model: string;
  /** The reference as written in the configuration. */
  ref: string;
}

/**
 * "claude-opus-5" and "anthropic/claude-opus-5" → Anthropic; "gemini/gemini-3.8-flash" or a bare
 * "gemini-…" id → Google; "openrouter/<vendor>/<model>" → OpenRouter; "zai/<model>" → Z.ai;
 * "cf/@cf/<vendor>/<model>" or a bare "@cf/…" id → Cloudflare Workers AI; "artifact/<tier>" → Claude through
 * the claude.ai artifact runtime (tiers: default, complex, quick).
 */
export function parseModelRef(ref: string): ModelRef {
  const value = ref.trim();
  const slash = value.indexOf('/');
  const head = slash === -1 ? '' : value.slice(0, slash).toLowerCase();
  const rest = slash === -1 ? value : value.slice(slash + 1);
  if (head === 'anthropic' || head === 'claude') return { provider: 'anthropic', model: rest, ref: value };
  if (head === 'gemini' || head === 'google') return { provider: 'gemini', model: rest, ref: value };
  if (head === 'openrouter') return { provider: 'openrouter', model: rest, ref: value };
  if (head === 'zai' || head === 'z.ai' || head === 'zhipu') return { provider: 'zai', model: rest, ref: value };
  if (head === 'cf' || head === 'workers-ai' || head === 'cloudflare') return { provider: 'workers-ai', model: rest, ref: value };
  if (head === 'artifact') return { provider: 'artifact', model: rest.toLowerCase() || 'default', ref: value };
  if (value.startsWith('@cf/')) return { provider: 'workers-ai', model: value, ref: value };
  if (/^gemini-/i.test(value)) return { provider: 'gemini', model: value, ref: value };
  return { provider: 'anthropic', model: value, ref: value };
}

/** Short human-readable name for a model reference: "gemini-3.8-flash", "qwen/qwen3.8-27b:free (OpenRouter)". */
export function displayModel(ref: string | string[] | undefined): string {
  if (!ref) return '';
  const first = Array.isArray(ref) ? ref[0] : ref;
  if (!first) return '';
  const parsed = parseModelRef(first);
  if (parsed.provider === 'anthropic' || parsed.provider === 'gemini') return parsed.model;
  if (parsed.provider === 'artifact') return `Claude (${parsed.model} tier)`;
  return `${parsed.model} (${PROVIDER_LABELS[parsed.provider]})`;
}

/** Every provider a chain touches. */
export function providersOf(models: TaskModels, extra: (string | undefined)[] = []): ProviderId[] {
  const set = new Set<ProviderId>();
  for (const chain of Object.values(models)) for (const ref of chain) set.add(parseModelRef(ref).provider);
  for (const ref of extra) if (ref) set.add(parseModelRef(ref).provider);
  return [...set];
}

function toChain(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(',');
  return list.map((v) => v.trim()).filter(Boolean);
}

/** Fills a per-task model map: explicit task entries win, then `fallback` for every task, then the built-in defaults. */
export function resolveTaskModels(
  overrides: Partial<Record<AgentTask, string | string[] | undefined>> = {},
  fallback?: string | string[],
): TaskModels {
  const models: TaskModels = { ...DEFAULT_TASK_MODELS };
  const shared = toChain(fallback);
  for (const task of AGENT_TASKS) {
    const own = toChain(overrides[task]);
    if (own.length) models[task] = own;
    else if (shared.length) models[task] = shared;
  }
  return models;
}
