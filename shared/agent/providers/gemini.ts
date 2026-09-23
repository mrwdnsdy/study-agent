/**
 * Google Gemini API adapter (generateContent over SSE). Translates the
 * Anthropic-shaped request the core builds into Gemini "contents", function
 * declarations, thinking config and JSON-schema output, and folds the stream
 * back into Anthropic content blocks.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../constants.js';
import {
  LlmError,
  emptyLlmUsage,
  kindForStatus,
  retryAfterFromHeader,
  toolResultText,
  type LlmClient,
  type LlmErrorKind,
  type LlmHandlers,
  type LlmMessage,
  type LlmRequest,
  type StopReason,
} from '../llm.js';
import { getPdfText } from './pdfText.js';
import { DEFAULT_FIRST_BYTE_MS, fetchStream, isTransportError, readSseEvents, transportError, type StallOptions } from './sse.js';

export interface GeminiOptions {
  /** e.g. https://generativelanguage.googleapis.com or a proxy path that forwards there. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Stall timeouts (defaults: 180 s to the first byte, 90 s between chunks). */
  stall?: StallOptions;
}

/** Gemini 3 returns thought signatures on some parts; they must be sent back unchanged in later turns. */
const signatures = new WeakMap<object, string>();

const MAX_OUTPUT_TOKENS = 65_536;

type GeminiPart = Record<string, unknown>;

function toolNameForId(messages: Anthropic.MessageParam[], toolUseId: string): string {
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) return block.name;
    }
  }
  return 'tool';
}

function withSignature(part: GeminiPart, block: object): GeminiPart {
  const signature = signatures.get(block);
  return signature ? { ...part, thoughtSignature: signature } : part;
}

function toParts(message: Anthropic.MessageParam, all: Anthropic.MessageParam[]): GeminiPart[] {
  if (typeof message.content === 'string') return message.content ? [{ text: message.content }] : [];
  const parts: GeminiPart[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(withSignature({ text: block.text }, block));
        break;
      case 'image':
        if (block.source.type === 'base64') parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
        else if (block.source.type === 'url') parts.push({ fileData: { fileUri: block.source.url } });
        break;
      case 'document': {
        const source = block.source;
        if (source.type === 'base64' && source.media_type === 'application/pdf') {
          parts.push({ inlineData: { mimeType: 'application/pdf', data: source.data } });
        } else if (source.type === 'text') {
          parts.push({ text: source.data });
        } else {
          const text = getPdfText(block);
          parts.push({ text: text ? `[${block.title ?? 'Document'}]\n${text}` : `[Document "${block.title ?? ''}" could not be attached]` });
        }
        break;
      }
      case 'tool_use':
        parts.push(withSignature({ functionCall: { name: block.name, args: block.input ?? {} } }, block));
        break;
      case 'tool_result': {
        const text = toolResultText(block.content);
        parts.push({
          functionResponse: {
            name: toolNameForId(all, block.tool_use_id),
            response: block.is_error ? { error: text } : { result: text },
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function thinkingConfig(model: string, effort: Effort, showThinking: boolean | undefined): Record<string, unknown> {
  const includeThoughts = Boolean(showThinking);
  if (/gemini-2\.5/i.test(model)) {
    const budgets: Record<Effort, number> = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };
    return { includeThoughts, thinkingBudget: budgets[effort] };
  }
  const levels: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'medium', xhigh: 'high', max: 'high' };
  return { includeThoughts, thinkingLevel: levels[effort] };
}

const SAFETY_SETTINGS = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
  (category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }),
);

/** The JSON body for models/{model}:streamGenerateContent. Exported for tests. */
export function buildGeminiBody(request: LlmRequest, model: string): Record<string, unknown> {
  const contents = request.messages
    .map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: toParts(message, request.messages) }))
    .filter((content) => content.parts.length > 0);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(request.maxTokens, MAX_OUTPUT_TOKENS),
    thinkingConfig: thinkingConfig(model, request.effort, request.showThinking),
  };
  if (request.outputSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = request.outputSchema.schema;
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents,
    generationConfig,
    safetySettings: SAFETY_SETTINGS,
  };
  if (!request.outputSchema && request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.input_schema,
        })),
      },
    ];
  }
  return body;
}

/** Finish reasons Gemini gives when it blocked its own answer for policy reasons. */
const REFUSAL_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

/**
 * Maps Gemini's finishReason onto the stop reasons the core understands. Only STOP
 * is a finished answer. RECITATION and the reasons that mean something went wrong
 * (OTHER, FINISH_REASON_UNSPECIFIED, MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL,
 * TOO_MANY_TOOL_CALLS, LANGUAGE and any value added later) become pause_turn, so a
 * cut-off document is continued instead of being saved as complete. A complete
 * answer always carries a finishReason on its last chunk, so output without one
 * means the stream was cut. Exported for tests.
 */
export function mapFinish(reason: string | undefined, hasToolUse: boolean, hasOutput: boolean): { stop: StopReason; explanation?: string } {
  if (reason === 'STOP') return { stop: hasToolUse ? 'tool_use' : 'end_turn' };
  if (reason === 'MAX_TOKENS') return { stop: 'max_tokens' };
  if (reason === 'RECITATION') return { stop: 'pause_turn', explanation: 'recitation' };
  if (reason && REFUSAL_REASONS.has(reason)) return { stop: 'refusal', explanation: `Gemini stopped the response (${reason}).` };
  if (reason === undefined && !hasOutput) return { stop: 'end_turn' };
  return { stop: 'pause_turn', explanation: 'interrupted' };
}

/** The `error` object of a Gemini error response or stream chunk. */
interface GeminiErrorBody {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
}

function parseErrorBody(text: string): GeminiErrorBody | null {
  try {
    const parsed = JSON.parse(text) as { error?: GeminiErrorBody } | { error?: GeminiErrorBody }[];
    // Some gateways return the streaming endpoint's errors as a one-element array.
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    return error && typeof error === 'object' ? error : null;
  } catch {
    return null;
  }
}

function errorMessage(status: number, text: string): string {
  const error = parseErrorBody(text);
  if (error?.message) return `${error.message}${error.status ? ` (${error.status})` : ''}`;
  return text.slice(0, 300) || `HTTP ${status}`;
}

/** A google.protobuf.Duration in its JSON form ("23s", "1.5s") in milliseconds. */
function durationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(value);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

/**
 * Reads the google.rpc details of an error: RetryInfo says how long to wait, and a
 * QuotaFailure on a per-day quota means that waiting will not help until tomorrow.
 * Falls back to the Retry-After header and the status. Exported for tests.
 */
export function geminiErrorInfo(
  status: number | undefined,
  error: GeminiErrorBody | null | undefined,
  retryAfter?: string | null,
): { kind?: LlmErrorKind; retryAfterMs?: number } {
  let retryAfterMs: number | undefined;
  let daily = false;
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    if (!detail || typeof detail !== 'object') continue;
    const entry = detail as { '@type'?: unknown; retryDelay?: unknown; violations?: unknown };
    const type = typeof entry['@type'] === 'string' ? entry['@type'] : '';
    if (type.endsWith('google.rpc.RetryInfo')) {
      retryAfterMs = durationMs(entry.retryDelay) ?? retryAfterMs;
    } else if (type.endsWith('google.rpc.QuotaFailure') && Array.isArray(entry.violations)) {
      daily ||= entry.violations.some((violation: { quotaId?: unknown; quotaMetric?: unknown } | null) =>
        /PerDay/i.test(`${violation?.quotaId ?? ''} ${violation?.quotaMetric ?? ''}`),
      );
    }
  }
  retryAfterMs ??= retryAfterFromHeader(retryAfter);
  return { kind: daily ? 'daily_quota' : kindForStatus(status ?? error?.code), retryAfterMs };
}

function geminiError(model: string, message: string, status: number | undefined, error: GeminiErrorBody | null, retryAfter?: string | null): LlmError {
  return new LlmError(`Gemini (${model}): ${message}`, { provider: 'gemini', model, status, ...geminiErrorInfo(status, error, retryAfter) });
}

/** LlmError for a non-OK response; `text` is the body when it was already read. */
async function httpError(model: string, response: Response, text?: string): Promise<LlmError> {
  const body = text ?? (await response.text().catch(() => ''));
  return geminiError(model, errorMessage(response.status, body), response.status, parseErrorBody(body), response.headers.get('retry-after'));
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  error?: GeminiErrorBody;
}

export class GeminiClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly stall: StallOptions;
  private static counter = 0;

  constructor(options: GeminiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    // Bound wrapper: a bare `fetch` reference called as a method throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.stall = options.stall ?? {};
  }

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const model = Array.isArray(request.model) ? request.model[0] : request.model;
    const body = buildGeminiBody(request, model);
    let response = await this.send(model, body, signal);
    if (response.status === 400) {
      const text = await response.text();
      // Older or restricted models reject thinkingLevel/thinkingBudget: retry without thinking config.
      if (/thinking/i.test(text) && (body.generationConfig as Record<string, unknown>).thinkingConfig) {
        delete (body.generationConfig as Record<string, unknown>).thinkingConfig;
        response = await this.send(model, body, signal);
        if (!response.ok) throw await httpError(model, response);
      } else {
        throw await httpError(model, response, text);
      }
    } else if (!response.ok) {
      throw await httpError(model, response);
    }
    if (!response.body) throw new LlmError(`Gemini (${model}): empty response body`, { provider: 'gemini', model, kind: 'network' });

    const content: Anthropic.ContentBlock[] = [];
    let text: Anthropic.TextBlock | null = null;
    let thinking: Anthropic.ThinkingBlock | null = null;
    let finishReason: string | undefined;
    let blocked: string | undefined;
    const usage = emptyLlmUsage();

    try {
      for await (const event of readSseEvents(response.body, this.stall)) {
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(event.data) as GeminiChunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          throw geminiError(model, chunk.error.message ?? 'stream error', chunk.error.code, chunk.error);
        }
        if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReasonMessage ?? chunk.promptFeedback.blockReason;
        if (chunk.usageMetadata) {
          usage.input_tokens = chunk.usageMetadata.promptTokenCount ?? usage.input_tokens;
          usage.output_tokens = (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0);
          usage.cache_read_input_tokens = chunk.usageMetadata.cachedContentTokenCount ?? 0;
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) finishReason = candidate.finishReason;
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            const block: Anthropic.ToolUseBlock = {
              type: 'tool_use',
              id: `gemini_${Date.now().toString(36)}_${(GeminiClient.counter += 1)}`,
              name: part.functionCall.name,
              input: part.functionCall.args ?? {},
              caller: { type: 'direct' },
            };
            if (part.thoughtSignature) signatures.set(block, part.thoughtSignature);
            content.push(block);
            text = null;
            thinking = null;
            handlers.onToolStart?.(block.name);
            continue;
          }
          if (typeof part.text !== 'string') continue;
          if (part.thought) {
            if (!thinking) {
              thinking = { type: 'thinking', thinking: '', signature: '' };
              content.push(thinking);
            }
            thinking.thinking += part.text;
            handlers.onThinking?.(part.text);
          } else {
            if (!text) {
              text = { type: 'text', text: '', citations: null };
              content.push(text);
            }
            text.text += part.text;
            if (part.thoughtSignature) signatures.set(text, part.thoughtSignature);
            handlers.onText?.(part.text);
          }
        }
      }
    } catch (err) {
      // A dropped or stalled connection becomes a classified LlmError; errors from the content or the handlers pass through.
      throw isTransportError(err) ? transportError(err, { provider: 'gemini', model, label: `Gemini (${model})`, signal }) : err;
    }

    if (blocked) {
      return { provider: 'gemini', model, ref: model, content, stop_reason: 'refusal', stop_details: { explanation: `Gemini blocked the request (${blocked}).` }, usage };
    }
    const hasToolUse = content.some((b) => b.type === 'tool_use');
    const finish = mapFinish(finishReason, hasToolUse, content.length > 0);
    return {
      provider: 'gemini',
      model,
      ref: model,
      content,
      stop_reason: finish.stop,
      stop_details: finish.explanation ? { explanation: finish.explanation } : null,
      usage,
    };
  }

  private async send(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...this.headers };
    if (this.apiKey) headers['x-goog-api-key'] = this.apiKey;
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body), signal };
    try {
      return await fetchStream(this.fetchImpl, url, init, this.stall.firstByteMs ?? DEFAULT_FIRST_BYTE_MS);
    } catch (err) {
      throw transportError(err, { provider: 'gemini', model, label: `Gemini (${model})`, signal });
    }
  }
}
