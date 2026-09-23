import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError, emptyLlmUsage, type LlmClient, type LlmMessage, type LlmRequest } from '../llm.js';
import { ChainLlmClient, chainFrom } from './chain.js';

const request: LlmRequest = { model: ['gemini/a', 'gemini/b'], system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, effort: 'low' };

function answer(model: string): LlmMessage {
  return { provider: 'gemini', model, ref: model, content: [{ type: 'text', text: 'ok', citations: null }], stop_reason: 'end_turn', usage: emptyLlmUsage() };
}

/** A chain whose client runs `behaviour` for every call, with a sleep that only records. */
function chainOf(behaviour: (model: string, call: number) => LlmMessage) {
  const sleeps: number[] = [];
  const calls: string[] = [];
  const client: LlmClient = {
    async stream(req) {
      const model = String(req.model);
      calls.push(model);
      return behaviour(model, calls.length);
    },
  };
  const chain = new ChainLlmClient(() => client, { sleep: async (ms) => void sleeps.push(ms) });
  return { chain, sleeps, calls };
}

const busy = (model: string, retryAfterMs?: number) => new LlmError(`Gemini (${model}): 429`, { provider: 'gemini', model, status: 429, kind: 'rate_limit', retryAfterMs });
const daily = (model: string) => new LlmError(`Gemini (${model}): quota`, { provider: 'gemini', model, status: 429, kind: 'daily_quota', retryAfterMs: 23_000 });

describe('ChainLlmClient retry passes', () => {
  it('waits the longest retryAfterMs, then runs the whole chain again', async () => {
    const waits: { ms: number; reason: string }[] = [];
    const { chain, sleeps, calls } = chainOf((model, call) => {
      if (call === 1) throw busy(model, 23_000);
      if (call === 2) throw busy(model, 5_000);
      return answer(model);
    });
    const message = await chain.stream(request, { onWait: (info) => waits.push(info) });
    assert.deepEqual(sleeps, [23_000]);
    assert.deepEqual(calls, ['a', 'b', 'a']);
    assert.equal(waits.length, 1);
    assert.equal(waits[0].ms, 23_000);
    assert.match(waits[0].reason, /429/);
    assert.equal(message.ref, 'gemini/a');
  });

  it('gives up after two extra passes with a classified error', async () => {
    const { chain, sleeps, calls } = chainOf((model) => {
      throw new LlmError(`Gemini (${model}): 503`, { provider: 'gemini', model, status: 503 });
    });
    await assert.rejects(chain.stream(request, {}), (err: unknown) => err instanceof LlmError && err.status === 503 && err.kind === 'overloaded' && /No model could answer/.test(err.message));
    assert.deepEqual(sleeps, [8_000, 8_000], 'the default pause when no model says how long to wait');
    assert.equal(calls.length, 6);
  });

  it('caps the wait at 45 s', async () => {
    const { chain, sleeps } = chainOf((model, call) => {
      if (call <= 2) throw busy(model, 300_000);
      return answer(model);
    });
    await chain.stream(request, {});
    assert.deepEqual(sleeps, [45_000]);
  });

  it('does not retry when every model is out of its daily quota', async () => {
    const { chain, sleeps, calls } = chainOf((model) => {
      throw daily(model);
    });
    await assert.rejects(chain.stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === 'daily_quota' && err.status === 429);
    assert.deepEqual(sleeps, []);
    assert.equal(calls.length, 2);
  });

  it('retries when one model is only rate-limited, and does not call the error a daily quota', async () => {
    const { chain, sleeps } = chainOf((model) => {
      throw model === 'a' ? daily(model) : busy(model, 4_000);
    });
    await assert.rejects(chain.stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === 'rate_limit');
    assert.deepEqual(sleeps, [4_000, 4_000], 'the wait follows the model that can recover');
  });

  it('does not retry permanent failures', async () => {
    const { chain, sleeps } = chainOf((model) => {
      throw new LlmError(`Gemini (${model}): bad key`, { provider: 'gemini', model, status: 403 });
    });
    await assert.rejects(chain.stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === undefined && err.status === 403);
    assert.deepEqual(sleeps, []);
  });

  it('stops waiting at once when the request is aborted', async () => {
    const client: LlmClient = {
      async stream(req) {
        throw busy(String(req.model), 30_000);
      },
    };
    const chain = new ChainLlmClient(() => client);
    const controller = new AbortController();
    const started = Date.now();
    await assert.rejects(
      chain.stream(request, { onWait: () => setTimeout(() => controller.abort(), 10) }, controller.signal),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
    assert.ok(Date.now() - started < 2_000, 'the 30 s wait was cut short');
  });
});

describe('chainFrom', () => {
  it('continues from the model that answered, falling back only to the models after it', () => {
    assert.deepEqual(chainFrom('gemini/b', ['gemini/a', 'gemini/b', 'gemini/c']), ['gemini/b', 'gemini/c']);
    assert.deepEqual(chainFrom('gemini/a', ['gemini/a', 'gemini/b']), ['gemini/a', 'gemini/b']);
    assert.deepEqual(chainFrom('gemini/c', 'gemini/c'), ['gemini/c']);
  });

  it('puts a model outside the chain first, without duplicates', () => {
    assert.deepEqual(chainFrom('claude-fable-5-1', ['gemini/a', 'gemini/b']), ['claude-fable-5-1', 'gemini/a', 'gemini/b']);
    assert.deepEqual(chainFrom('x', ['a', 'a', ' b ']), ['x', 'a', 'b']);
  });
});
