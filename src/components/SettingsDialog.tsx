import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { DEFAULT_MODEL, EFFORTS, MODEL_SUGGESTIONS, type Effort } from '../../shared/agent/constants';
import { loadSettings, saveSettings, type BrowserSettings } from '../browser/settings';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: BrowserSettings) => void;
}

const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low · fastest',
  medium: 'Medium',
  high: 'High · recommended',
  xhigh: 'Extra high',
  max: 'Max · slowest, most thorough',
};

/** Browser-mode settings: the visitor's own API key (kept in localStorage) or a proxy that holds one. */
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: BrowserSettings = {
      apiKey: form.apiKey.trim(),
      model: form.model.trim() || DEFAULT_MODEL,
      effort: form.effort,
      baseUrl: form.baseUrl.trim(),
      accessCode: form.accessCode.trim(),
    };
    saveSettings(next);
    onSaved(next);
    onClose();
  };

  const usingProxy = Boolean(form.baseUrl.trim());

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
            <p className="muted small">
              This page runs entirely in your browser. Your key and your study sessions are stored only on this device and are sent
              nowhere except to Claude.
            </p>

            <label className="field">
              <span>Anthropic API key</span>
              <span className="field__input-row">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => set('apiKey', e.target.value)}
                  placeholder={usingProxy ? 'Not needed with a proxy' : 'sk-ant-…'}
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

            <div className="field-row">
              <label className="field">
                <span>Model</span>
                <input
                  type="text"
                  list="settings-model-suggestions"
                  value={form.model}
                  onChange={(e) => set('model', e.target.value)}
                  placeholder={DEFAULT_MODEL}
                  spellCheck={false}
                />
                <datalist id="settings-model-suggestions">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>Effort</span>
                <select value={form.effort} onChange={(e) => set('effort', e.target.value as Effort)}>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_LABELS[effort]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? 'Hide proxy settings' : 'Use a proxy instead of a key…'}
            </button>

            {advanced && (
              <div className="settings__advanced">
                <label className="field">
                  <span>Proxy URL</span>
                  <input
                    type="url"
                    value={form.baseUrl}
                    onChange={(e) => set('baseUrl', e.target.value)}
                    placeholder="https://study-agent-proxy.<you>.workers.dev"
                    spellCheck={false}
                  />
                  <span className="field__hint">
                    A Cloudflare Worker from the <code>proxy/</code> folder of the repository holds the API key server-side, so people you share the
                    page with never need a key of their own.
                  </span>
                </label>
                <label className="field">
                  <span>Access code</span>
                  <input type="password" value={form.accessCode} onChange={(e) => set('accessCode', e.target.value)} autoComplete="off" />
                  <span className="field__hint">Only needed if the proxy was configured with one.</span>
                </label>
              </div>
            )}
          </div>

          <footer className="modal__footer">
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
