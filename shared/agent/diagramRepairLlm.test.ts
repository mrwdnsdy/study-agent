import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_TASK_MODELS } from './constants.js';
import type { AgentContext } from './core.js';
import { DIAGRAM_FIXER_SYSTEM, repairDiagramsWithModel } from './diagramRepairLlm.js';
import { emptyLlmUsage, type LlmClient, type LlmMessage, type LlmRequest } from './llm.js';
import { MERMAID_RULES } from './prompts.js';

/** A context whose model answers with `reply` and records every request. */
function fakeContext(reply: string | ((request: LlmRequest) => string), stopReason: LlmMessage['stop_reason'] = 'end_turn') {
  const requests: LlmRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const llm: LlmClient = {
    async stream(request, _handlers, signal) {
      requests.push(request);
      signals.push(signal);
      const text = typeof reply === 'function' ? reply(request) : reply;
      return {
        provider: 'gemini',
        model: 'fake-model',
        ref: 'gemini:fake-model',
        content: [{ type: 'text', text, citations: null } as Anthropic.ContentBlock],
        stop_reason: stopReason,
        usage: emptyLlmUsage(),
      };
    },
  };
  const ctx: AgentContext = { llm, models: { ...DEFAULT_TASK_MODELS, grading: ['gemini:grader', 'zai:backup'] }, effort: 'high' };
  return { ctx, requests, signals };
}

const ITEMS = [
  { code: 'flowchart TD\n  A[x (y)] --> B', error: 'Parse error on line 2' },
  { code: 'pie\n  "A" : 50%', error: 'Lexer error on line 2' },
  { code: 'sequenceDiagram\n  A->>B: a; b', error: 'Parse error on line 2' },
];

test('sends one request on the grading chain with the diagrams, errors and rules', async () => {
  const controller = new AbortController();
  const { ctx, requests, signals } = fakeContext('{"diagrams": []}');
  await repairDiagramsWithModel(ctx, ITEMS, controller.signal);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.deepEqual(request.model, ['gemini:grader', 'zai:backup']);
  assert.equal(request.maxTokens, 8000);
  assert.equal(request.effort, 'medium');
  assert.equal(request.outputSchema?.name, 'diagrams');
  assert.equal(request.system, DIAGRAM_FIXER_SYSTEM);
  assert.ok(request.system.includes(MERMAID_RULES), 'the fixer follows the prompt rules');
  const schema = JSON.stringify(request.outputSchema?.schema);
  assert.ok(schema.includes('"diagrams"') && schema.includes('"index"') && schema.includes('"integer"'), schema);
  assert.ok(!('$schema' in (request.outputSchema?.schema ?? {})), 'no $schema key');
  const prompt = String(request.messages[0].content);
  for (const [index, item] of ITEMS.entries()) {
    assert.ok(prompt.includes(`<diagram index="${index}">`), `index ${index}`);
    assert.ok(prompt.includes(item.code) && prompt.includes(item.error), `diagram ${index} and its error`);
  }
  assert.equal(signals[0], controller.signal, 'the abort signal is passed on');
});

test('maps corrections back by index, strips fences and fills gaps with null', async () => {
  const reply = JSON.stringify({
    diagrams: [
      { index: 2, code: 'sequenceDiagram\n  A->>B: a, b' },
      { index: 0, code: '```mermaid\nflowchart TD\n  A["x (y)"] --> B\n```' },
      { index: 0, code: 'ignored duplicate' },
      { index: 7, code: 'out of range' },
    ],
  });
  const { ctx } = fakeContext(reply);
  assert.deepEqual(await repairDiagramsWithModel(ctx, ITEMS), ['flowchart TD\n  A["x (y)"] --> B', null, 'sequenceDiagram\n  A->>B: a, b']);
});

test('reads JSON wrapped in prose or a fence', async () => {
  const { ctx } = fakeContext('Here you go:\n```json\n{"diagrams": [{"index": 1, "code": "pie\\n  \\"A\\" : 50"}]}\n```');
  assert.deepEqual(await repairDiagramsWithModel(ctx, ITEMS), [null, 'pie\n  "A" : 50', null]);
});

test('returns nulls for an unusable reply or a refusal', async () => {
  assert.deepEqual(await repairDiagramsWithModel(fakeContext('Sorry, no.').ctx, ITEMS), [null, null, null]);
  assert.deepEqual(await repairDiagramsWithModel(fakeContext('{"diagrams": [{"index": "0"}]}').ctx, ITEMS), [null, null, null]);
  assert.deepEqual(await repairDiagramsWithModel(fakeContext('{"diagrams": [{"index": 0, "code": "  "}]}').ctx, ITEMS), [null, null, null]);
  const refused = fakeContext('{"diagrams": [{"index": 0, "code": "flowchart TD"}]}', 'refusal');
  assert.deepEqual(await repairDiagramsWithModel(refused.ctx, ITEMS), [null, null, null]);
});

test('makes no request when there is nothing to fix, and lets request failures through', async () => {
  const { ctx, requests } = fakeContext('{}');
  assert.deepEqual(await repairDiagramsWithModel(ctx, []), []);
  assert.equal(requests.length, 0);
  const failing: AgentContext = {
    ...ctx,
    llm: {
      stream: async () => {
        throw new Error('network down');
      },
    },
  };
  await assert.rejects(repairDiagramsWithModel(failing, ITEMS), /network down/);
});
