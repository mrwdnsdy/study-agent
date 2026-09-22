import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SETTINGS, effectiveSettings, type SiteConfig } from './settings.ts';

const FREE = ['gemini/gemini-3.8-flash', 'gemini/gemini-3.5-flash-lite', 'openrouter/qwen/qwen3.8-27b:free'];

const site: SiteConfig = {
  proxyUrl: 'https://proxy.example.workers.dev',
  accessCode: 'course-2026',
  defaultLane: 'free',
  lanes: {
    free: { label: 'Free', model: FREE },
    claude: { label: 'Claude', models: { guide: 'claude-opus-5', chat: 'claude-sonnet-5' }, escalationModel: 'claude-fable-5-1' },
  },
  effort: 'xhigh',
  notice: 'Paid by the course.',
  providers: { anthropic: true, gemini: true, openrouter: false },
};

describe('effectiveSettings', () => {
  it('uses the site proxy and the default lane when the visitor has entered nothing', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, site);
    assert.equal(s.source, 'site-proxy');
    assert.equal(s.baseUrl, site.proxyUrl);
    assert.equal(s.accessCode, 'course-2026');
    assert.equal(s.lane, 'free');
    assert.deepEqual(s.models.guide, FREE);
    assert.deepEqual(s.models.grading, FREE);
    assert.equal(s.escalationModel, undefined, 'a non-Claude lane has no escalation unless configured');
    assert.equal(s.effort, 'xhigh');
    assert.deepEqual(
      s.lanes.map((l) => [l.id, l.label, l.primary, l.escalation]),
      [
        ['free', 'Free', 'gemini-3.8-flash', undefined],
        ['claude', 'Claude', 'claude-opus-5', 'claude-fable-5-1'],
      ],
    );
    assert.deepEqual(s.providers, site.providers);
  });

  it('switches lanes when the visitor picked one', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, lane: 'claude' }, site);
    assert.equal(s.lane, 'claude');
    assert.deepEqual(s.models.guide, ['claude-opus-5']);
    assert.deepEqual(s.models.chat, ['claude-sonnet-5']);
    assert.deepEqual(s.models.review, ['claude-sonnet-5'], 'unlisted tasks fall back to the Claude defaults');
    assert.equal(s.escalationModel, 'claude-fable-5-1');
  });

  it('ignores an unknown lane id', () => {
    assert.equal(effectiveSettings({ ...EMPTY_SETTINGS, lane: 'nope' }, site).lane, 'free');
  });

  it("prefers the visitor's own key, called directly, and moves to the Claude lane", () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, apiKey: 'sk-ant-own' }, site);
    assert.equal(s.source, 'own-key');
    assert.equal(s.apiKey, 'sk-ant-own');
    assert.equal(s.baseUrl, '');
    assert.equal(s.lane, 'claude');
    assert.deepEqual(s.models.guide, ['claude-opus-5']);
    assert.equal(s.escalationModel, 'claude-fable-5-1');
  });

  it("prefers the visitor's own proxy over both and keeps the chosen lane", () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, apiKey: 'sk-ant-own', baseUrl: 'https://mine.workers.dev', accessCode: 'x', lane: 'free' }, site);
    assert.equal(s.source, 'own-proxy');
    assert.equal(s.baseUrl, 'https://mine.workers.dev');
    assert.equal(s.accessCode, 'x');
    assert.deepEqual(s.models.guide, FREE);
  });

  it('applies a model the visitor typed to every task, and lets effort override the site default', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, model: 'claude-haiku-4-5', effort: 'low' }, site);
    assert.deepEqual(new Set(Object.values(s.models).map((c) => c.join())), new Set(['claude-haiku-4-5']));
    assert.equal(s.effort, 'low');
  });

  it('supports the legacy single-lane config and an escalation switched off', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, { model: 'claude-sonnet-5', escalationModel: 'off' });
    assert.deepEqual(new Set(Object.values(s.models).map((c) => c.join())), new Set(['claude-sonnet-5']));
    assert.equal(s.escalationModel, undefined);
    assert.deepEqual(s.lanes, []);
  });

  it('defaults an all-Claude legacy config to Fable escalation and falls back to built-in defaults', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, {});
    assert.equal(s.source, 'none');
    assert.deepEqual(s.models.guide, ['claude-opus-5']);
    assert.deepEqual(s.models.review, ['claude-sonnet-5']);
    assert.equal(s.escalationModel, 'claude-fable-5-1');
    assert.equal(s.effort, 'high');
  });
});
