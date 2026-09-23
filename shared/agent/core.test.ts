import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { Quiz, StreamEvent, StudyGuide, TaskModels } from '../types.js';
import {
  PartialDocumentError,
  PartialReplyError,
  continueDocument,
  describeError,
  generateGuide,
  generateReview,
  runChat,
  type AgentContext,
  type ChatHooks,
  type MaterialsInput,
} from './core.js';
import { LlmError, emptyLlmUsage, type LlmClient, type LlmMessage, type LlmRequest, type StopReason } from './llm.js';
import { ChainLlmClient } from './providers/chain.js';
import { GeminiClient } from './providers/gemini.js';

/** One scripted answer: stream `text`, then throw `error` or finish with `stop`. */
interface Step {
  /** The model reference that answers (default: the first model of the request). */
  ref?: string;
  text?: string[];
  stop?: StopReason;
  explanation?: string;
  tools?: Anthropic.ToolUseBlock[];
  /** Runs after the text, e.g. to press Stop. */
  after?: () => void;
  error?: unknown;
}

function scripted(steps: Step[]): { llm: LlmClient; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async stream(request, handlers) {
      // runChat keeps appending to one messages array, so keep a copy of what this request carried.
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps.shift();
      if (!step) throw new Error('unexpected request');
      const text = (step.text ?? []).join('');
      for (const delta of step.text ?? []) handlers.onText?.(delta);
      step.after?.();
      if (step.error) throw step.error;
      const ref = step.ref ?? (Array.isArray(request.model) ? request.model[0] : request.model);
      const content: Anthropic.ContentBlock[] = text ? [{ type: 'text', text, citations: null }] : [];
      content.push(...(step.tools ?? []));
      const message: LlmMessage = {
        provider: 'gemini',
        model: ref,
        ref,
        content,
        stop_reason: step.stop ?? 'end_turn',
        stop_details: step.explanation ? { explanation: step.explanation } : null,
        usage: emptyLlmUsage(),
      };
      return message;
    },
  };
  return { llm, requests };
}

const CHAIN = ['gemini/a', 'gemini/b', 'gemini/c'];
const MODELS: TaskModels = { guide: CHAIN, chat: CHAIN, quiz: CHAIN, grading: CHAIN, review: CHAIN };
const MATERIALS: MaterialsInput = { info: [{ name: 'deck.pdf', kind: 'pdf', summary: '3 slides' }], blocks: [{ type: 'text', text: 'Slide 1: TCP' }] };

function setup(steps: Step[], extra: Partial<AgentContext> = {}) {
  const { llm, requests } = scripted(steps);
  const waits: number[] = [];
  const events: StreamEvent[] = [];
  const ctx: AgentContext = {
    llm,
    models: MODELS,
    effort: 'medium',
    agentName: 'Kiiku',
    showModels: false,
    sleep: async (ms) => void waits.push(ms),
    ...extra,
  };
  return { ctx, requests, waits, events, send: (event: StreamEvent) => void events.push(event) };
}

/** What the page shows: deltas appended, `draft` events replacing the text. */
function pageText(events: StreamEvent[], delta: 'guide_delta' | 'text'): string {
  let shown = '';
  for (const event of events) {
    if (event.type === delta) shown += event.text;
    else if (event.type === 'draft') shown = event.text;
  }
  return shown;
}

function statuses(events: StreamEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'status' ? [e.text] : []));
}

function lastUserText(request: LlmRequest): string {
  const last = request.messages[request.messages.length - 1];
  assert.equal(last.role, 'user');
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

const overloaded = () => new LlmError('Gemini (gemini-3.8-flash): The model is overloaded. (UNAVAILABLE)', { provider: 'gemini', model: 'a', status: 503, kind: 'overloaded' });
const INTRO = '# TCP Study Guide\n\nThe introduction explains the whole module in order.\n';

describe('streamDocument (through generateGuide)', () => {
  it('resumes after a mid-stream 503 with the full document, no duplicated overlap, a status and a draft event', async () => {
    const t = setup([
      { text: [INTRO, 'Second paragraph that gets cu'], error: overloaded() },
      { text: ['Okay, continuing.\n', 'The introduction explains the whole module in order.\n', 'Second paragraph, now complete.\n'] },
    ]);
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send });
    assert.equal(result.markdown, `${INTRO}Second paragraph, now complete.\n`);
    assert.equal(pageText(t.events, 'guide_delta'), result.markdown, 'the saved guide is exactly what the page showed');
    assert.deepEqual(
      t.events.filter((e) => e.type === 'draft'),
      [{ type: 'draft', target: 'guide', text: INTRO }],
    );
    assert.deepEqual(t.waits, [2_000]);
    const lines = statuses(t.events);
    assert.ok(lines.includes('Connection hiccup — Kiiku will pick up where it left off in 2 s…'), lines.join(' | '));
    assert.ok(lines.includes('Picking up where Kiiku left off…'));
    assert.ok(lines.every((line) => !/gemini|overloaded/i.test(line)), 'white-label status lines name no model');
    // The resume continues the draft on the model that wrote it.
    const resume = t.requests[1];
    assert.deepEqual(resume.model, CHAIN);
    assert.deepEqual(resume.messages[resume.messages.length - 2], { role: 'assistant', content: INTRO });
    assert.match(lastUserText(resume), /interrupted by a connection problem\. It ended with:\n«….*whole module in order\.\n»/s);
  });

  it('clears the waiting message once the words flow again', async () => {
    const t = setup([
      { text: [INTRO, 'Second paragraph that gets cu'], error: overloaded() },
      { text: ['Second paragraph, now complete.\n'] },
    ]);
    await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send });
    const lines = statuses(t.events);
    const resumed = lines.lastIndexOf('Picking up where Kiiku left off…');
    assert.ok(resumed >= 0, lines.join(' | '));
    assert.equal(lines.at(-1), '', `the last status is cleared: ${lines.join(' | ')}`);
    assert.ok(lines.indexOf('', resumed) > resumed, 'cleared after the resume message');
  });

  it('continues after RECITATION with the recitation prompt', async () => {
    const t = setup([
      { text: [INTRO, 'Slide 2 says, word for word:\n'], stop: 'pause_turn', explanation: 'recitation' },
      { text: ['In other words, the handshake takes three steps.\n'] },
    ]);
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send });
    assert.match(lastUserText(t.requests[1]), /reproducing the source material too closely.*«…/s);
    assert.match(result.markdown, /three steps\.\n$/);
    assert.deepEqual(t.waits, [], 'a continuation that is not a failure does not wait');
  });

  it("continues a pause_turn 'interrupted' answer instead of treating it as complete", async () => {
    const t = setup([
      { text: [INTRO], stop: 'pause_turn', explanation: 'interrupted' },
      { text: ['## Glossary\n'] },
    ]);
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send });
    assert.equal(t.requests.length, 2);
    assert.match(lastUserText(t.requests[1]), /interrupted by a connection problem/);
    assert.equal(result.markdown, `${INTRO}## Glossary\n`);
  });

  it('throws PartialDocumentError("stopped") with the text when the student presses Stop', async () => {
    const controller = new AbortController();
    const t = setup([{ text: [INTRO, 'Half a sen'], after: () => controller.abort(), error: new DOMException('aborted', 'AbortError') }]);
    await assert.rejects(
      generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send, signal: controller.signal }),
      (err: unknown) => err instanceof PartialDocumentError && err.reason === 'stopped' && err.markdown === `${INTRO}Half a sen` && err.stoppedReason === 'stopped by you',
    );
  });

  it('throws PartialDocumentError with the text once the resumes are used up', async () => {
    const t = setup([{ text: [INTRO], error: overloaded() }, { error: overloaded() }, { error: overloaded() }, { error: overloaded() }]);
    await assert.rejects(
      generateGuide(t.ctx, { materials: MATERIALS, prompt: 'Make a guide', send: t.send }),
      (err: unknown) => err instanceof PartialDocumentError && err.reason === 'interrupted' && err.markdown === INTRO && err.cause instanceof LlmError,
    );
    assert.deepEqual(t.waits, [2_000, 6_000, 15_000]);
    assert.equal(t.requests.length, 4);
  });

  it('keeps the text of a non-transient failure, and rethrows errors that come before any text', async () => {
    const badRequest = new LlmError('Gemini (a): invalid argument', { provider: 'gemini', model: 'a', status: 400 });
    const t = setup([{ text: [INTRO], error: badRequest }]);
    await assert.rejects(generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send }), (err: unknown) => err instanceof PartialDocumentError && err.reason === 'failed');
    const before = setup([{ error: overloaded() }]);
    await assert.rejects(generateGuide(before.ctx, { materials: MATERIALS, prompt: 'x', send: before.send }), (err: unknown) => err instanceof LlmError && err.status === 503);
    assert.deepEqual(before.waits, []);
  });

  it('saves the text of a refusal that comes after some of the document', async () => {
    const t = setup([{ text: [INTRO], stop: 'refusal', explanation: 'Gemini stopped the response (SAFETY).' }]);
    await assert.rejects(
      generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send }),
      (err: unknown) => err instanceof PartialDocumentError && err.reason === 'refused' && err.markdown === INTRO,
    );
  });

  it('cuts an unclosed diagram fence before continuing past the length limit', async () => {
    const t = setup([
      { text: ['# T\n\nIntro.\n\n```mermaid\nflowchart TD\n  A["Start"] --> B'], stop: 'max_tokens' },
      { text: ['```mermaid\nflowchart TD\n  A["Start"] --> B["End"]\n```\n\nDone.\n'] },
    ]);
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send });
    assert.deepEqual(t.events.find((e) => e.type === 'draft'), { type: 'draft', target: 'guide', text: '# T\n\nIntro.\n\n' });
    assert.equal(result.markdown, '# T\n\nIntro.\n\n```mermaid\nflowchart TD\n  A["Start"] --> B["End"]\n```\n\nDone.\n');
    assert.match(lastUserText(t.requests[1]), /cut off by the length limit/);
  });

  it('sends documents without tools', async () => {
    const t = setup([{ text: [INTRO] }]);
    await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send });
    assert.equal(t.requests[0].tools, undefined);
    const quiz: Quiz = { id: 'q', title: 'Q', createdAt: '', config: { numQuestions: 3, difficulty: 'mixed', types: [] }, questions: [], answers: [], status: 'completed' };
    const review = setup([{ text: ['# Post-quiz review — Q\n'] }]);
    const result = await generateReview(review.ctx, { materials: MATERIALS, guide: null, quiz, send: review.send });
    assert.equal(review.requests[0].tools, undefined);
    assert.equal(pageText(review.events, 'text'), result.markdown);
  });

  it('continues on chainFrom(the model that answered, the chain)', async () => {
    const t = setup([
      { ref: 'gemini/b', text: [INTRO], stop: 'max_tokens' },
      { ref: 'gemini/b', text: ['More.\n'] },
    ]);
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send });
    assert.deepEqual(t.requests[0].model, CHAIN);
    assert.deepEqual(t.requests[1].model, ['gemini/b', 'gemini/c']);
    assert.equal(result.model, 'gemini/b');
  });

  it('keeps the escalation fallback when the model declines before writing anything', async () => {
    const t = setup([{ stop: 'refusal', explanation: 'no' }, { ref: 'claude-fable-5-1', text: [INTRO] }], { escalationModel: 'claude-fable-5-1' });
    const result = await generateGuide(t.ctx, { materials: MATERIALS, prompt: 'x', send: t.send });
    assert.deepEqual(t.requests[1].model, ['claude-fable-5-1']);
    assert.equal(result.model, 'claude-fable-5-1');
    assert.ok(statuses(t.events).includes('Trying a stronger model…'));
  });
});

describe('streamDocument end to end through the chain and the Gemini adapter', () => {
  it('survives a dropped connection and a busy model on the resume', async () => {
    const encoder = new TextEncoder();
    const chunk = (text: string, finishReason?: string) =>
      encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] })}\n\n`);
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const responses = [
      // gemini-a writes half the guide, then the connection drops.
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk(INTRO));
              controller.enqueue(chunk('Second paragraph that gets cu'));
            },
            pull(controller) {
              controller.error(new TypeError('network error'));
            },
          }),
        ),
      // On the resume gemini-a is busy, so the chain falls back to gemini-b.
      () => new Response(JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }), { status: 503 }),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk('Second paragraph, now complete.\n'));
              controller.enqueue(chunk('## Glossary\n', 'STOP'));
              controller.close();
            },
          }),
        ),
    ];
    const gemini = new GeminiClient({
      baseUrl: 'https://proxy.test/gemini',
      fetch: async (url, init) => {
        urls.push(String(url));
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return responses.shift()!();
      },
    });
    const events: StreamEvent[] = [];
    const waits: number[] = [];
    const ctx: AgentContext = {
      llm: new ChainLlmClient(() => gemini, { sleep: async () => undefined }),
      models: { ...MODELS, guide: ['gemini/gemini-a', 'gemini/gemini-b'] },
      effort: 'medium',
      showModels: false,
      sleep: async (ms) => void waits.push(ms),
    };
    const result = await generateGuide(ctx, { materials: MATERIALS, prompt: 'Make a guide', send: (e) => void events.push(e) });

    assert.equal(result.markdown, `${INTRO}Second paragraph, now complete.\n## Glossary\n`);
    assert.equal(pageText(events, 'guide_delta'), result.markdown);
    assert.equal(result.model, 'gemini/gemini-b');
    assert.deepEqual(waits, [2_000]);
    assert.deepEqual(
      urls.map((url) => url.match(/models\/([^:]+)/)?.[1]),
      ['gemini-a', 'gemini-a', 'gemini-b'],
    );
    assert.equal(bodies[0].tools, undefined, 'the guide is requested without tools');
    const contents = bodies[2].contents as { role: string; parts: { text?: string }[] }[];
    assert.deepEqual(contents[contents.length - 2], { role: 'model', parts: [{ text: INTRO }] });
    assert.match(contents[contents.length - 1].parts[0].text ?? '', /interrupted by a connection problem/);
    assert.ok(statuses(events).every((line) => !/gemini/i.test(line)));
  });
});

describe('continueDocument', () => {
  const guide: StudyGuide = { markdown: '# T\n\nPart one.\nPart tw', version: 3, updatedAt: '', prompt: 'Make a guide', model: 'gemini/a', incomplete: true };

  it('returns the saved draft plus the continuation', async () => {
    const t = setup([{ text: ['Part two.\n'] }]);
    const result = await continueDocument(t.ctx, { kind: 'guide', materials: MATERIALS, guide, draft: guide.markdown, send: t.send });
    assert.equal(result.markdown, '# T\n\nPart one.\nPart two.\n');
    const request = t.requests[0];
    assert.deepEqual(request.model, CHAIN);
    assert.equal(request.tools, undefined);
    assert.deepEqual(request.messages[request.messages.length - 2], { role: 'assistant', content: '# T\n\nPart one.\n' });
    assert.match(lastUserText(request), /Continue exactly from that point/);
    assert.deepEqual(t.events.find((e) => e.type === 'draft'), { type: 'draft', target: 'guide', text: '# T\n\nPart one.\n' });
  });

  it('finishes a guide written at maximum quality on the escalation model, and a review from its draft', async () => {
    const t = setup([{ text: ['Part two.\n'] }], { escalationModel: 'claude-fable-5-1' });
    await continueDocument(t.ctx, { kind: 'guide', materials: MATERIALS, guide: { ...guide, model: 'claude-fable-5-1' }, draft: guide.markdown, send: t.send });
    assert.deepEqual(t.requests[0].model, ['claude-fable-5-1']);
    const quiz: Quiz = { id: 'q', title: 'Q', createdAt: '', config: { numQuestions: 3, difficulty: 'mixed', types: [] }, questions: [], answers: [], status: 'completed' };
    const review = setup([{ text: ['## Retry prompts\n'] }]);
    const result = await continueDocument(review.ctx, { kind: 'review', materials: MATERIALS, guide: null, quiz, draft: '# Review\n', send: review.send });
    assert.equal(result.markdown, '# Review\n## Retry prompts\n');
    // The caller shows the saved draft first (a draft event), then the continuation streams after it.
    const shown = pageText([{ type: 'draft', target: 'text', text: '# Review\n' }, ...review.events], 'text');
    assert.equal(shown, result.markdown);
  });
});

describe('runChat', () => {
  const hooks: ChatHooks = {
    applyGuideEdit: async () => ({ ok: true, message: 'ok' }),
    regenerateGuide: async () => {
      throw new Error('not used');
    },
    createQuiz: async () => {
      throw new Error('not used');
    },
  };
  const chat = (t: ReturnType<typeof setup>, signal?: AbortSignal) =>
    runChat(t.ctx, { materials: MATERIALS, guide: null, history: [], userMessage: 'Explain TCP', hooks, send: t.send, signal });

  it('sends chat with tools', async () => {
    const t = setup([{ text: ['Sure.'] }]);
    await chat(t);
    assert.deepEqual(t.requests[0].tools?.map((tool) => tool.name), ['update_study_guide', 'regenerate_study_guide', 'create_quiz']);
  });

  it('continues an answer cut by the length limit', async () => {
    const t = setup([
      { ref: 'gemini/b', text: ['TCP opens with a three-way handshake.\nThen the data flo'], stop: 'max_tokens' },
      { ref: 'gemini/b', text: ['Then the data flows in both directions.\n'] },
    ]);
    const result = await chat(t);
    assert.equal(result.text, 'TCP opens with a three-way handshake.\nThen the data flows in both directions.');
    assert.equal(pageText(t.events, 'text').trim(), result.text);
    assert.deepEqual(t.requests[1].model, ['gemini/b', 'gemini/c']);
    assert.match(lastUserText(t.requests[1]), /cut off by the length limit/);
  });

  it('resumes once after a dropped connection, then throws PartialReplyError with the text', async () => {
    const resumed = setup([{ text: ['Line one of the answer.\nLine tw'], error: overloaded() }, { text: ['Line two.\n'] }]);
    assert.equal((await chat(resumed)).text, 'Line one of the answer.\nLine two.');
    assert.deepEqual(resumed.waits, [2_000]);

    const failing = setup([{ text: ['Line one of the answer.\nLine tw'], error: overloaded() }, { error: overloaded() }]);
    await assert.rejects(chat(failing), (err: unknown) => err instanceof PartialReplyError && err.reason === 'interrupted' && err.text === 'Line one of the answer.');
  });

  it('throws PartialReplyError on a failure after text, and on Stop', async () => {
    const bad = setup([{ text: ['Partial answer'], error: new LlmError('bad', { provider: 'gemini', model: 'a', status: 400 }) }]);
    await assert.rejects(chat(bad), (err: unknown) => err instanceof PartialReplyError && err.reason === 'failed' && err.text === 'Partial answer');
    const controller = new AbortController();
    const stopped = setup([{ text: ['Partial answer'], after: () => controller.abort(), error: new DOMException('aborted', 'AbortError') }]);
    await assert.rejects(chat(stopped, controller.signal), (err: unknown) => err instanceof PartialReplyError && err.reason === 'stopped');
    const nothing = setup([{ error: new LlmError('bad', { provider: 'gemini', model: 'a', status: 400 }) }]);
    await assert.rejects(chat(nothing), (err: unknown) => err instanceof LlmError);
  });
});

describe('describeError for the new cases', () => {
  const neutral = { showModels: false, agentName: 'Kiiku' };
  it('explains daily quotas, lost connections and partial results without naming models', () => {
    const quota = new LlmError('Gemini (gemini-3.8-flash): quota exceeded', { provider: 'gemini', model: 'x', status: 429, kind: 'daily_quota' });
    assert.equal(describeError(quota, neutral), "Kiiku has reached today's free limit. It resets overnight — you can also use Kiiku with your own account.");
    const network = new LlmError('Gemini (x): connection failed (Failed to fetch)', { provider: 'gemini', model: 'x', kind: 'network' });
    assert.equal(describeError(network, neutral), 'Lost the connection to Kiiku. Check your internet connection and try again.');
    assert.equal(describeError(new LlmError('stall', { provider: 'gemini', model: 'x', status: 504, kind: 'stalled' }), neutral), 'Lost the connection to Kiiku. Check your internet connection and try again.');
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(describeError(new PartialDocumentError('interrupted', { markdown: 'x', thinking: '', usage, model: 'gemini/a' }, network), neutral), 'Kiiku stopped partway (connection problem).');
    assert.equal(describeError(new PartialReplyError('failed', { text: 'x', thinking: '', toolEvents: [], usage }, quota), neutral), "Kiiku's reply was cut off (the free limit was reached).");
  });

  it('keeps the detailed text when models may be shown', () => {
    const quota = new LlmError('Gemini (gemini-3.8-flash): quota exceeded', { provider: 'gemini', model: 'x', status: 429, kind: 'daily_quota' });
    assert.match(describeError(quota), /^Gemini \(gemini-3\.8-flash\): quota exceeded — today's free quota is used up/);
    assert.match(describeError(new LlmError('Gemini (x): connection failed', { provider: 'gemini', model: 'x', kind: 'network' })), /Lost the connection to the model: Gemini \(x\): connection failed/);
  });
});
