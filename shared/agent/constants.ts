import type { AgentTask, TaskModels } from '../types.js';

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

/** Fallback when nothing else is configured. */
export const DEFAULT_MODEL = 'claude-opus-5';
/** Per-task defaults: the flagship study guide on Opus 5, the lighter tasks on Sonnet 5. */
export const DEFAULT_TASK_MODELS: TaskModels = {
  guide: 'claude-opus-5',
  chat: 'claude-sonnet-5',
  quiz: 'claude-sonnet-5',
  grading: 'claude-sonnet-5',
  review: 'claude-sonnet-5',
};
/** Used for maximum-quality guides and whenever a task's model declines or returns nothing. About twice the price of Opus. */
export const DEFAULT_ESCALATION_MODEL = 'claude-fable-5-1';
export const MODEL_SUGGESTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5'] as const;

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

/** Fills a per-task model map: explicit task entries win, then `fallback` for every task, then the built-in defaults. */
export function resolveTaskModels(overrides: Partial<Record<AgentTask, string | undefined>> = {}, fallback?: string): TaskModels {
  const models: TaskModels = { ...DEFAULT_TASK_MODELS };
  for (const task of AGENT_TASKS) {
    const value = overrides[task]?.trim() || fallback?.trim();
    if (value) models[task] = value;
  }
  return models;
}
