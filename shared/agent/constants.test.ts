import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_TASK_MODELS, displayModel, parseModelRef, providersOf, resolveTaskModels } from './constants.js';

describe('resolveTaskModels', () => {
  it('returns the per-task defaults when nothing is configured', () => {
    assert.deepEqual(resolveTaskModels(), DEFAULT_TASK_MODELS);
    assert.deepEqual(resolveTaskModels().guide, ['claude-opus-5']);
    assert.deepEqual(resolveTaskModels().chat, ['claude-sonnet-5']);
  });

  it('applies a fallback chain to every task, from an array or a comma-separated string', () => {
    const fromArray = resolveTaskModels({}, ['gemini/gemini-3.8-flash', 'openrouter/qwen/qwen3.8-27b:free']);
    assert.deepEqual(fromArray.review, ['gemini/gemini-3.8-flash', 'openrouter/qwen/qwen3.8-27b:free']);
    const fromString = resolveTaskModels({}, ' gemini/gemini-3.8-flash , openrouter/qwen/qwen3.8-27b:free ,');
    assert.deepEqual(fromString, fromArray);
  });

  it('lets explicit task entries win over the fallback and ignores blanks', () => {
    const models = resolveTaskModels({ guide: 'claude-fable-5-1', chat: '  ', quiz: undefined, review: [] }, 'claude-sonnet-5');
    assert.deepEqual(models.guide, ['claude-fable-5-1']);
    assert.deepEqual(models.chat, ['claude-sonnet-5']);
    assert.deepEqual(models.quiz, ['claude-sonnet-5']);
    assert.deepEqual(models.review, ['claude-sonnet-5']);
  });
});

describe('parseModelRef', () => {
  it('routes references to providers', () => {
    assert.deepEqual(parseModelRef('claude-opus-5'), { provider: 'anthropic', model: 'claude-opus-5', ref: 'claude-opus-5' });
    assert.equal(parseModelRef('anthropic/claude-sonnet-5').model, 'claude-sonnet-5');
    assert.deepEqual(parseModelRef('gemini/gemini-3.8-flash'), { provider: 'gemini', model: 'gemini-3.8-flash', ref: 'gemini/gemini-3.8-flash' });
    assert.equal(parseModelRef('gemini-3.5-flash-lite').provider, 'gemini');
    assert.deepEqual(parseModelRef('openrouter/qwen/qwen3.8-27b:free'), { provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', ref: 'openrouter/qwen/qwen3.8-27b:free' });
    assert.equal(parseModelRef('zai/glm-4.7-flash').provider, 'zai');
    assert.deepEqual(parseModelRef('cf/@cf/google/gemma-4-26b-a4b-it'), { provider: 'workers-ai', model: '@cf/google/gemma-4-26b-a4b-it', ref: 'cf/@cf/google/gemma-4-26b-a4b-it' });
    assert.equal(parseModelRef('@cf/openai/gpt-oss-120b').provider, 'workers-ai');
  });

  it('formats display names and lists providers of a chain', () => {
    assert.equal(displayModel('gemini/gemini-3.8-flash'), 'gemini-3.8-flash');
    assert.equal(displayModel(['claude-opus-5', 'claude-sonnet-5']), 'claude-opus-5');
    assert.equal(displayModel('openrouter/qwen/qwen3.8-27b:free'), 'qwen/qwen3.8-27b:free (OpenRouter)');
    assert.equal(displayModel(undefined), '');
    const models = resolveTaskModels({ guide: ['gemini/gemini-3.8-flash', 'zai/glm-4.7-flash'] }, 'claude-sonnet-5');
    assert.deepEqual(providersOf(models, ['cf/@cf/google/gemma-4-26b-a4b-it']).sort(), ['anthropic', 'gemini', 'workers-ai', 'zai']);
  });
});

describe('artifact model references', () => {
  it('routes "artifact/<tier>" to the artifact runtime and shows the tier', () => {
    assert.deepEqual(parseModelRef('artifact/complex'), { provider: 'artifact', model: 'complex', ref: 'artifact/complex' });
    assert.deepEqual(parseModelRef('artifact/'), { provider: 'artifact', model: 'default', ref: 'artifact/' });
    assert.equal(displayModel('artifact/quick'), 'Claude (quick tier)');
    assert.deepEqual(providersOf({ guide: ['artifact/complex'], chat: ['artifact/default'], quiz: ['artifact/default'], grading: ['artifact/quick'], review: ['artifact/default'] }), ['artifact']);
  });
});
