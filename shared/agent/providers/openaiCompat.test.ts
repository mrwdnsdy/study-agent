import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError, isTransient, type LlmRequest } from '../llm.js';
import { CAPABILITIES, OpenAICompatClient } from './openaiCompat.js';

const request: LlmRequest = { model: 'qwen/qwen3.8-27b:free', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, effort: 'low' };

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const delta = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

function client(respond: () => Response | Promise<Response>): OpenAICompatClient {
  return new OpenAICompatClient({ provider: 'openrouter', baseUrl: 'https://proxy.test/openrouter/v1', capabilities: CAPABILITIES.openrouter, fetch: async () => respond() });
}

describe('OpenAICompatClient resilience', () => {
  it("reports a stream that ends without [DONE] or a finish_reason as pause_turn 'interrupted'", async () => {
    const cut = await client(() => sse([delta('Hello '), delta('wor')])).stream(request, {});
    assert.equal(cut.stop_reason, 'pause_turn');
    assert.deepEqual(cut.stop_details, { explanation: 'interrupted' });
    const finished = await client(() => sse([delta('Hello '), delta('world', 'stop')])).stream(request, {});
    assert.equal(finished.stop_reason, 'end_turn', 'a finish_reason is enough, even without [DONE]');
    const done = await client(() => sse([delta('Hello'), 'data: [DONE]\n\n'])).stream(request, {});
    assert.equal(done.stop_reason, 'end_turn');
  });

  it('classifies HTTP statuses and reads Retry-After', async () => {
    await assert.rejects(
      client(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '12' } })).stream(request, {}),
      (err: unknown) => err instanceof LlmError && err.kind === 'rate_limit' && err.retryAfterMs === 12_000 && /Rate limit exceeded/.test(err.message),
    );
    await assert.rejects(client(() => new Response('upstream down', { status: 502 })).stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === 'overloaded');
    await assert.rejects(client(() => new Response('nope', { status: 401 })).stream(request, {}), (err: unknown) => err instanceof LlmError && !isTransient(err));
  });

  it('turns connection failures into network errors', async () => {
    await assert.rejects(client(() => Promise.reject(new TypeError('fetch failed'))).stream(request, {}), (err: unknown) => err instanceof LlmError && err.kind === 'network');
  });
});
