import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from './llm.js';
import {
  ContinuationJoiner,
  HOLD_CHARS,
  PartialDocumentError,
  continuationReason,
  continuePrompt,
  joinContinuation,
  resumeDelay,
  stoppedReasonPhrase,
  trimToSafeBoundary,
} from './resume.js';

describe('trimToSafeBoundary', () => {
  it('cuts back to the end of the last complete line', () => {
    assert.equal(trimToSafeBoundary('# Title\n\nFirst line.\nSecond li'), '# Title\n\nFirst line.\n');
    assert.equal(trimToSafeBoundary('# Title\n\nComplete.\n'), '# Title\n\nComplete.\n');
    assert.equal(trimToSafeBoundary('no newline yet'), '');
  });

  it('cuts back to the opening line of an unclosed fence', () => {
    const draft = 'Intro.\n\n```mermaid\nflowchart TD\n  A["Start"] --> B["End"]\n';
    assert.equal(trimToSafeBoundary(draft), 'Intro.\n\n');
    assert.equal(trimToSafeBoundary('Intro.\n~~~\ncode\n'), 'Intro.\n');
    // The closing fence line itself cut off: the block is still open once the partial line goes.
    assert.equal(trimToSafeBoundary('Intro.\n```js\nlet a = 1;\n``'), 'Intro.\n');
  });

  it('keeps closed fences, and fences inside other fences, as they are', () => {
    const closed = 'Intro.\n```mermaid\nflowchart TD\n```\nAfter the diagram.\n';
    assert.equal(trimToSafeBoundary(closed), closed);
    const nested = '````md\n```js\nx\n```\n````\nDone.\n';
    assert.equal(trimToSafeBoundary(nested), nested);
    assert.equal(trimToSafeBoundary('A\n````md\n```js\nx\n```\n'), 'A\n', 'a shorter fence does not close a longer one');
  });
});

describe('joinContinuation', () => {
  const draft = '# Guide\n\nThe introduction explains the whole module.\n';

  it('strips the longest stretch that repeats the end of the draft', () => {
    assert.equal(joinContinuation(draft, 'The introduction explains the whole module.\n## Next part\n'), '## Next part\n');
    assert.equal(joinContinuation(draft, 'explains the whole module.\nMore.'), 'More.');
  });

  it('keeps short coincidences (under 20 characters)', () => {
    assert.equal(joinContinuation(draft, 'module.\nMore.'), 'module.\nMore.');
  });

  it('drops one leading preamble line', () => {
    assert.equal(joinContinuation(draft, "Sure, here's the rest of the guide:\n## Part two\n"), '## Part two\n');
    assert.equal(joinContinuation(draft, 'Okay, continuing from where I stopped.\nThe introduction explains the whole module.\nNew.'), 'New.');
    assert.equal(joinContinuation(draft, 'Here is the continuation:\n\n## Part two'), '\n## Part two');
    assert.equal(joinContinuation(draft, 'Okapi facts follow.\n'), 'Okapi facts follow.\n', 'only whole words count');
  });
});

describe('ContinuationJoiner', () => {
  it('holds back the opening, then forwards the joined text and passes the rest through', () => {
    const out: string[] = [];
    const draft = 'Line one of the guide is right here.\n';
    const joiner = new ContinuationJoiner(draft, (t) => out.push(t));
    joiner.push('Certainly!\n');
    joiner.push('Line one of the guide is right here.\n');
    assert.deepEqual(out, [], 'nothing reaches the page while held');
    joiner.push('x'.repeat(HOLD_CHARS));
    assert.deepEqual(out, ['x'.repeat(HOLD_CHARS)]);
    joiner.push('tail');
    joiner.release();
    assert.deepEqual(out, ['x'.repeat(HOLD_CHARS), 'tail']);
  });

  it('forwards a short continuation on release, and passes everything through when not holding', () => {
    const out: string[] = [];
    const joiner = new ContinuationJoiner('Draft ends with this sentence here.\n', (t) => out.push(t));
    joiner.push('Draft ends with this sentence here.\nShort end.');
    joiner.release();
    joiner.release();
    assert.deepEqual(out, ['Short end.']);
    const direct: string[] = [];
    const pass = new ContinuationJoiner('x', (t) => direct.push(t), false);
    pass.push('a');
    pass.push('b');
    assert.deepEqual(direct, ['a', 'b']);
  });
});

describe('continuePrompt and continuationReason', () => {
  it('quotes the tail for interruptions and recitation', () => {
    assert.match(continuePrompt('length', 'tail'), /^Your response was cut off by the length limit\. Continue exactly where you stopped/);
    assert.match(continuePrompt('interrupted', 'the end'), /interrupted by a connection problem\. It ended with:\n«…the end»\nContinue exactly from that point/);
    assert.match(continuePrompt('recitation', 'the end'), /reproducing the source material too closely\. It ended with:\n«…the end»\n.*in your own words/s);
  });

  it('maps stop reasons to continuations', () => {
    assert.equal(continuationReason({ stop_reason: 'max_tokens' }), 'length');
    assert.equal(continuationReason({ stop_reason: 'pause_turn', stop_details: { explanation: 'recitation' } }), 'recitation');
    assert.equal(continuationReason({ stop_reason: 'pause_turn', stop_details: { explanation: 'interrupted' } }), 'interrupted');
    assert.equal(continuationReason({ stop_reason: 'pause_turn' }), 'interrupted');
    assert.equal(continuationReason({ stop_reason: 'end_turn' }), null);
    assert.equal(continuationReason({ stop_reason: 'refusal' }), null);
  });
});

describe('resumeDelay and stoppedReasonPhrase', () => {
  it('backs off 2, 6 then 15 s, or longer when the provider asks (capped at 45 s)', () => {
    const plain = new LlmError('503', { provider: 'gemini', model: 'x', status: 503 });
    assert.deepEqual([0, 1, 2, 3].map((n) => resumeDelay(n, plain)), [2_000, 6_000, 15_000, 15_000]);
    assert.equal(resumeDelay(0, new LlmError('429', { provider: 'gemini', model: 'x', status: 429, retryAfterMs: 23_000 })), 23_000);
    assert.equal(resumeDelay(0, new LlmError('429', { provider: 'gemini', model: 'x', status: 429, retryAfterMs: 120_000 })), 45_000);
  });

  it('describes why writing stopped in neutral words', () => {
    const quota = new LlmError('quota', { provider: 'gemini', model: 'x', status: 429, kind: 'daily_quota' });
    assert.equal(stoppedReasonPhrase('stopped'), 'stopped by you');
    assert.equal(stoppedReasonPhrase('failed', quota), 'the free limit was reached');
    assert.equal(stoppedReasonPhrase('interrupted', new LlmError('x', { provider: 'gemini', model: 'x', kind: 'network' })), 'connection problem');
    assert.equal(stoppedReasonPhrase('interrupted', new LlmError('x', { provider: 'gemini', model: 'x', status: 503 })), 'the service was busy');
    assert.equal(stoppedReasonPhrase('failed', new Error('bad request')), 'service error');
    const err = new PartialDocumentError('failed', { markdown: 'x', thinking: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'm' }, quota);
    assert.equal(err.stoppedReason, 'the free limit was reached');
    assert.equal(err.cause, quota);
  });
});
