import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  isNetworkTypeError,
  kindForStatus,
  retryAfterFromHeader,
  type LlmClient,
  type LlmErrorKind,
  type LlmHandlers,
  type LlmMessage,
  type LlmRequest,
} from '../llm.js';

/** Error types of the API's error body; a mid-stream `error` event carries only these, without a status. */
const KIND_BY_TYPE: Partial<Record<string, LlmErrorKind>> = {
  rate_limit_error: 'rate_limit',
  overloaded_error: 'overloaded',
  api_error: 'overloaded',
  timeout_error: 'overloaded',
};

/** Retry-After in milliseconds, preferring the API's precise retry-after-ms header. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const precise = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(precise) && precise > 0) return precise;
  return retryAfterFromHeader(headers?.get('retry-after'));
}

/** Classifies SDK errors so the chain and the core know which failures are worth retrying. */
function toLlmError(err: unknown, model: string): unknown {
  // Connection failures and client-side timeouts (APIConnectionTimeoutError extends APIConnectionError).
  if (err instanceof Anthropic.APIConnectionError || isNetworkTypeError(err)) {
    return new LlmError(`Claude (${model}): ${(err as Error).message}`, { provider: 'anthropic', model, kind: 'network', cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    // A 5xx (529 included) means the API is overloaded or failing for now. 501 is the proxy saying Claude is not set up.
    const byStatus = err.status !== undefined && err.status >= 500 && err.status !== 501 ? 'overloaded' : kindForStatus(err.status);
    return new LlmError(`Claude (${model}): ${err.status ? `${err.status} ` : ''}${err.message}`, {
      provider: 'anthropic',
      model,
      status: err.status,
      kind: byStatus ?? (err.type ? KIND_BY_TYPE[err.type] : undefined),
      retryAfterMs: retryAfterMs(err.headers),
      cause: err,
    });
  }
  return err;
}

/** Claude through the official SDK: prompt caching, adaptive thinking, strict tools, structured output. */
export class AnthropicClient implements LlmClient {
  constructor(private readonly client: Anthropic) {}

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const model = Array.isArray(request.model) ? request.model[0] : request.model;
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: request.outputSchema ? undefined : request.tools,
      thinking: { type: 'adaptive', display: request.showThinking ? 'summarized' : 'omitted' },
      output_config: {
        effort: request.effort,
        format: request.outputSchema ? { type: 'json_schema', schema: request.outputSchema.schema } : undefined,
      },
      cache_control: { type: 'ephemeral' },
      messages: request.messages,
    };
    try {
      const stream = this.client.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') handlers.onToolStart?.(event.content_block.name);
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') handlers.onText?.(event.delta.text);
          else if (event.delta.type === 'thinking_delta') handlers.onThinking?.(event.delta.thinking);
        }
      }
      const message = await stream.finalMessage();
      return {
        provider: 'anthropic',
        model: message.model,
        ref: model,
        content: message.content,
        stop_reason: message.stop_reason,
        stop_details: message.stop_details ? { explanation: message.stop_details.explanation } : null,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (err) {
      // A stopped request keeps its abort error.
      if (signal?.aborted) throw err;
      throw toLlmError(err, model);
    }
  }
}
