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
  stop_reason: StopReason | null;
  stop_details?: { explanation?: string | null } | null;
  usage: LlmUsage;
}

export interface LlmClient {
  stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage>;
}

export class LlmError extends Error {
  provider: ProviderId;
  model: string;
  status?: number;
  constructor(message: string, opts: { provider: ProviderId; model: string; status?: number; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LlmError';
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
  }
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
