import { DEFAULT_MODEL, isEffort, type Effort } from '../../shared/agent/constants';

export interface BrowserSettings {
  /** Anthropic API key. Stays in this browser's localStorage. */
  apiKey: string;
  model: string;
  effort: Effort;
  /** Optional proxy that holds the key server-side (see proxy/). Leave empty to call api.anthropic.com directly. */
  baseUrl: string;
  /** Optional shared secret the proxy checks. */
  accessCode: string;
}

const STORAGE_KEY = 'study-agent:settings';

export const DEFAULT_SETTINGS: BrowserSettings = { apiKey: '', model: DEFAULT_MODEL, effort: 'high', baseUrl: '', accessCode: '' };

export function loadSettings(): BrowserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BrowserSettings>;
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL,
      effort: isEffort(parsed.effort) ? parsed.effort : 'high',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      accessCode: typeof parsed.accessCode === 'string' ? parsed.accessCode : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: BrowserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or storage disabled: settings live for this page load only */
  }
}

/** True when Claude can be called: a key, or a proxy that holds one. */
export function hasCredentials(settings: BrowserSettings = loadSettings()): boolean {
  return Boolean(settings.apiKey.trim() || settings.baseUrl.trim());
}
