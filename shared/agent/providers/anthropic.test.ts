import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { LlmError, isTransient, type LlmRequest } from '../llm.js';
import { AnthropicClient } from './anthropic.js';

const request: LlmRequest = { model: 'claude-sonnet-5', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, effort: 'low' };

/** An SDK stand-in whose message stream fails with `error` as soon as it is read. */
function failingSdk(error: unknown): Anthropic {
  const stream = {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
    finalMessage: async () => {
      throw error;
    },
  };
  return { messages: { stream: () => stream } } as unknown as Anthropic;
}

async function failure(error: unknown): Promise<LlmError> {
  try {
    await new AnthropicClient(failingSdk(error)).stream(request, {});
  } catch (err) {
    assert.ok(err instanceof LlmError, String(err));
    return err;
  }
  throw new Error('expected a failure');
}

describe('AnthropicClient error kinds', () => {
  it('marks connection failures and timeouts as network errors', async () => {
    assert.equal((await failure(new Anthropic.APIConnectionError({ message: 'Connection error.' }))).kind, 'network');
    assert.equal((await failure(new Anthropic.APIConnectionTimeoutError())).kind, 'network');
  });

  it('marks 429 as a rate limit and 529 or 5xx as overloaded, with Retry-After', async () => {
    const limited = await failure(Anthropic.APIError.generate(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '3' })));
    assert.equal(limited.kind, 'rate_limit');
    assert.equal(limited.retryAfterMs, 3_000);
    assert.equal(limited.status, 429);
    assert.equal((await failure(Anthropic.APIError.generate(529, { error: { type: 'overloaded_error' } }, 'Overloaded', new Headers()))).kind, 'overloaded');
    assert.equal((await failure(Anthropic.APIError.generate(500, { error: { type: 'api_error' } }, 'boom', new Headers()))).kind, 'overloaded');
    assert.equal((await failure(Anthropic.APIError.generate(507, { error: { type: 'api_error' } }, 'boom', new Headers()))).kind, 'overloaded');
    const notConfigured = await failure(Anthropic.APIError.generate(501, { error: { type: 'not_configured' } }, 'no key on the proxy', new Headers()));
    assert.equal(isTransient(notConfigured), false, "the proxy's 501 is not worth retrying");
  });

  it('classifies an error event in the middle of the stream by its type', async () => {
    const midStream = new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined, 'overloaded_error');
    const err = await failure(midStream);
    assert.equal(err.kind, 'overloaded');
    assert.ok(isTransient(err));
  });

  it('leaves permanent errors unclassified', async () => {
    const err = await failure(Anthropic.APIError.generate(401, { error: { type: 'authentication_error' } }, 'invalid x-api-key', new Headers()));
    assert.equal(err.kind, undefined);
    assert.equal(isTransient(err), false);
  });
});
