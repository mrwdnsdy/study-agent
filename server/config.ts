import 'dotenv/config';
import path from 'node:path';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

import { DEFAULT_AGENT_NAME, DEFAULT_ESCALATION_MODEL, FREE_CHAIN, isEffort, parseModelRef, resolveTaskModels, type Effort } from '../shared/agent/core.js';
import type { ProviderId, TaskModels } from '../shared/types.js';

export type { Effort };

const effortFromEnv = (value: string | undefined): Effort => (isEffort(value) ? value : 'high');
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const escalationFromEnv = env('ANTHROPIC_ESCALATION_MODEL');

/** `MODEL_LANE=free` selects the zero-cost chain (Gemini first) unless per-task variables say otherwise. */
const laneFallback = env('MODEL_LANE')?.toLowerCase() === 'free' ? [...FREE_CHAIN] : undefined;
const models: TaskModels = resolveTaskModels(
  {
    guide: env('ANTHROPIC_MODEL_GUIDE') ?? env('MODEL_GUIDE'),
    chat: env('ANTHROPIC_MODEL_CHAT') ?? env('MODEL_CHAT'),
    quiz: env('ANTHROPIC_MODEL_QUIZ') ?? env('MODEL_QUIZ'),
    grading: env('ANTHROPIC_MODEL_GRADING') ?? env('MODEL_GRADING'),
    review: env('ANTHROPIC_MODEL_REVIEW') ?? env('MODEL_REVIEW'),
  },
  env('ANTHROPIC_MODEL') ?? env('MODEL') ?? laneFallback,
);
const everyModelIsClaude = Object.values(models)
  .flat()
  .every((ref) => parseModelRef(ref).provider === 'anthropic');
const providerKeys: Record<ProviderId, boolean> = {
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  gemini: Boolean(env('GEMINI_API_KEY')),
  openrouter: Boolean(env('OPENROUTER_API_KEY')),
  zai: Boolean(env('ZAI_API_KEY')),
  'workers-ai': Boolean(env('WORKERS_AI_TOKEN') && env('CLOUDFLARE_ACCOUNT_ID')),
};

export const config = {
  port: num(process.env.PORT, 3001),
  /** Persona name of the study agent. */
  agentName: env('AGENT_NAME') ?? DEFAULT_AGENT_NAME,
  /**
   * Model chain per task (comma-separated references, e.g. "gemini/gemini-3.8-flash,openrouter/qwen/qwen3.8-27b:free").
   * ANTHROPIC_MODEL / MODEL applies to every task unless a per-task variable overrides it; MODEL_LANE=free selects the free chain.
   */
  models,
  /** Tried when a task's model declines or returns nothing, and used for maximum-quality guides. "off" disables it. */
  escalationModel:
    escalationFromEnv?.toLowerCase() === 'off' ? undefined : (escalationFromEnv ?? (everyModelIsClaude ? DEFAULT_ESCALATION_MODEL : undefined)),
  /** Which providers have credentials in the environment. */
  providerKeys,
  /** Provider credentials and endpoints. */
  geminiApiKey: env('GEMINI_API_KEY'),
  openrouterApiKey: env('OPENROUTER_API_KEY'),
  zaiApiKey: env('ZAI_API_KEY'),
  workersAiToken: env('WORKERS_AI_TOKEN'),
  cloudflareAccountId: env('CLOUDFLARE_ACCOUNT_ID'),
  appUrl: env('APP_URL') ?? 'https://github.com/mrwdnsdy/study-agent',
  /** Thinking/effort level used for the study guide, chat, quiz and review calls. */
  effort: effortFromEnv(process.env.ANTHROPIC_EFFORT?.trim()),
  dataDir: path.resolve(process.env.DATA_DIR?.trim() || './data'),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 100),
  sofficePath: process.env.SOFFICE_PATH?.trim() ?? '',
  /** Upload PDFs/images once through the Files API instead of inlining them on every request. */
  useFilesApi: (process.env.ANTHROPIC_FILES_API?.trim().toLowerCase() ?? 'on') !== 'off',
  /** True when at least one provider used by the model chains has a credential. */
  hasApiKey: Object.values(providerKeys).some(Boolean),
  isProd: process.env.NODE_ENV === 'production',
};
