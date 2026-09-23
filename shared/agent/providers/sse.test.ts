import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from '../llm.js';
import { SseReadError, SseStallError, fetchStream, readSseEvents, transportError } from './sse.js';

const encoder = new TextEncoder();

describe('readSseEvents stall timeout', () => {
  it('gives up with SseStallError when no byte arrives, and cancels the reader', async () => {
    let cancelled: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    });
    const started = Date.now();
    await assert.rejects(async () => {
      for await (const _ of readSseEvents(body, { firstByteMs: 30, idleMs: 1_000 })) {
        /* never */
      }
    }, SseStallError);
    assert.ok(Date.now() - started < 1_000, 'the first-byte timeout applies, not the idle one');
    assert.ok(cancelled instanceof SseStallError, 'the stalled body is cancelled');
  });

  it('yields what arrived, then stalls once the stream goes quiet', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
      },
    });
    const events: string[] = [];
    await assert.rejects(async () => {
      for await (const event of readSseEvents(body, { firstByteMs: 1_000, idleMs: 30 })) events.push(event.data);
    }, (err: unknown) => err instanceof SseStallError && /went silent/.test(err.message));
    assert.deepEqual(events, ['{"a":1}']);
  });

  it('keeps going while keep-alive comments arrive', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let ticks = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          ticks += 1;
          if (ticks < 30) controller.enqueue(encoder.encode(': ping\n\n'));
          else {
            clearInterval(timer);
            controller.enqueue(encoder.encode('data: done\n\n'));
            controller.close();
          }
        }, 10);
      },
    });
    const events: string[] = [];
    // Each ping comes 10 ms after the last; a 250 ms idle limit is never reached, however long the whole stream takes.
    for await (const event of readSseEvents(body, { firstByteMs: 250, idleMs: 250 })) events.push(event.data);
    assert.deepEqual(events, ['done']);
  });

  it('reports a failed read as SseReadError', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('network error'));
      },
    });
    await assert.rejects(async () => {
      for await (const _ of readSseEvents(body)) {
        /* never */
      }
    }, (err: unknown) => err instanceof SseReadError && err.cause instanceof TypeError);
  });
});

describe('fetchStream and transportError', () => {
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

  it('gives up when the response headers do not arrive in time', async () => {
    await assert.rejects(fetchStream(hanging, 'https://x.test', {}, 20), (err: unknown) => err instanceof SseStallError && /headers/.test(err.message));
  });

  it("keeps the caller's abort", async () => {
    const controller = new AbortController();
    const pending = fetchStream(hanging, 'https://x.test', { signal: controller.signal }, 5_000);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
  });

  it('classifies stalls and dropped connections', () => {
    const stalled = transportError(new SseStallError('idle', 90_000), { provider: 'gemini', model: 'm', label: 'Gemini (m)' });
    assert.ok(stalled instanceof LlmError && stalled.kind === 'stalled' && stalled.status === 504);
    const dropped = transportError(new SseReadError(new TypeError('terminated')), { provider: 'gemini', model: 'm', label: 'Gemini (m)' });
    assert.ok(dropped instanceof LlmError && dropped.kind === 'network' && /terminated/.test(dropped.message));
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException('aborted', 'AbortError');
    assert.equal(transportError(new SseReadError(abort), { provider: 'gemini', model: 'm', label: 'x', signal: controller.signal }), abort);
  });
});
