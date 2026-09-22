import 'dotenv/config';
import path from 'node:path';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

import { DEFAULT_ESCALATION_MODEL, isEffort, resolveTaskModels, type Effort } from '../shared/agent/core.js';

export type { Effort };

const effortFromEnv = (value: string | undefined): Effort => (isEffort(value) ? value : 'high');
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const escalationFromEnv = env('ANTHROPIC_ESCALATION_MODEL');

export const config = {
  port: num(process.env.PORT, 3001),
  /** Model per task. ANTHROPIC_MODEL applies to every task unless a per-task variable overrides it. */
  models: resolveTaskModels(
    {
      guide: env('ANTHROPIC_MODEL_GUIDE'),
      chat: env('ANTHROPIC_MODEL_CHAT'),
      quiz: env('ANTHROPIC_MODEL_QUIZ'),
      grading: env('ANTHROPIC_MODEL_GRADING'),
      review: env('ANTHROPIC_MODEL_REVIEW'),
    },
    env('ANTHROPIC_MODEL'),
  ),
  /** Tried when a task's model declines or returns nothing, and used for maximum-quality guides. "off" disables it. */
  escalationModel: escalationFromEnv?.toLowerCase() === 'off' ? undefined : (escalationFromEnv ?? DEFAULT_ESCALATION_MODEL),
  /** Thinking/effort level used for the study guide, chat, quiz and review calls. */
  effort: effortFromEnv(process.env.ANTHROPIC_EFFORT?.trim()),
  dataDir: path.resolve(process.env.DATA_DIR?.trim() || './data'),
  maxUploadMb: num(process.env.MAX_UPLOAD_MB, 100),
  sofficePath: process.env.SOFFICE_PATH?.trim() ?? '',
  /** Upload PDFs/images once through the Files API instead of inlining them on every request. */
  useFilesApi: (process.env.ANTHROPIC_FILES_API?.trim().toLowerCase() ?? 'on') !== 'off',
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  isProd: process.env.NODE_ENV === 'production',
};
