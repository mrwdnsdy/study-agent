/**
 * Provider-neutral interface the agent core talks to. Requests are expressed in
 * Anthropic Messages shapes (the core already builds those); each provider
 * adapter translates to its own wire format and back.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderId } from '../types.js';
import type { Effort } from './constants.js';

export interface OutputSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  /** One model reference or an ordered fallback chain (see TaskModels). */
  model: string | string[];
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  effort: Effort;
  /** Ask for readable thinking summaries when the provider offers them. */
  showThinking?: boolean;
  /** JSON schema the whole text response must satisfy (used without tools). */
  outputSchema?: OutputSchema;
}

export interface LlmHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  /** The chain moved on to another model because the previous one failed before producing output. */
  onModelSwitch?: (info: { from: string; to: string; reason: string }) => void;
  /** Every model failed for a passing reason (busy, overloaded, offline); the chain waits `ms` and tries them all again. */
  onWait?: (info: { ms: number; reason: string }) => void;
  /**
   * Runs a tool the model called while the model is still working. Providers that execute page
   * functions inside one call (the artifact runtime) use it and return only the final text;
   * the other adapters ignore it and return tool_use blocks for the caller to execute.
   */
  executeTool?: (block: Anthropic.ToolUseBlock) => Promise<Anthropic.ToolResultBlockParam>;
}

export type StopReason = Anthropic.Messages.StopReason;

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface LlmMessage {
  provider: ProviderId;
  /** Provider-specific model id that produced the message. */
  model: string;
  /** The model reference as configured (provider prefix included). */
  ref: string;
  content: Anthropic.ContentBlock[];
  /**
   * Adapters report an answer that ended early without an error as 'pause_turn', with
   * stop_details.explanation 'recitation' (stopped for quoting its source) or 'interrupted'
   * (cut off: no finish reason, or one that means the output is incomplete).
   */
  stop_reason: StopReason | null;
  stop_details?: { explanation?: string | null } | null;
  usage: LlmUsage;
}

export interface LlmClient {
  stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage>;
}

/**
 * Why a call failed, where the HTTP status alone cannot tell: a 429 can be a short
 * rate limit (retry soon) or the free tier's daily quota (retrying is pointless).
 */
export type LlmErrorKind = 'rate_limit' | 'daily_quota' | 'overloaded' | 'network' | 'stalled';

export class LlmError extends Error {
  provider: ProviderId;
  model: string;
  status?: number;
  kind?: LlmErrorKind;
  /** How long the provider asked us to wait before retrying (Retry-After, Gemini RetryInfo). */
  retryAfterMs?: number;
  constructor(
    message: string,
    opts: { provider: ProviderId; model: string; status?: number; cause?: unknown; kind?: LlmErrorKind; retryAfterMs?: number },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LlmError';
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
    this.kind = opts.kind;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const TRANSIENT_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>(['rate_limit', 'overloaded', 'network', 'stalled']);
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);
/** What fetch() and body readers reject with when the connection fails (Chrome, Safari, Firefox, Node/undici). */
const NETWORK_MESSAGE = /failed to fetch|load failed|networkerror|network error|fetch failed|network connection was lost|terminated/i;

/** A TypeError thrown by fetch() or a body reader because the connection failed. */
export function isNetworkTypeError(err: unknown): boolean {
  return err instanceof TypeError && NETWORK_MESSAGE.test(err.message);
}

/** The error kind an HTTP status implies: 429 is a rate limit, 5xx (and Anthropic's 529) an overloaded service. */
export function kindForStatus(status: number | undefined): LlmErrorKind | undefined {
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'network';
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return 'overloaded';
  return undefined;
}

/**
 * True when the same request may well succeed if it is sent again shortly: rate
 * limits, overloaded or unreachable services and stalled streams. A daily quota, a
 * rejected key or a malformed request is not transient.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof LlmError) {
    if (err.kind) return TRANSIENT_KINDS.has(err.kind);
    return err.status !== undefined && TRANSIENT_STATUSES.has(err.status);
  }
  if (isNetworkTypeError(err)) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

/** The kind of a transient failure, also for errors that do not carry one. */
export function transientKind(err: unknown): LlmErrorKind | undefined {
  if (!isTransient(err)) return undefined;
  if (err instanceof LlmError && err.kind) return err.kind;
  const status = (err as { status?: unknown } | null)?.status;
  return kindForStatus(typeof status === 'number' ? status : undefined) ?? 'network';
}

/** Milliseconds from a Retry-After header: delay-seconds or an HTTP date. */
export function retryAfterFromHeader(value: string | null | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** What a wait or request rejects with once `signal` has aborted: its reason, or a standard AbortError. */
export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** setTimeout as a promise that rejects at once, with the abort error, when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function emptyLlmUsage(): LlmUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

/** All text blocks of a message joined. */
export function contentText(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolUseBlocks(blocks: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return blocks.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
}

/** Extracts the first JSON object from model text that may be wrapped in prose or code fences. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/** Text form of a tool result's content (for providers that take strings). */
export function toolResultText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}
