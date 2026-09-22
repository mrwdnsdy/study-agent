/**
 * Google Gemini API adapter (generateContent over SSE). Translates the
 * Anthropic-shaped request the core builds into Gemini "contents", function
 * declarations, thinking config and JSON-schema output, and folds the stream
 * back into Anthropic content blocks.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../constants.js';
import { LlmError, emptyLlmUsage, toolResultText, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest, type StopReason } from '../llm.js';
import { getPdfText } from './pdfText.js';
import { readSseEvents } from './sse.js';

export interface GeminiOptions {
  /** e.g. https://generativelanguage.googleapis.com or a proxy path that forwards there. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
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

function mapFinish(reason: string | undefined, hasToolUse: boolean): { stop: StopReason; explanation?: string } {
  switch (reason) {
    case undefined:
    case 'STOP':
      return { stop: hasToolUse ? 'tool_use' : 'end_turn' };
    case 'MAX_TOKENS':
      return { stop: 'max_tokens' };
    case 'MALFORMED_FUNCTION_CALL':
      return { stop: 'end_turn', explanation: 'The model produced a malformed function call.' };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { stop: 'refusal', explanation: `Gemini stopped the response (${reason}).` };
    default:
      return { stop: 'end_turn', explanation: reason ? `Gemini finished with ${reason}.` : undefined };
  }
}

function errorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) return `${parsed.error.message}${parsed.error.status ? ` (${parsed.error.status})` : ''}`;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || `HTTP ${status}`;
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  error?: { message?: string; status?: string; code?: number };
}

export class GeminiClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private static counter = 0;

  constructor(options: GeminiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    // Bound wrapper: a bare `fetch` reference called as a method throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
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
        if (!response.ok) throw new LlmError(`Gemini (${model}): ${errorMessage(response.status, await response.text())}`, { provider: 'gemini', model, status: response.status });
      } else {
        throw new LlmError(`Gemini (${model}): ${errorMessage(400, text)}`, { provider: 'gemini', model, status: 400 });
      }
    } else if (!response.ok) {
      throw new LlmError(`Gemini (${model}): ${errorMessage(response.status, await response.text())}`, { provider: 'gemini', model, status: response.status });
    }
    if (!response.body) throw new LlmError(`Gemini (${model}): empty response body`, { provider: 'gemini', model });

    const content: Anthropic.ContentBlock[] = [];
    let text: Anthropic.TextBlock | null = null;
    let thinking: Anthropic.ThinkingBlock | null = null;
    let finishReason: string | undefined;
    let blocked: string | undefined;
    const usage = emptyLlmUsage();

    for await (const event of readSseEvents(response.body)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(event.data) as GeminiChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new LlmError(`Gemini (${model}): ${chunk.error.message ?? 'stream error'}`, { provider: 'gemini', model, status: chunk.error.code });
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

    if (blocked) {
      return { provider: 'gemini', model, ref: model, content, stop_reason: 'refusal', stop_details: { explanation: `Gemini blocked the request (${blocked}).` }, usage };
    }
    const hasToolUse = content.some((b) => b.type === 'tool_use');
    const finish = mapFinish(finishReason, hasToolUse);
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

  private send(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...this.headers };
    if (this.apiKey) headers['x-goog-api-key'] = this.apiKey;
    return this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
}
