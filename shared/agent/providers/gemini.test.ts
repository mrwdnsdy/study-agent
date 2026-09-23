import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError, isTransient, type LlmRequest } from '../llm.js';
import { GeminiClient, geminiErrorInfo, mapFinish } from './gemini.js';

const request: LlmRequest = { model: 'gemini-3.8-flash', system: 's', messages: [{ role: 'user', content: 'Write the guide' }], maxTokens: 1000, effort: 'medium' };

function sse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const textChunk = (text: string, finishReason?: string) => ({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] });

function client(respond: () => Response | Promise<Response>, stall?: { firstByteMs?: number; idleMs?: number }): GeminiClient {
  return new GeminiClient({ baseUrl: 'https://proxy.test/gemini', fetch: async () => respond(), stall });
}

const quotaBody = (quotaId: string, retryDelay = '23s') =>
  JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
        { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  });

describe('Gemini mapFinish', () => {
  it('maps every finish reason', () => {
    const table: [string | undefined, boolean, string, string | undefined][] = [
      ['STOP', false, 'end_turn', undefined],
      ['STOP', true, 'tool_use', undefined],
      ['MAX_TOKENS', false, 'max_tokens', undefined],
      ['RECITATION', false, 'pause_turn', 'recitation'],
      ['OTHER', false, 'pause_turn', 'interrupted'],
      ['FINISH_REASON_UNSPECIFIED', false, 'pause_turn', 'interrupted'],
      ['MALFORMED_FUNCTION_CALL', false, 'pause_turn', 'interrupted'],
      ['UNEXPECTED_TOOL_CALL', false, 'pause_turn', 'interrupted'],
      ['TOO_MANY_TOOL_CALLS', false, 'pause_turn', 'interrupted'],
      ['LANGUAGE', false, 'pause_turn', 'interrupted'],
      ['SOMETHING_NEW', false, 'pause_turn', 'interrupted'],
      [undefined, false, 'pause_turn', 'interrupted'],
    ];
    for (const [reason, hasToolUse, stop, explanation] of table) {
      assert.deepEqual(mapFinish(reason, hasToolUse, true), explanation ? { stop, explanation } : { stop }, String(reason));
    }
    for (const reason of ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) {
      assert.equal(mapFinish(reason, false, true).stop, 'refusal', reason);
    }
    assert.deepEqual(mapFinish(undefined, false, false), { stop: 'end_turn' }, 'an empty stream is not a cut-off answer');
  });

  it("reports an answer that ends without a finish reason as pause_turn 'interrupted'", async () => {
    const message = await client(() => sse([textChunk('# Guide\n'), textChunk('Half of it')])).stream(request, {});
    assert.equal(message.stop_reason, 'pause_turn');
    assert.deepEqual(message.stop_details, { explanation: 'interrupted' });
    const done = await client(() => sse([textChunk('# Guide\n'), textChunk('All of it.', 'STOP')])).stream(request, {});
    assert.equal(done.stop_reason, 'end_turn');
  });

  it('turns RECITATION into a continuation instead of a refusal', async () => {
    const message = await client(() => sse([textChunk('Quoted', 'RECITATION')])).stream(request, {});
    assert.equal(message.stop_reason, 'pause_turn');
    assert.deepEqual(message.stop_details, { explanation: 'recitation' });
  });

  it('keeps a blocked prompt a refusal', async () => {
    const message = await client(() => sse([{ promptFeedback: { blockReason: 'SAFETY' } }])).stream(request, {});
    assert.equal(message.stop_reason, 'refusal');
  });
});

describe('Gemini errors', () => {
  it('reads RetryInfo "23s" as 23000 ms on a rate limit', async () => {
    const perMinute = quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
    await assert.rejects(client(() => new Response(perMinute, { status: 429 })).stream(request, {}), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.kind, 'rate_limit');
      assert.equal(err.retryAfterMs, 23_000);
      assert.equal(err.status, 429);
      assert.equal(err.message, 'Gemini (gemini-3.8-flash): You exceeded your current quota. (RESOURCE_EXHAUSTED)');
      assert.ok(isTransient(err));
      return true;
    });
    assert.equal(geminiErrorInfo(429, JSON.parse(quotaBody('x', '1.5s')).error).retryAfterMs, 1_500);
  });

  it('detects the daily free-tier quota, which is not worth retrying', async () => {
    const perDay = quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
    await assert.rejects(client(() => new Response(perDay, { status: 429 })).stream(request, {}), (err: unknown) => {
      assert.ok(err instanceof LlmError && err.kind === 'daily_quota');
      assert.equal(isTransient(err), false);
      return true;
    });
  });

  it('classifies statuses and honours a Retry-After header', () => {
    assert.deepEqual(geminiErrorInfo(503, { code: 503, message: 'overloaded' }), { kind: 'overloaded', retryAfterMs: undefined });
    assert.deepEqual(geminiErrorInfo(500, null, '7'), { kind: 'overloaded', retryAfterMs: 7_000 });
    assert.deepEqual(geminiErrorInfo(400, { message: 'bad' }), { kind: undefined, retryAfterMs: undefined });
  });

  it('classifies an error chunk in the middle of the stream', async () => {
    const chunks = [textChunk('# Guide\n'), { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }];
    const text: string[] = [];
    await assert.rejects(client(() => sse(chunks)).stream(request, { onText: (t) => text.push(t) }), (err: unknown) => {
      assert.ok(err instanceof LlmError && err.kind === 'overloaded' && err.status === 503);
      assert.equal(err.message, 'Gemini (gemini-3.8-flash): The model is overloaded.');
      return true;
    });
    assert.deepEqual(text, ['# Guide\n']);
  });

  it('turns fetch failures and dropped streams into network errors, and silence into a stall', async () => {
    await assert.rejects(
      client(() => Promise.reject(new TypeError('Failed to fetch'))).stream(request, {}),
      (err: unknown) => err instanceof LlmError && err.kind === 'network' && isTransient(err),
    );
    const dropped = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(textChunk('# Guide\n'))}\n\n`));
      },
      pull(controller) {
        controller.error(new TypeError('network error'));
      },
    });
    await assert.rejects(client(() => new Response(dropped)).stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === 'network');
    const silent = new ReadableStream<Uint8Array>();
    await assert.rejects(
      client(() => new Response(silent), { firstByteMs: 30 }).stream(request, {}),
      (err: unknown) => err instanceof LlmError && err.kind === 'stalled' && err.status === 504,
    );
  });

  it('keeps the abort error when the request is stopped', async () => {
    const controller = new AbortController();
    const gemini = new GeminiClient({
      baseUrl: 'https://proxy.test/gemini',
      fetch: (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    const pending = gemini.stream(request, {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, (err: unknown) => err instanceof DOMException && err.name === 'AbortError');
  });
});
