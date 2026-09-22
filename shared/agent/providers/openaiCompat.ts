/**
 * Adapter for OpenAI-compatible chat-completions endpoints: OpenRouter, Z.ai and
 * Cloudflare Workers AI. Translates Anthropic-shaped requests (text, images,
 * PDFs, tools, tool results, JSON output) and folds the SSE stream back into
 * Anthropic content blocks.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderId } from '../../types.js';
import type { Effort } from '../constants.js';
import { LlmError, emptyLlmUsage, toolResultText, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest, type StopReason } from '../llm.js';
import { getPdfText } from './pdfText.js';
import { readSseEvents } from './sse.js';

export interface OpenAICompatCapabilities {
  /** The endpoint enforces response_format json_schema. Otherwise json_object plus instructions is used. */
  jsonSchema: boolean;
  /** How PDFs travel: OpenRouter's file parser plugin, or extracted text. */
  pdf: 'openrouter-file' | 'text';
  /** Which reasoning switch the endpoint understands. */
  reasoning: 'openrouter' | 'zai' | 'none';
}

export interface OpenAICompatOptions {
  provider: ProviderId;
  /** Base URL that ends before /chat/completions, e.g. https://openrouter.ai/api/v1. */
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  capabilities: OpenAICompatCapabilities;
}

export const CAPABILITIES: Record<Exclude<ProviderId, 'anthropic' | 'gemini'>, OpenAICompatCapabilities> = {
  openrouter: { jsonSchema: true, pdf: 'openrouter-file', reasoning: 'openrouter' },
  zai: { jsonSchema: false, pdf: 'text', reasoning: 'zai' },
  'workers-ai': { jsonSchema: false, pdf: 'text', reasoning: 'none' },
};

type Json = Record<string, unknown>;

function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

/** Translates one Anthropic message into one or more chat-completions messages. */
function toMessages(message: Anthropic.MessageParam, capabilities: OpenAICompatCapabilities, state: { usesFiles: boolean }): Json[] {
  if (typeof message.content === 'string') {
    return message.content ? [{ role: message.role, content: message.content }] : [];
  }
  if (message.role === 'assistant') {
    const text = message.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = message.content
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
      .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    if (!text && toolCalls.length === 0) return [];
    const out: Json = { role: 'assistant', content: text || null };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return [out];
  }
  const out: Json[] = [];
  const parts: Json[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'tool_result':
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block.content) || (block.is_error ? 'Error' : 'Done') });
        break;
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image':
        if (block.source.type === 'base64') parts.push({ type: 'image_url', image_url: { url: dataUrl(block.source.media_type, block.source.data) } });
        else if (block.source.type === 'url') parts.push({ type: 'image_url', image_url: { url: block.source.url } });
        break;
      case 'document': {
        const source = block.source;
        const title = block.title ?? 'document';
        if (source.type === 'text') {
          parts.push({ type: 'text', text: `[${title}]\n${source.data}` });
        } else if (source.type === 'base64' && capabilities.pdf === 'openrouter-file') {
          state.usesFiles = true;
          parts.push({ type: 'file', file: { filename: title.toLowerCase().endsWith('.pdf') ? title : `${title}.pdf`, file_data: dataUrl(source.media_type, source.data) } });
        } else {
          const text = getPdfText(block);
          parts.push({ type: 'text', text: text ? `[${title}]\n${text}` : `[Document "${title}" is a PDF whose text could not be extracted; ask the student for a text version]` });
        }
        break;
      }
      default:
        break;
    }
  }
  if (parts.length) out.push({ role: 'user', content: parts });
  return out;
}

const EFFORT_TO_OPENAI: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'medium', xhigh: 'high', max: 'high' };

/** The JSON body for /chat/completions. Exported for tests. */
export function buildChatBody(request: LlmRequest, model: string, capabilities: OpenAICompatCapabilities): Json {
  const state = { usesFiles: false };
  let system = request.system;
  if (request.outputSchema) {
    system += `\n\nRespond with a single JSON object and nothing else. It must match this JSON Schema exactly:\n${JSON.stringify(request.outputSchema.schema)}`;
  }
  const messages: Json[] = [{ role: 'system', content: system }];
  for (const message of request.messages) messages.push(...toMessages(message, capabilities, state));
  const body: Json = { model, messages, stream: true, max_tokens: request.maxTokens, stream_options: { include_usage: true } };
  if (!request.outputSchema && request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    body.tool_choice = 'auto';
  }
  if (request.outputSchema) {
    body.response_format = capabilities.jsonSchema
      ? { type: 'json_schema', json_schema: { name: request.outputSchema.name, schema: request.outputSchema.schema, strict: true } }
      : { type: 'json_object' };
  }
  if (capabilities.reasoning === 'openrouter') body.reasoning = { effort: EFFORT_TO_OPENAI[request.effort], exclude: !request.showThinking };
  else if (capabilities.reasoning === 'zai') body.thinking = { type: request.effort === 'low' ? 'disabled' : 'enabled' };
  if (state.usesFiles) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  return body;
}

function mapFinish(reason: string | null | undefined, hasToolUse: boolean): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return hasToolUse ? 'tool_use' : 'end_turn';
  }
}

function errorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; metadata?: { raw?: string } } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return `${parsed.error.message}${parsed.error.metadata?.raw ? ` (${parsed.error.metadata.raw.slice(0, 200)})` : ''}`;
    if (parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || `HTTP ${status}`;
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: { text?: string }[];
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string; code?: number } | string;
}

export class OpenAICompatClient implements LlmClient {
  private readonly fetchImpl: typeof fetch;
  private static counter = 0;

  constructor(private readonly options: OpenAICompatOptions) {
    // Bound wrapper: a bare `fetch` reference called as a method throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const { provider, capabilities } = this.options;
    const model = Array.isArray(request.model) ? request.model[0] : request.model;
    const body = buildChatBody(request, model, capabilities);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...(this.options.headers ?? {}) };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new LlmError(`${model}: ${errorMessage(response.status, await response.text())}`, { provider, model, status: response.status });
    }
    if (!response.body) throw new LlmError(`${model}: empty response body`, { provider, model });

    const content: Anthropic.ContentBlock[] = [];
    let text: Anthropic.TextBlock | null = null;
    let thinking: Anthropic.ThinkingBlock | null = null;
    const calls = new Map<number, { block: Anthropic.ToolUseBlock; args: string }>();
    let finishReason: string | null | undefined;
    const usage = emptyLlmUsage();

    const pushThinking = (delta: string) => {
      if (!delta) return;
      if (!thinking) {
        thinking = { type: 'thinking', thinking: '', signature: '' };
        content.push(thinking);
      }
      thinking.thinking += delta;
      handlers.onThinking?.(delta);
    };

    for await (const event of readSseEvents(response.body)) {
      if (event.data.trim() === '[DONE]') break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(event.data) as ChatChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'stream error');
        throw new LlmError(`${model}: ${message}`, { provider, model, status: typeof chunk.error === 'object' ? chunk.error.code : undefined });
      }
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
        usage.cache_read_input_tokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.reasoning === 'string') pushThinking(delta.reasoning);
      if (typeof delta.reasoning_content === 'string') pushThinking(delta.reasoning_content);
      for (const detail of delta.reasoning_details ?? []) if (typeof detail.text === 'string') pushThinking(detail.text);
      if (typeof delta.content === 'string' && delta.content) {
        if (!text) {
          text = { type: 'text', text: '', citations: null };
          content.push(text);
        }
        text.text += delta.content;
        handlers.onText?.(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        let entry = calls.get(index);
        if (!entry) {
          const block: Anthropic.ToolUseBlock = {
            type: 'tool_use',
            id: call.id || `call_${Date.now().toString(36)}_${(OpenAICompatClient.counter += 1)}`,
            name: call.function?.name ?? '',
            input: {},
            caller: { type: 'direct' },
          };
          entry = { block, args: '' };
          calls.set(index, entry);
          content.push(block);
          text = null;
          if (block.name) handlers.onToolStart?.(block.name);
        } else if (call.function?.name && !entry.block.name) {
          entry.block.name = call.function.name;
          handlers.onToolStart?.(entry.block.name);
        }
        if (call.function?.arguments) entry.args += call.function.arguments;
      }
    }

    for (const { block, args } of calls.values()) {
      try {
        block.input = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {};
      } catch {
        block.input = { __invalid_json: args };
      }
    }
    const hasToolUse = calls.size > 0;
    const stop = mapFinish(finishReason, hasToolUse);
    return {
      provider,
      model,
      ref: model,
      content,
      stop_reason: stop,
      stop_details: stop === 'refusal' ? { explanation: 'The provider stopped the response for content policy reasons.' } : null,
      usage,
    };
  }
}
