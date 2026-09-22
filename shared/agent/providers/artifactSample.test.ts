import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmHandlers, LlmRequest } from '../llm.js';
import { LlmError } from '../llm.js';
import {
  ArtifactSampleClient,
  assembleInput,
  fitToolSchema,
  parseToolCall,
  type SampleFunction,
  type SampleInput,
  type SampleLimits,
  type SampleMessage,
  type SampleOptions,
  type SampleResult,
} from './artifactSample.js';
import { setPdfText } from './pdfText.js';

const TOOL: Anthropic.Tool = {
  name: 'create_quiz',
  description: 'Build a quiz',
  strict: true,
  input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Quiz title' } }, required: ['title'], additionalProperties: false },
};

const FULL_LIMITS: SampleLimits = {
  maxPromptBytes: 65_536,
  tools: { maxCount: 16 },
  images: { maxCount: 2, maxInputBytes: 20_000_000, mediaTypes: ['image/png', 'image/jpeg'] },
};
const TEXT_ONLY_LIMITS: SampleLimits = { maxPromptBytes: 65_536 };

function request(extra: Partial<LlmRequest> = {}): LlmRequest {
  const pdf: Anthropic.DocumentBlockParam = { type: 'document', title: 'deck.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } };
  setPdfText(pdf, 'PDF-TEXT slide one');
  return {
    model: 'default',
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

type Handler = (input: SampleMessage[], options: SampleOptions, call: number) => Promise<SampleResult> | SampleResult;

/** A stand-in for the runtime's sample function that records every call. */
function fakeSample(handler: Handler, limits: SampleLimits = FULL_LIMITS) {
  const calls: { input: SampleInput; options: SampleOptions }[] = [];
  const fn = (async (input: SampleInput, options: SampleOptions = {}) => {
    calls.push({ input, options });
    const result = await handler(input as SampleMessage[], options, calls.length);
    // The runtime streams the whole text at least once before resolving.
    options.onText?.({ text: result.text, delta: result.text });
    return result;
  }) as SampleFunction;
  fn.json = async (input, options = {}) => {
    calls.push({ input, options });
    const result = await handler(input as SampleMessage[], options, calls.length);
    return JSON.parse(result.text);
  };
  fn.limits = async () => limits;
  return { sample: fn, calls, client: new ArtifactSampleClient({ resolve: async () => fn }) };
}

const done = (text: string, truncated = false): SampleResult => ({ text, truncated, modelTierApplied: 'default' });

describe('assembleInput', () => {
  it('puts the system prompt first, PDFs as text, images as attachments and tool round-trips as text', () => {
    const { input, images } = assembleInput(request(), FULL_LIMITS, { emulateTools: false }, 'default');
    assert.equal(images.length, 1);
    assert.equal(input[0].role, 'user');
    assert.equal(input[0].content, 'You are Kiiku.');
    assert.equal(input[1].role, 'user');
    assert.match(input[1].content, /\[deck\.pdf\]\nPDF-TEXT slide one/);
    assert.match(input[1].content, /\[Image 1: attached to this request\]/);
    assert.match(input[1].content, /Read these\./);
    assert.deepEqual(input[2], { role: 'assistant', content: 'Ready.' });
    assert.deepEqual(input[3], { role: 'user', content: 'Quiz me' });
    assert.deepEqual(input[4], { role: 'assistant', content: '{"tool":"create_quiz","input":{"title":"Q"}}' });
    assert.equal(input[5].role, 'user');
    assert.match(input[5].content, /Tool result \(create_quiz\): Quiz "Q" ready/);
    assert.match(input[5].content, /attached image is the one marked \[Image 1\]/);
    assert.equal(input[input.length - 1].role, 'user', 'the transcript ends on a user turn');
  });

  it('describes the tools and the JSON call protocol when the view has no tools', () => {
    const { input, images } = assembleInput(request(), TEXT_ONLY_LIMITS, { emulateTools: true }, 'default');
    assert.equal(images.length, 0, 'no images without image support');
    assert.match(input[0].content, /## Tools/);
    assert.match(input[0].content, /### create_quiz/);
    assert.match(input[0].content, /"tool": "<name>"/);
    assert.match(input[1].content, /\[Image: cannot be shown in this view\]/);
  });

  it('drops old chat turns and trims materials and long documents to the byte budget', () => {
    const material = 'M'.repeat(30_000);
    const guide = 'G'.repeat(20_000);
    const pdf: Anthropic.DocumentBlockParam = { type: 'document', title: 'notes.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'UERG' } };
    setPdfText(pdf, material);
    const history: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 10; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'h'.repeat(500)}` });
    const req = request({
      messages: [
        { role: 'user', content: [pdf, { type: 'text', text: 'Materials above.' }] },
        { role: 'assistant', content: 'Ready.' },
        { role: 'user', content: 'Write the guide.' },
        { role: 'assistant', content: [{ type: 'text', text: guide }] },
        ...history,
        { role: 'user', content: 'Final question' },
      ],
    });
    const { input } = assembleInput(req, { maxPromptBytes: 16_384 }, { emulateTools: false }, 'default');
    const total = input.reduce((sum, turn) => sum + Buffer.byteLength(turn.content), 0);
    assert.ok(total <= 16_384 - 1_536, `fits the budget (${total} bytes)`);
    const materials = input.find((t) => t.content.includes('[notes.pdf]'))!;
    assert.match(materials.content, /left out to fit the 64 KB request limit/);
    assert.ok(materials.content.length >= 1_500, 'a material keeps at least its head');
    const doc = input.find((t) => t.role === 'assistant' && t.content.includes('GGGG'))!;
    assert.match(doc.content, /^\[… earlier part of this document omitted/);
    assert.ok(doc.content.endsWith('G'), 'a long document keeps its tail');
    const kept = input.filter((t) => /^turn \d+/.test(t.content));
    assert.ok(kept.length <= 2 && kept.length >= 1, `old turns are dropped first (${kept.length} kept)`);
    assert.equal(input[input.length - 1].content, 'Final question');
    assert.equal(input[0].content, 'You are Kiiku.');
  });

  it('fails clearly when even the trimmed transcript cannot fit', () => {
    const req = request({ messages: [{ role: 'user', content: 'x'.repeat(20_000) }] });
    assert.throws(() => assembleInput(req, { maxPromptBytes: 8_192 }, { emulateTools: false }, 'default'), (err: unknown) => err instanceof LlmError && /too large/.test(err.message));
  });
});

describe('ArtifactSampleClient', () => {
  it('streams the text, uses the requested tier and never caches', async () => {
    const { client, calls } = fakeSample(() => done('Hello student'));
    const deltas: string[] = [];
    const message = await client.stream(request({ model: 'complex', tools: undefined }), { onText: (t) => deltas.push(t) });
    assert.equal(deltas.join(''), 'Hello student');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Hello student', citations: null }]);
    assert.equal(message.stop_reason, 'end_turn');
    assert.equal(message.provider, 'artifact');
    assert.equal(message.model, 'complex');
    assert.equal(message.ref, 'artifact/complex');
    assert.equal(calls[0].options.modelTier, 'complex');
    assert.equal(calls[0].options.cache, false);
    assert.equal(calls[0].options.tools, undefined);
    assert.equal((calls[0].options.images ?? []).length, 1);
  });

  it('runs tools inside the call through the executor and returns only the final text', async () => {
    const executed: Anthropic.ToolUseBlock[] = [];
    const { client, calls } = fakeSample(async (_input, options) => {
      const tool = options.tools!.find((t) => t.name === 'create_quiz')!;
      const result = await tool.execute({ title: 'Networks' }, { signal: new AbortController().signal });
      assert.equal(result, 'Quiz "Networks" ready');
      return done('Your quiz is ready in the Quiz tab.');
    });
    const handlers: LlmHandlers = {
      executeTool: async (block) => {
        executed.push(block);
        return { type: 'tool_result', tool_use_id: block.id, content: `Quiz "${String((block.input as { title: string }).title)}" ready` };
      },
    };
    const message = await client.stream(request(), handlers);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].name, 'create_quiz');
    assert.deepEqual(executed[0].input, { title: 'Networks' });
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Your quiz is ready in the Quiz tab.', citations: null }]);
    const tools = calls[0].options.tools!;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].description, 'Build a quiz');
    assert.deepEqual(tools[0].inputSchema, TOOL.input_schema);
  });

  it('reports tool errors back to the model by throwing from execute', async () => {
    const { client } = fakeSample(async (_input, options) => {
      await assert.rejects(Promise.resolve(options.tools![0].execute({}, { signal: new AbortController().signal })), /Invalid input/);
      return done('Sorry, that failed.');
    });
    const message = await client.stream(request(), {
      executeTool: async (block) => ({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Invalid input: title missing' }),
    });
    assert.equal(message.stop_reason, 'end_turn');
  });

  it('records tool calls as tool_use blocks when the caller executes them itself', async () => {
    const { client } = fakeSample(async (_input, options) => {
      const reply = await options.tools![0].execute({ title: 'TCP' }, { signal: new AbortController().signal });
      assert.match(String(reply), /app runs this tool after your reply/);
      return done('Here is your quiz.');
    });
    const started: string[] = [];
    const message = await client.stream(request(), { onToolStart: (name) => started.push(name) });
    assert.deepEqual(started, ['create_quiz']);
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.content[0].type, 'text');
    const call = message.content[1] as Anthropic.ToolUseBlock;
    assert.equal(call.type, 'tool_use');
    assert.equal(call.name, 'create_quiz');
    assert.deepEqual(call.input, { title: 'TCP' });
    assert.match(call.id, /^toolu_/);
  });

  it('emulates tools with the JSON protocol when the view has none, hiding the call from the UI', async () => {
    const { client, calls } = fakeSample((input, options, call) => {
      assert.equal(options.tools, undefined);
      if (call === 1) return done('```json\n{"tool":"create_quiz","input":{"title":"UDP"}}\n```');
      const last = input[input.length - 1];
      assert.match(last.content, /^Tool result \(create_quiz\): Quiz "UDP" ready/);
      assert.equal(input[input.length - 2].role, 'assistant');
      return done('Done — take the quiz now.');
    }, TEXT_ONLY_LIMITS);
    const deltas: string[] = [];
    const executed: string[] = [];
    const message = await client.stream(request(), {
      onText: (t) => deltas.push(t),
      executeTool: async (block) => {
        executed.push(block.name);
        return { type: 'tool_result', tool_use_id: block.id, content: 'Quiz "UDP" ready' };
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(executed, ['create_quiz']);
    assert.equal(deltas.join(''), 'Done — take the quiz now.');
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Done — take the quiz now.', citations: null }]);
  });

  it('returns an emulated tool call as a tool_use block when there is no executor', async () => {
    const { client } = fakeSample(() => done('{"tool":"create_quiz","input":{"title":"IP"}}'), TEXT_ONLY_LIMITS);
    const deltas: string[] = [];
    const message = await client.stream(request(), { onText: (t) => deltas.push(t) });
    assert.deepEqual(deltas, [], 'the JSON never reaches the UI');
    assert.equal(message.stop_reason, 'tool_use');
    assert.equal(message.content.length, 1);
    assert.deepEqual((message.content[0] as Anthropic.ToolUseBlock).input, { title: 'IP' });
  });

  it('answers JSON output requests through sample.json', async () => {
    const { client, calls } = fakeSample((input) => {
      assert.match(input[0].content, /matches this JSON schema/);
      return done('{"correct":true,"score":90,"feedback":"Good"}');
    });
    const schema = { type: 'object', properties: { correct: { type: 'boolean' } } };
    const message = await client.stream({ ...request({ tools: undefined }), outputSchema: { name: 'grade', schema } }, {});
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse((message.content[0] as Anthropic.TextBlock).text), { correct: true, score: 90, feedback: 'Good' });
  });

  it('maps truncation, refusal, empty answers and runtime errors', async () => {
    const truncated = await fakeSample(() => done('Half a guide', true)).client.stream(request({ tools: undefined }), {});
    assert.equal(truncated.stop_reason, 'max_tokens');

    const refused = await fakeSample(() => Promise.reject({ code: 'refused', message: 'No.' })).client.stream(request({ tools: undefined }), {});
    assert.equal(refused.stop_reason, 'refusal');
    assert.equal(refused.stop_details?.explanation, 'No.');

    const empty = await fakeSample(() => Promise.reject({ code: 'empty_completion', message: '' })).client.stream(request({ tools: undefined }), {});
    assert.deepEqual(empty.content, []);

    await assert.rejects(
      fakeSample(() => Promise.reject({ code: 'rate_limited', message: 'slow down' })).client.stream(request({ tools: undefined }), {}),
      (err: unknown) => err instanceof LlmError && err.status === 429 && /usage limit/.test(err.message),
    );
    await assert.rejects(
      fakeSample(() => Promise.reject({ code: 'not_granted', message: 'denied' })).client.stream(request({ tools: undefined }), {}),
      (err: unknown) => err instanceof LlmError && /allow it to use Claude/.test(err.message),
    );
    const unavailable = new ArtifactSampleClient({ resolve: async () => null });
    await assert.rejects(unavailable.stream(request({ tools: undefined }), {}), (err: unknown) => err instanceof LlmError && /not available in this view/.test(err.message));
  });
});

describe('tool helpers', () => {
  it('parses protocol calls with or without a code fence and rejects prose', () => {
    assert.deepEqual(parseToolCall('{"tool":"create_quiz","input":{"title":"Q"}}'), { name: 'create_quiz', input: { title: 'Q' } });
    assert.deepEqual(parseToolCall('```json\n{"tool":"x"}\n```'), { name: 'x', input: {} });
    assert.equal(parseToolCall('Here is the quiz: {"tool":"x"}'), null);
    assert.equal(parseToolCall('{"title":"no tool key"}'), null);
  });

  it('keeps tool schemas under 4 KB by dropping descriptions', () => {
    const big = {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          description: 'top',
          items: { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: 'string', description: 'x'.repeat(120) }])) },
        },
      },
      required: ['items'],
    };
    const fitted = fitToolSchema(big)!;
    assert.ok(JSON.stringify(fitted).length <= 4_096);
    assert.deepEqual(Object.keys((fitted.properties as any).items.items.properties).length, 40, 'fields survive');
    assert.equal(fitToolSchema(TOOL.input_schema), TOOL.input_schema, 'small schemas pass through untouched');
  });
});
