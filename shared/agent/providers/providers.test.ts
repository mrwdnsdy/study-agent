import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmMessage, LlmRequest } from '../llm.js';
import { LlmError, emptyLlmUsage, extractJsonObject } from '../llm.js';
import { ChainLlmClient } from './chain.js';
import { GeminiClient, buildGeminiBody } from './gemini.js';
import { CAPABILITIES, OpenAICompatClient, buildChatBody } from './openaiCompat.js';
import { setPdfText } from './pdfText.js';
import { readSseEvents } from './sse.js';

const TOOL: Anthropic.Tool = {
  name: 'create_quiz',
  description: 'Build a quiz',
  strict: true,
  input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
};

function request(extra: Partial<LlmRequest> = {}): LlmRequest {
  const pdf: Anthropic.DocumentBlockParam = { type: 'document', title: 'deck.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } };
  setPdfText(pdf, 'PDF-TEXT slide one');
  return {
    model: 'gemini-3.8-flash',
    system: 'You are Kiiku.',
    messages: [
      {
        role: 'user',
        content: [
          pdf,
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } },
          { type: 'text', text: 'Read these.', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
      },
      { role: 'assistant', content: 'Ready.' },
      { role: 'user', content: 'Quiz me' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'create_quiz', input: { title: 'Q' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Quiz "Q" ready' }] },
    ],
    tools: [TOOL],
    maxTokens: 70_000,
    effort: 'high',
    showThinking: true,
    ...extra,
  };
}

describe('buildGeminiBody', () => {
  it('maps system, PDF, image, tools, thinking and tool round-trips', () => {
    const body = buildGeminiBody(request(), 'gemini-3.8-flash') as Record<string, any>;
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'You are Kiiku.' }] });
    const [first, ready, quiz, call, result] = body.contents;
    assert.equal(first.role, 'user');
    assert.deepEqual(first.parts[0], { inlineData: { mimeType: 'application/pdf', data: 'UERG' } });
    assert.deepEqual(first.parts[1], { inlineData: { mimeType: 'image/png', data: 'aW1n' } });
    assert.deepEqual(first.parts[2], { text: 'Read these.' });
    assert.deepEqual(ready, { role: 'model', parts: [{ text: 'Ready.' }] });
    assert.deepEqual(quiz, { role: 'user', parts: [{ text: 'Quiz me' }] });
    assert.deepEqual(call, { role: 'model', parts: [{ functionCall: { name: 'create_quiz', args: { title: 'Q' } } }] });
    assert.deepEqual(result, { role: 'user', parts: [{ functionResponse: { name: 'create_quiz', response: { result: 'Quiz "Q" ready' } } }] });
    assert.equal(body.generationConfig.maxOutputTokens, 65_536, 'capped at the Gemini maximum');
    assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'medium' });
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'create_quiz', description: 'Build a quiz', parametersJsonSchema: TOOL.input_schema }] }]);
    assert.equal(body.safetySettings.length, 4);
  });

  it('uses a token budget on Gemini 2.5 and JSON schema output without tools', () => {
    const body = buildGeminiBody(request({ outputSchema: { name: 'grade', schema: { type: 'object' } }, effort: 'low' }), 'gemini-2.5-flash') as Record<string, any>;
    assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 1024 });
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(body.generationConfig.responseJsonSchema, { type: 'object' });
    assert.equal(body.tools, undefined);
  });
});

describe('buildChatBody', () => {
  it('sends the PDF through the OpenRouter file parser and maps tool calls and results', () => {
    const body = buildChatBody(request(), 'qwen/qwen3.8-27b:free', CAPABILITIES.openrouter) as Record<string, any>;
    assert.equal(body.model, 'qwen/qwen3.8-27b:free');
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, 'system');
    const user = body.messages[1];
    assert.equal(user.content[0].type, 'file');
    assert.equal(user.content[0].file.filename, 'deck.pdf');
    assert.equal(user.content[1].type, 'image_url');
    assert.match(user.content[1].image_url.url, /^data:image\/png;base64,aW1n$/);
    assert.deepEqual(body.messages[2], { role: 'assistant', content: 'Ready.' });
    assert.deepEqual(body.messages[4], { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_quiz', arguments: '{"title":"Q"}' } }] });
    assert.deepEqual(body.messages[5], { role: 'tool', tool_call_id: 'call_1', content: 'Quiz "Q" ready' });
    assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'create_quiz', description: 'Build a quiz', parameters: TOOL.input_schema } });
    assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }]);
    assert.deepEqual(body.reasoning, { effort: 'medium', exclude: false });
  });

  it('falls back to extracted PDF text and json_object mode on endpoints without schema support', () => {
    const body = buildChatBody(request({ outputSchema: { name: 'grade', schema: { type: 'object' } } }), 'glm-4.7-flash', CAPABILITIES.zai) as Record<string, any>;
    assert.match(body.messages[0].content, /Respond with a single JSON object/);
    assert.equal(body.messages[1].content[0].type, 'text');
    assert.match(body.messages[1].content[0].text, /PDF-TEXT slide one/);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined, 'no tools with structured output');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.plugins, undefined);
  });
});

function sseResponse(events: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

describe('readSseEvents', () => {
  it('splits events across chunk boundaries and ignores comments', async () => {
    const response = sseResponse([': keep-alive\n\ndata: {"a":1}\n\nda', 'ta: {"b":2}\r\n\r\nevent: done\ndata: x\n\n']);
    const events = [];
    for await (const event of readSseEvents(response.body!)) events.push(event);
    assert.deepEqual(events, [{ event: undefined, data: '{"a":1}' }, { event: undefined, data: '{"b":2}' }, { event: 'done', data: 'x' }]);
  });
});

describe('GeminiClient', () => {
  it('folds a streamed answer with thoughts, text, a function call and usage into content blocks', async () => {
    const chunks = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Planning.', thought: true }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello ' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'world', thoughtSignature: 'sig-text' }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'create_quiz', args: { title: 'Q' } }, thoughtSignature: 'sig-call' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } })}\n\n`,
    ];
    const seen: string[] = [];
    const client = new GeminiClient({
      baseUrl: 'https://proxy.test/gemini',
      headers: { 'x-access-code': 'c' },
      fetch: async (url, init) => {
        seen.push(String(url), (init?.headers as Record<string, string>)['x-access-code']);
        return sseResponse(chunks);
      },
    });
    const text: string[] = [];
    const thinking: string[] = [];
    const tools: string[] = [];
    const message = await client.stream(request(), { onText: (t) => text.push(t), onThinking: (t) => thinking.push(t), onToolStart: (n) => tools.push(n) });
    assert.equal(seen[0], 'https://proxy.test/gemini/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    assert.equal(seen[1], 'c');
    assert.deepEqual(text, ['Hello ', 'world']);
    assert.deepEqual(thinking, ['Planning.']);
    assert.deepEqual(tools, ['create_quiz']);
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.provider, 'gemini');
    assert.equal(message.content[0].type, 'thinking');
    assert.equal(message.content[1].type, 'text');
    const call = message.content[2];
    assert.equal(call.type, 'tool_use');
    assert.deepEqual(call.type === 'tool_use' ? call.input : null, { title: 'Q' });
    assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

    // The signature comes back when the assistant turn is replayed.
    const body = buildGeminiBody({ ...request(), messages: [{ role: 'assistant', content: message.content }] }, 'gemini-3.8-flash') as Record<string, any>;
    const parts = body.contents[0].parts;
    assert.deepEqual(parts[0], { text: 'Hello world', thoughtSignature: 'sig-text' });
    assert.deepEqual(parts[1], { functionCall: { name: 'create_quiz', args: { title: 'Q' } }, thoughtSignature: 'sig-call' });
  });

  it('turns HTTP errors into LlmError with the status', async () => {
    const client = new GeminiClient({
      baseUrl: 'https://proxy.test/gemini',
      fetch: async () => new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }),
    });
    await assert.rejects(client.stream(request(), {}), (err: unknown) => err instanceof LlmError && err.status === 429 && /exhausted/.test(err.message));
  });
});

describe('OpenAICompatClient', () => {
  it('accumulates streamed tool-call arguments and reasoning', async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    const chunks = [
      chunk({ reasoning: 'Thinking.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'create_quiz', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"title":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Q"}' } }] }, 'tool_calls', { prompt_tokens: 7, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }),
      'data: [DONE]\n\n',
    ];
    const client = new OpenAICompatClient({ provider: 'openrouter', baseUrl: 'https://proxy.test/openrouter/v1', capabilities: CAPABILITIES.openrouter, fetch: async () => sseResponse(chunks) });
    const message = await client.stream(request(), {});
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.content[0].type, 'thinking');
    const call = message.content[1];
    assert.ok(call.type === 'tool_use' && call.id === 'call_9' && call.name === 'create_quiz');
    assert.deepEqual(call.type === 'tool_use' ? call.input : null, { title: 'Q' });
    assert.deepEqual(message.usage, { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 });
  });
});

describe('ChainLlmClient', () => {
  const answer = (model: string, text = 'ok'): LlmMessage => ({
    provider: 'gemini',
    model,
    ref: model,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    usage: emptyLlmUsage(),
  });
  const fake = (behaviour: (model: string, handlers: Parameters<LlmClient['stream']>[1]) => Promise<LlmMessage>): LlmClient => ({
    stream: (req, handlers) => behaviour(String(req.model), handlers),
  });

  it('falls through failures and unconfigured providers before any output, reporting each switch', async () => {
    const calls: string[] = [];
    const switches: string[] = [];
    const chain = new ChainLlmClient((provider) => {
      if (provider === 'zai') return null;
      return fake(async (model) => {
        calls.push(`${provider}:${model}`);
        if (model.startsWith('gemini-3.8')) throw new LlmError('429 quota', { provider: 'gemini', model, status: 429 });
        if (model.startsWith('gemini-3.5')) throw new Error('network down');
        return answer(model);
      });
    });
    const message = await chain.stream(
      { ...request(), model: ['gemini/gemini-3.8-flash', 'gemini/gemini-3.5-flash-lite', 'zai/glm-4.7-flash', 'openrouter/qwen/qwen3.8-27b:free'] },
      { onModelSwitch: (info) => switches.push(`${info.from}→${info.to}`) },
    );
    assert.deepEqual(calls, ['gemini:gemini-3.8-flash', 'gemini:gemini-3.5-flash-lite', 'openrouter:qwen/qwen3.8-27b:free']);
    assert.deepEqual(switches, [
      'gemini/gemini-3.8-flash→gemini/gemini-3.5-flash-lite',
      'gemini/gemini-3.5-flash-lite→zai/glm-4.7-flash',
      'zai/glm-4.7-flash→openrouter/qwen/qwen3.8-27b:free',
    ]);
    assert.equal(message.ref, 'openrouter/qwen/qwen3.8-27b:free');
  });

  it('does not fall back once output has started, and aggregates errors when every model fails', async () => {
    const chain = new ChainLlmClient(() =>
      fake(async (model, handlers) => {
        if (model === 'a') {
          handlers.onText?.('partial');
          throw new Error('cut off');
        }
        throw new Error(`no ${model}`);
      }),
    );
    await assert.rejects(chain.stream({ ...request(), model: ['gemini/a', 'gemini/b'] }, {}), /cut off/);
    await assert.rejects(chain.stream({ ...request(), model: ['gemini/b', 'gemini/c'] }, {}), (err: unknown) => err instanceof LlmError && /gemini\/b: no b · gemini\/c: no c/.test(err.message));
  });
});

describe('extractJsonObject', () => {
  it('finds the object inside fences and prose', () => {
    assert.equal(extractJsonObject('Sure:\n```json\n{"a": 1}\n```'), '{"a": 1}');
    assert.equal(extractJsonObject('Result {"a":{"b":2}} done'), '{"a":{"b":2}}');
    assert.equal(extractJsonObject('nothing'), null);
  });
});

describe('ChainLlmClient in-call tools', () => {
  it('forwards executeTool to the adapter and does not fall back once a tool has run', async () => {
    const executed: string[] = [];
    let calls = 0;
    const client: LlmClient = {
      async stream(_request, handlers) {
        calls += 1;
        await handlers.executeTool?.({ type: 'tool_use', id: 't1', name: 'create_quiz', input: { title: 'Q' } } as Anthropic.ToolUseBlock);
        throw new LlmError('boom', { provider: 'artifact', model: 'default' });
      },
    };
    const chain = new ChainLlmClient(() => client);
    await assert.rejects(
      chain.stream(
        { ...request(), model: ['artifact/default', 'artifact/quick'] },
        { executeTool: async (block) => { executed.push(block.name); return { type: 'tool_result', tool_use_id: block.id, content: 'ok' }; } },
      ),
      /boom/,
    );
    assert.deepEqual(executed, ['create_quiz']);
    assert.equal(calls, 1, 'the second model is not tried after a tool ran');
  });
});
