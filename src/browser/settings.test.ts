import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_SETTINGS, effectiveSettings, type SiteConfig } from './settings.ts';

const site: SiteConfig = { proxyUrl: 'https://proxy.example.workers.dev', accessCode: 'course-2026', model: 'claude-opus-5', effort: 'xhigh', notice: 'Paid by the course.' };

describe('effectiveSettings', () => {
  it('uses the site proxy when the visitor has entered nothing', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, site);
    assert.equal(s.source, 'site-proxy');
    assert.equal(s.baseUrl, site.proxyUrl);
    assert.equal(s.accessCode, 'course-2026');
    assert.equal(s.apiKey, '');
    assert.equal(s.model, 'claude-opus-5');
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

  it('lets saved model and effort override the site defaults', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS, model: 'claude-sonnet-5', effort: 'low' }, site);
    assert.equal(s.model, 'claude-sonnet-5');
    assert.equal(s.effort, 'low');
  });

  it('falls back to built-in defaults and reports no credentials without a site config', () => {
    const s = effectiveSettings({ ...EMPTY_SETTINGS }, {});
    assert.equal(s.source, 'none');
    assert.equal(s.model, 'claude-opus-5');
    assert.equal(s.effort, 'high');
  });
});
