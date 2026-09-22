import { DEFAULT_MODEL, isEffort, type Effort } from '../../shared/agent/constants';

/**
 * What the visitor typed in Settings. Every field is optional: an empty or
 * missing value means "use the site default" from public/config.json.
 */
export interface BrowserSettings {
  /** The visitor's own Anthropic API key. Stays in this browser's localStorage. */
  apiKey: string;
  model: string;
  effort: Effort | '';
  /** The visitor's own proxy (see proxy/). Empty: call api.anthropic.com directly, or use the site proxy. */
  baseUrl: string;
  accessCode: string;
}

/**
 * Defaults the site owner ships in public/config.json so visitors need no
 * setup: a proxy that holds the owner's key, the model and effort to use, and
 * a short notice shown in Settings.
 */
export interface SiteConfig {
  proxyUrl?: string;
  accessCode?: string;
  model?: string;
  effort?: Effort;
  notice?: string;
}

export type CredentialSource = 'own-key' | 'own-proxy' | 'site-proxy' | 'none';

/** Fully resolved values used to call Claude. */
export interface EffectiveSettings {
  apiKey: string;
  model: string;
  effort: Effort;
  baseUrl: string;
  accessCode: string;
  source: CredentialSource;
}

const STORAGE_KEY = 'study-agent:settings';

export const EMPTY_SETTINGS: BrowserSettings = { apiKey: '', model: '', effort: '', baseUrl: '', accessCode: '' };

let siteConfig: SiteConfig = {};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Fetches public/config.json once at start-up (browser mode only). Missing or invalid files mean "no defaults". */
export async function loadSiteConfig(): Promise<SiteConfig> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) return (siteConfig = {});
    const raw = (await response.json()) as Record<string, unknown>;
    siteConfig = {
      proxyUrl: cleanString(raw.proxyUrl).replace(/\/+$/, '') || undefined,
      accessCode: cleanString(raw.accessCode) || undefined,
      model: cleanString(raw.model) || undefined,
      effort: isEffort(raw.effort) ? raw.effort : undefined,
      notice: cleanString(raw.notice) || undefined,
    };
  } catch {
    siteConfig = {};
  }
  return siteConfig;
}

export function getSiteConfig(): SiteConfig {
  return siteConfig;
}

export function loadSettings(): BrowserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BrowserSettings>;
    return {
      apiKey: cleanString(parsed.apiKey),
      model: cleanString(parsed.model),
      effort: isEffort(parsed.effort) ? parsed.effort : '',
      baseUrl: cleanString(parsed.baseUrl).replace(/\/+$/, ''),
      accessCode: cleanString(parsed.accessCode),
    };
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

export function saveSettings(settings: BrowserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode or storage disabled: settings live for this page load only */
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Resolves what to use for the next Claude call. The visitor's own proxy wins,
 * then the visitor's own key (called directly), then the site's preset proxy.
 */
export function effectiveSettings(saved: BrowserSettings = loadSettings(), site: SiteConfig = siteConfig): EffectiveSettings {
  const model = saved.model || site.model || DEFAULT_MODEL;
  const effort: Effort = saved.effort || site.effort || 'high';
  if (saved.baseUrl) {
    return { apiKey: saved.apiKey, model, effort, baseUrl: saved.baseUrl, accessCode: saved.accessCode, source: 'own-proxy' };
  }
  if (saved.apiKey) {
    return { apiKey: saved.apiKey, model, effort, baseUrl: '', accessCode: '', source: 'own-key' };
  }
  if (site.proxyUrl) {
    return { apiKey: '', model, effort, baseUrl: site.proxyUrl, accessCode: site.accessCode ?? '', source: 'site-proxy' };
  }
  return { apiKey: '', model, effort, baseUrl: '', accessCode: '', source: 'none' };
}

/** True when Claude can be called: a key, or a proxy that holds one. */
export function hasCredentials(settings: EffectiveSettings = effectiveSettings()): boolean {
  return settings.source !== 'none';
}
