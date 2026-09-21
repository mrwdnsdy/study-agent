import 'dotenv/config';
import path from 'node:path';

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

const effortFromEnv = (value: string | undefined): Effort =>
  (EFFORTS as readonly string[]).includes(value ?? '') ? (value as Effort) : 'high';

export const config = {
  port: num(process.env.PORT, 3001),
  model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-opus-5',
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
