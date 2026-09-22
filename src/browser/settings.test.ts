import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SETTINGS, effectiveSettings, type SiteConfig } from './settings.ts';

const site: SiteConfig = {
  proxyUrl: 'https://proxy.example.workers.dev',
  accessCode: 'course-2026',
  models: { guide: 'claude-opus-5', chat: 'claude-sonnet-5' },
  escalationModel: 'claude-fable-5-1',
  effort: 'xhigh',
  notice: 'Paid by the course.',
};

describe('effectiveSettings', () => {
  it('uses the site proxy and per-task models when the visitor has entered nothing', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, site);
    assert.equal(s.source, 'site-proxy');
    assert.equal(s.baseUrl, site.proxyUrl);
    assert.equal(s.accessCode, 'course-2026');
    assert.equal(s.apiKey, '');
    assert.equal(s.models.guide, 'claude-opus-5');
    assert.equal(s.models.chat, 'claude-sonnet-5');
    assert.equal(s.models.grading, 'claude-sonnet-5');
    assert.equal(s.escalationModel, 'claude-fable-5-1');
    assert.equal(s.effort, 'xhigh');
  });

  it("prefers the visitor's own key, called directly, over the site proxy", () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, apiKey: 'sk-ant-own' }, site);
    assert.equal(s.source, 'own-key');
    assert.equal(s.apiKey, 'sk-ant-own');
    assert.equal(s.baseUrl, '');
    assert.equal(s.accessCode, '');
  });

  it("prefers the visitor's own proxy over both", () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, apiKey: 'sk-ant-own', baseUrl: 'https://mine.workers.dev', accessCode: 'x' }, site);
    assert.equal(s.source, 'own-proxy');
    assert.equal(s.baseUrl, 'https://mine.workers.dev');
    assert.equal(s.accessCode, 'x');
    assert.equal(s.apiKey, 'sk-ant-own');
  });

  it('applies a model the visitor typed to every task, and lets effort override the site default', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, model: 'claude-haiku-4-5', effort: 'low' }, site);
    assert.deepEqual(new Set(Object.values(s.models)), new Set(['claude-haiku-4-5']));
    assert.equal(s.effort, 'low');
  });

  it('honours a site-wide single model and an escalation switched off', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, { model: 'claude-sonnet-5', escalationModel: 'off' });
    assert.deepEqual(new Set(Object.values(s.models)), new Set(['claude-sonnet-5']));
    assert.equal(s.escalationModel, undefined);
  });

  it('falls back to built-in defaults and reports no credentials without a site config', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, {});
    assert.equal(s.source, 'none');
    assert.equal(s.models.guide, 'claude-opus-5');
    assert.equal(s.models.review, 'claude-sonnet-5');
    assert.equal(s.escalationModel, 'claude-fable-5-1');
    assert.equal(s.effort, 'high');
  });
});
