import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { EFFORTS, MODEL_SUGGESTIONS, PROVIDER_LABELS, displayModel, type Effort } from '../../shared/agent/constants';
import type { ProviderId } from '../../shared/types';
import {
  EMPTY_SETTINGS,
  clearSettings,
  effectiveSettings,
  getSiteConfig,
  loadSettings,
  saveSettings,
  type BrowserSettings,
  type EffectiveSettings,
} from '../browser/settings';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: EffectiveSettings) => void;
}

/** Model choices when the app runs as a claude.ai artifact: the runtime's tiers. */
const ARTIFACT_SUGGESTIONS = ['artifact/complex', 'artifact/default', 'artifact/quick'];

const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low · fastest',
  medium: 'Medium',
  high: 'High · recommended',
  xhigh: 'Extra high',
  max: 'Max · slowest, most thorough',
};

function Intro({ resolved }: { resolved: EffectiveSettings }) {
  const site = getSiteConfig();
  const whiteLabel = site.showModels === false;
  switch (resolved.source) {
    case 'site-proxy':
      if (whiteLabel) {
        return (
          <p className="muted small">
            {resolved.agentName} comes with model access provided by this site, so you can start straight away. {site.notice}
          </p>
        );
      }
      return (
        <p className="muted small">
          This page comes with model access provided by the site owner, so you can start straight away. {site.notice}
          {site.notice ? ' ' : ''}Enter your own key below only if you would rather use your own Anthropic account.
        </p>
      );
    case 'own-key':
      return (
        <p className="muted small">
          You are using your own Anthropic key. It is stored only in this browser and sent nowhere except to Claude.
          {site.proxyUrl ? ' Clear it to go back to the access provided by this site.' : ''}
        </p>
      );
    case 'own-proxy':
      return <p className="muted small">You are using your own proxy. Requests go to it instead of to api.anthropic.com.</p>;
    case 'artifact':
      return (
        <p className="muted small">
          This copy of {resolved.agentName} runs on the account you are signed in with here; the first request asks you to allow it. {site.notice}
        </p>
      );
    default:
      if (whiteLabel) return <p className="muted small">Model access is not configured on this site yet. {site.notice}</p>;
      return (
        <p className="muted small">
          This page runs entirely in your browser. Your key and your study sessions are stored only on this device and are sent nowhere
          except to Claude.
        </p>
      );
  }
}

/** Browser-mode settings: the visitor's own key or proxy, layered over the site's presets (public/config.json). */
export function SettingsDialog({ open, onClose, onSaved }: Props) {
  const [form, setForm] = useState<BrowserSettings>(() => loadSettings());
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    const current = loadSettings();
    setForm(current);
    setShowKey(false);
    setAdvanced(Boolean(current.baseUrl || current.accessCode));
  }, [open]);

  const lanes = getSiteConfig().lanes ? effectiveSettings({ ...EMPTY_SETTINGS }, getSiteConfig()).lanes : [];

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const site = getSiteConfig();
  const whiteLabel = site.showModels === false;
  const suggestions: readonly string[] = site.artifact ? ARTIFACT_SUGGESTIONS : MODEL_SUGGESTIONS;
  const set = <K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]) => setForm((f) => ({ ...f, [key]: value }));

  const normalised = (): BrowserSettings => ({
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    effort: form.effort,
    baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
    accessCode: form.accessCode.trim(),
    lane: form.lane.trim(),
  });
  const configured = Object.entries(site.providers ?? {})
    .filter(([, ok]) => ok)
    .map(([id]) => PROVIDER_LABELS[id as ProviderId]);
  const preview = effectiveSettings(normalised());
  const anythingSaved = Object.values(loadSettings()).some(Boolean);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalised();
    if (Object.values(next).some(Boolean)) saveSettings(next);
    else clearSettings();
    onSaved(effectiveSettings(next));
    onClose();
  };

  const reset = () => {
    clearSettings();
    onSaved(effectiveSettings(loadSettings()));
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <header className="modal__header">
            <h2 id="settings-title">
              <KeyRound size={18} /> Settings
            </h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </header>

          <div className="modal__body">
            <Intro resolved={preview} />

            {lanes.length > 1 && (
              <fieldset className="field lanes" data-testid="settings-lanes">
                <span>Models</span>
                {lanes.map((lane) => (
                  <label key={lane.id} className="lane">
                    <input type="radio" name="lane" value={lane.id} checked={(preview.lane ?? '') === lane.id} onChange={() => set('lane', lane.id)} />
                    <span className="lane__body">
                      <span className="lane__label">{lane.label}</span>
                      {!whiteLabel && (
                        <span className="lane__meta">
                          {lane.primary}
                          {lane.escalation ? ` · maximum quality: ${lane.escalation}` : ''}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {!whiteLabel && configured.length > 0 && <span className="field__hint">Keys on this site: {configured.join(', ')}.</span>}
              </fieldset>
            )}

            {!site.artifact && !whiteLabel && (
            <label className="field">
              <span>{site.proxyUrl ? 'Your own Anthropic API key (optional)' : 'Anthropic API key'}</span>
              <span className="field__input-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={site.proxyUrl ? 'Leave empty to use the access provided by this site' : 'sk-ant-…'}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="settings-api-key"
                />
                <button type="button" className="icon-btn" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide key' : 'Show key'}>
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </span>
              <span className="field__hint">
                Create one at{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>
                . Usage is billed to that account.
              </span>
            </label>
            )}

            <div className="field-row">
              {!whiteLabel && (
              <label className="field">
                <span>Model for every task (optional)</span>
                <input
                  type="text"
                  list="settings-model-suggestions"
                  value={form.model}
                  onChange={(e) => set('model', e.target.value)}
                  placeholder="Per-task defaults"
                  spellCheck={false}
                />
                <datalist id="settings-model-suggestions">
                  {suggestions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <span className="field__hint">
                  Current: study guide on <code>{displayModel(preview.models.guide)}</code>
                  {preview.models.guide.length > 1 ? ` (+${preview.models.guide.length - 1} fallback${preview.models.guide.length > 2 ? 's' : ''})` : ''}; chat, quizzes and
                  grading on <code>{displayModel(preview.models.chat)}</code>
                  {preview.escalationModel ? (
                    <>
                      ; <code>{displayModel(preview.escalationModel)}</code> for maximum-quality guides and whenever a model declines
                    </>
                  ) : null}
                  . Typing a model here uses it for every task.
                </span>
              </label>
              )}
              <label className="field">
                <span>Effort</span>
                <select value={form.effort} onChange={(e) => set('effort', e.target.value as Effort | '')}>
                  <option value="">Default · {EFFORT_LABELS[site.effort ?? 'high']}</option>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_LABELS[effort]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {!site.artifact && !whiteLabel && (
              <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? 'Hide proxy settings' : 'Use your own proxy…'}
            </button>

            {advanced && (
              <div className="settings__advanced">
                <label className="field">
                  <span>Proxy URL</span>
                  <input
                    type="url"
                    value={form.baseUrl}
                    onChange={(e) => set('baseUrl', e.target.value)}
                    placeholder={site.proxyUrl ? "Leave empty to use this site's proxy" : 'https://study-agent-proxy.<you>.workers.dev'}
                    spellCheck={false}
                  />
                  <span className="field__hint">
                    A Cloudflare Worker from the <code>proxy/</code> folder of the repository holds an API key server-side. Requests go there
                    instead of to api.anthropic.com.
                  </span>
                </label>
                <label className="field">
                  <span>Access code</span>
                  <input type="password" value={form.accessCode} onChange={(e) => set('accessCode', e.target.value)} autoComplete="off" />
                  <span className="field__hint">Only needed if that proxy was configured with one.</span>
                </label>
              </div>
            )}
              </>
            )}
          </div>

          <footer className="modal__footer">
            {anythingSaved && (
              <button type="button" className="btn btn--ghost" onClick={reset} title="Forget everything entered here">
                Reset
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" data-testid="settings-save">
              Save
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
