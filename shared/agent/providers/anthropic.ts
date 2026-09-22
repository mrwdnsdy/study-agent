import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest } from '../llm.js';

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
      if (err instanceof Anthropic.APIError) {
        throw new LlmError(`Claude (${model}): ${err.status ? `${err.status} ` : ''}${err.message}`, {
          provider: 'anthropic',
          model,
          status: err.status,
          cause: err,
        });
      }
      throw err;
    }
  }
}
