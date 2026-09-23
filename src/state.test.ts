import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialState, reducer, type AppState } from './state';

describe('stream draft events', () => {
  const streaming = (kind: 'generate' | 'review'): AppState => reducer(initialState, { type: 'stream/start', kind });

  it('replaces the guide draft, so a continuation starts from the saved text', () => {
    let state = streaming('generate');
    state = reducer(state, { type: 'stream/event', event: { type: 'guide_start', version: 2 } });
    state = reducer(state, { type: 'stream/event', event: { type: 'draft', target: 'guide', text: '# Guide\n\nSaved part.\n' } });
    state = reducer(state, { type: 'stream/deltas', text: '', thinking: '', guide: 'More.\n' });
    assert.equal(state.stream.guideDraft, '# Guide\n\nSaved part.\nMore.\n');
    // A draft cut back to a safe point before a resume replaces what was shown.
    state = reducer(state, { type: 'stream/event', event: { type: 'draft', target: 'guide', text: '# Guide\n\n' } });
    assert.equal(state.stream.guideDraft, '# Guide\n\n');
    assert.equal(state.stream.text, '');
  });

  it('replaces the streamed text for reviews and chat', () => {
    let state = streaming('review');
    state = reducer(state, { type: 'stream/deltas', text: 'Half a li', thinking: '', guide: '' });
    state = reducer(state, { type: 'stream/event', event: { type: 'draft', target: 'text', text: '# Review\n' } });
    assert.equal(state.stream.text, '# Review\n');
    assert.equal(state.stream.guideDraft, null);
  });
});
