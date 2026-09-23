import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scrubModelNames } from './branding.js';
import { describeError, guideReadyMessage } from './core.js';
import { LlmError } from './llm.js';

describe('scrubModelNames', () => {
  it('replaces model references, bare model ids and provider names', () => {
    assert.equal(scrubModelNames('Gemini (gemini-3.8-flash): 429 quota exceeded'), 'The model: 429 quota exceeded');
    assert.equal(
      scrubModelNames('No model could answer. gemini/gemini-3.8-flash: quota · openrouter/qwen/qwen3.8-27b:free: OpenRouter is not configured'),
      'No model could answer. the model: quota · the model: the model service is not configured',
    );
    assert.equal(scrubModelNames('Could not reach the Claude API. Check the proxy URL.'), 'Could not reach the model API. Check the proxy URL.');
    assert.equal(scrubModelNames('Your credit balance is too low to access the Anthropic API.'), 'Your credit balance is too low to access the model service API.');
    assert.equal(scrubModelNames('Claude (claude-opus-5): 529 overloaded'), 'The model: 529 overloaded');
    assert.equal(scrubModelNames('Open it on claude.ai'), 'Open it on the model service');
    assert.equal(scrubModelNames('cf/@cf/google/gemma-4-26b-a4b-it failed'), 'The model failed');
  });

  it('leaves unrelated text alone', () => {
    assert.equal(scrubModelNames('Google Docs export failed: pop-up blocked.'), 'Google Docs export failed: pop-up blocked.');
    assert.equal(scrubModelNames('Session not found'), 'Session not found');
  });
});

describe('describeError in white-label mode', () => {
  const opts = { showModels: false, agentName: 'Kiiku' };
  it('maps statuses to neutral messages and scrubs the rest', () => {
    assert.equal(describeError(new LlmError('Gemini (gemini-3.8-flash): 429 quota', { provider: 'gemini', model: 'x', status: 429 }), opts), 'Kiiku is busy right now. Wait a moment and try again.');
    assert.match(describeError(new LlmError('Claude (claude-opus-5): 401 bad key', { provider: 'anthropic', model: 'x', status: 401 }), opts), /not set up correctly/);
    assert.match(describeError(new LlmError('too big', { provider: 'gemini', model: 'x', status: 413 }), opts), /too large/);
    assert.match(describeError(new LlmError('Gemini (x): 503 down', { provider: 'gemini', model: 'x', status: 503 }), opts), /having problems/);
    assert.match(describeError(new LlmError('Claude (x): 400 Your credit balance is too low to access the Anthropic API.', { provider: 'anthropic', model: 'x', status: 400 }), opts), /run out of credit/);
    assert.equal(describeError(new Error('Gemini (gemini-3.8-flash) returned nothing'), opts), 'The model returned nothing');
    assert.equal(describeError(new Error('Session not found'), opts), 'Session not found');
  });

  it('keeps the detailed messages when models may be shown', () => {
    assert.equal(describeError(new LlmError('Gemini (gemini-3.8-flash): 429 quota', { provider: 'gemini', model: 'x', status: 429 })), 'Gemini (gemini-3.8-flash): 429 quota');
  });
});

describe('guideReadyMessage', () => {
  it('names the model only when allowed', () => {
    assert.match(guideReadyMessage(2, 1234, 'gemini/gemini-3.8-flash', true), /written by gemini-3.8-flash/);
    assert.doesNotMatch(guideReadyMessage(2, 1234, 'gemini/gemini-3.8-flash', false), /gemini|written by/i);
    assert.match(guideReadyMessage(2, 1234, 'gemini/gemini-3.8-flash', false), /Study guide v2 is ready \(about 1,234 words\)/);
  });
});
