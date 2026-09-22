/**
 * Tries the models of a chain in order. A model that fails before producing any
 * visible output (rate limit, missing key, unsupported feature, outage) is
 * skipped and the next one is tried; the caller is told about the switch.
 */
import type { ProviderId } from '../../types.js';
import { PROVIDER_LABELS, parseModelRef } from '../constants.js';
import { LlmError, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest } from '../llm.js';

export type ProviderResolver = (provider: ProviderId) => LlmClient | null;

function describe(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class ChainLlmClient implements LlmClient {
  constructor(private readonly resolve: ProviderResolver) {}

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const refs = (Array.isArray(request.model) ? request.model : [request.model]).map((r) => r.trim()).filter(Boolean);
    if (refs.length === 0) throw new LlmError('No model is configured for this task.', { provider: 'anthropic', model: '' });
    const failures: string[] = [];
    let produced = false;
    for (let index = 0; index < refs.length; index++) {
      const ref = parseModelRef(refs[index]);
      const client = this.resolve(ref.provider);
      const next = refs[index + 1];
      const fail = (reason: string) => {
        failures.push(`${refs[index]}: ${reason}`);
        if (next) handlers.onModelSwitch?.({ from: refs[index], to: next, reason });
      };
      if (!client) {
        fail(`${PROVIDER_LABELS[ref.provider]} is not configured`);
        continue;
      }
      const wrapped: LlmHandlers = {
        onText: (delta) => {
          produced = true;
          handlers.onText?.(delta);
        },
        onThinking: (delta) => handlers.onThinking?.(delta),
        onToolStart: (name) => {
          produced = true;
          handlers.onToolStart?.(name);
        },
        onModelSwitch: handlers.onModelSwitch,
        // A tool that ran inside the call has had its effect: no other model may retry the turn.
        executeTool: handlers.executeTool
          ? async (block) => {
              produced = true;
              return handlers.executeTool!(block);
            }
          : undefined,
      };
      try {
        const message = await client.stream({ ...request, model: ref.model }, wrapped, signal);
        return { ...message, ref: refs[index] };
      } catch (err) {
        if (signal?.aborted || produced) throw err;
        fail(describe(err));
      }
    }
    const last = parseModelRef(refs[refs.length - 1]);
    throw new LlmError(`No model could answer. ${failures.join(' · ')}`, { provider: last.provider, model: last.model });
  }
}
