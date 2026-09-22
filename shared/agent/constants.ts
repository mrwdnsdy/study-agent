/** Small constants shared by the server, the browser UI and the agent core (no heavy imports). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_MODEL = 'claude-opus-5';
export const MODEL_SUGGESTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}
