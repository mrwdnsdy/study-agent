import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_TASK_MODELS, resolveTaskModels } from './constants.js';

describe('resolveTaskModels', () => {
  it('returns the per-task defaults when nothing is configured', () => {
    assert.deepEqual(resolveTaskModels(), DEFAULT_TASK_MODELS);
    assert.equal(resolveTaskModels().guide, 'claude-opus-5');
    assert.equal(resolveTaskModels().chat, 'claude-sonnet-5');
  });

  it('applies a fallback to every task', () => {
    const models = resolveTaskModels({}, 'claude-haiku-4-5');
    assert.deepEqual(new Set(Object.values(models)), new Set(['claude-haiku-4-5']));
  });

  it('lets explicit task entries win over the fallback and ignores blanks', () => {
    const models = resolveTaskModels({ guide: 'claude-fable-5-1', chat: '  ', quiz: undefined }, 'claude-sonnet-5');
    assert.equal(models.guide, 'claude-fable-5-1');
    assert.equal(models.chat, 'claude-sonnet-5');
    assert.equal(models.quiz, 'claude-sonnet-5');
  });
});
