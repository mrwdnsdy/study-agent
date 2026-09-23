/**
 * Tries the models of a chain in order. A model that fails before producing any
 * visible output (rate limit, missing key, unsupported feature, outage) is
 * skipped and the next one is tried; the caller is told about the switch. When
 * every model failed and at least one failure was transient (busy, overloaded,
 * offline), the whole chain is tried again after a pause, a couple of times.
 */
import type { ProviderId } from '../../types.js';
import { PROVIDER_LABELS, parseModelRef } from '../constants.js';
import {
  LlmError,
  abortableSleep,
  isTransient,
  transientKind,
  type LlmClient,
  type LlmErrorKind,
  type LlmHandlers,
  type LlmMessage,
  type LlmRequest,
} from '../llm.js';

export type ProviderResolver = (provider: ProviderId) => LlmClient | null;

export interface ChainOptions {
  /** Waits between passes; must reject promptly when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Extra passes over the whole chain after every model failed for a transient reason. */
const MAX_EXTRA_PASSES = 2;
/** Pause before another pass when no model said how long to wait. */
const DEFAULT_PASS_WAIT_MS = 8_000;
const MAX_PASS_WAIT_MS = 45_000;

interface Failure {
  ref: string;
  reason: string;
  /** Absent when the provider is not configured: nothing was sent. */
  error?: unknown;
}

function describe(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The fallback chain for continuing work that `ref` started: `ref` and the models
 * after it, so a continuation stays on the model that wrote the text but can
 * still fall back. A ref outside the chain (an escalation model) goes first.
 */
export function chainFrom(ref: string, chain: string | string[]): string[] {
  const list = (Array.isArray(chain) ? chain : [chain]).map((r) => r.trim()).filter(Boolean);
  const target = ref.trim();
  const index = list.indexOf(target);
  return [...new Set(index === -1 ? [target, ...list] : list.slice(index))].filter(Boolean);
}

/** The longest wait any transient failure asked for (capped), or the default pause. */
function passWait(errors: unknown[]): number {
  const hinted = errors
    .map((err) => (err instanceof LlmError ? err.retryAfterMs : undefined))
    .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
  return hinted.length ? Math.min(MAX_PASS_WAIT_MS, Math.max(...hinted)) : DEFAULT_PASS_WAIT_MS;
}

/** One error for a chain where no model could answer, classified so callers can decide what to do next. */
function chainError(refs: string[], failures: Failure[]): LlmError {
  const last = parseModelRef(refs[refs.length - 1]);
  const errors = failures.flatMap((failure) => (failure.error === undefined ? [] : [failure.error]));
  // The first failure's status (e.g. 429) describes the outage best.
  const status = errors.map((err) => (err instanceof LlmError ? err.status : undefined)).find((s) => s !== undefined);
  const daily = errors.length > 0 && errors.every((err) => err instanceof LlmError && err.kind === 'daily_quota');
  const transient = errors.filter(isTransient);
  const kind: LlmErrorKind | undefined = daily ? 'daily_quota' : transient.length ? transientKind(transient[0]) : undefined;
  return new LlmError(`No model could answer. ${failures.map((f) => `${f.ref}: ${f.reason}`).join(' · ')}`, {
    provider: last.provider,
    model: last.model,
    status,
    kind,
    retryAfterMs: transient.length ? passWait(transient) : undefined,
  });
}

export class ChainLlmClient implements LlmClient {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly resolve: ProviderResolver,
    options: ChainOptions = {},
  ) {
    this.sleep = options.sleep ?? abortableSleep;
  }

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const refs = (Array.isArray(request.model) ? request.model : [request.model]).map((r) => r.trim()).filter(Boolean);
    if (refs.length === 0) throw new LlmError('No model is configured for this task.', { provider: 'anthropic', model: '' });
    for (let pass = 0; ; pass++) {
      const failures: Failure[] = [];
      const message = await this.pass(refs, request, handlers, failures, signal);
      if (message) return message;
      const transient = failures.filter((f) => f.error !== undefined && isTransient(f.error));
      if (transient.length === 0 || pass >= MAX_EXTRA_PASSES) throw chainError(refs, failures);
      const ms = passWait(transient.map((f) => f.error));
      handlers.onWait?.({ ms, reason: transient[0].reason });
      await this.sleep(ms, signal);
    }
  }

  /** One pass over the chain: the first answer, or null with `failures` filled in. */
  private async pass(
    refs: string[],
    request: LlmRequest,
    handlers: LlmHandlers,
    failures: Failure[],
    signal?: AbortSignal,
  ): Promise<LlmMessage | null> {
    let produced = false;
    for (let index = 0; index < refs.length; index++) {
      const ref = parseModelRef(refs[index]);
      const client = this.resolve(ref.provider);
      const next = refs[index + 1];
      const fail = (reason: string, error?: unknown) => {
        failures.push({ ref: refs[index], reason, error });
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
        fail(describe(err), err);
      }
    }
    return null;
  }
}
