import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError, abortableSleep, isTransient, kindForStatus, retryAfterFromHeader } from './llm.js';

const withStatus = (status: number) => new LlmError(`HTTP ${status}`, { provider: 'gemini', model: 'x', status });

describe('isTransient', () => {
  it('is true for passing failures', () => {
    for (const kind of ['rate_limit', 'overloaded', 'network', 'stalled'] as const) {
      assert.equal(isTransient(new LlmError(kind, { provider: 'gemini', model: 'x', kind })), true, kind);
    }
    for (const status of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isTransient(withStatus(status)), true, String(status));
    for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      assert.equal(isTransient(new TypeError(message)), true, message);
    }
  });

  it('is false for daily quotas and permanent failures', () => {
    assert.equal(isTransient(new LlmError('quota', { provider: 'gemini', model: 'x', status: 429, kind: 'daily_quota' })), false);
    for (const status of [400, 401, 403]) assert.equal(isTransient(withStatus(status)), false, String(status));
    assert.equal(isTransient(new TypeError('x is not a function')), false);
    assert.equal(isTransient(new Error('Failed to fetch')), false, 'only TypeErrors come from fetch');
    assert.equal(isTransient(new DOMException('aborted', 'AbortError')), false);
  });

  it('maps statuses to kinds', () => {
    assert.equal(kindForStatus(429), 'rate_limit');
    assert.equal(kindForStatus(503), 'overloaded');
    assert.equal(kindForStatus(529), 'overloaded');
    assert.equal(kindForStatus(501), undefined);
    assert.equal(kindForStatus(undefined), undefined);
  });
});

describe('retryAfterFromHeader', () => {
  it('reads seconds and HTTP dates', () => {
    assert.equal(retryAfterFromHeader('23'), 23_000);
    assert.equal(retryAfterFromHeader('1.5'), 1_500);
    assert.equal(retryAfterFromHeader(null), undefined);
    assert.equal(retryAfterFromHeader('soon'), undefined);
    const inAMinute = retryAfterFromHeader(new Date(Date.now() + 60_000).toUTCString());
    assert.ok(inAMinute !== undefined && inAMinute > 55_000 && inAMinute <= 60_000);
  });
});

describe('abortableSleep', () => {
  it('waits, and rejects with the abort error as soon as the signal aborts', async () => {
    await abortableSleep(5);
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableSleep(10_000, controller.signal);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
    assert.ok(Date.now() - started < 1_000);
    await assert.rejects(abortableSleep(10, controller.signal), (err: unknown) => err instanceof DOMException);
  });
});
