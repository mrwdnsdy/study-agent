import { AGENT_TASKS, DEFAULT_AGENT_NAME, DEFAULT_ESCALATION_MODEL, isEffort, resolveTaskModels, type Effort } from '../../shared/agent/constants';
import type { TaskModels } from '../../shared/types';

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
  /** One model for every task (rarely wanted; prefer `models`). */
  model?: string;
  /** Model per task; missing tasks use the built-in defaults. */
  models?: Partial<TaskModels>;
  /** Model for maximum-quality guides and for retries when a model declines; "off" disables it. */
  escalationModel?: string;
  effort?: Effort;
  notice?: string;
  /** Persona name of the study agent (default: Kiiku). */
  agentName?: string;
}

export type CredentialSource = 'own-key' | 'own-proxy' | 'site-proxy' | 'none';

/** Fully resolved values used to call Claude. */
export interface EffectiveSettings {
  apiKey: string;
  agentName: string;
  models: TaskModels;
  escalationModel?: string;
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
    const rawModels = raw.models && typeof raw.models === 'object' ? (raw.models as Record<string, unknown>) : {};
    const models: Partial<TaskModels> = {};
    for (const task of AGENT_TASKS) {
      const value = cleanString(rawModels[task]);
      if (value) models[task] = value;
    }
    siteConfig = {
      proxyUrl: cleanString(raw.proxyUrl).replace(/\/+$/, '') || undefined,
      accessCode: cleanString(raw.accessCode) || undefined,
      model: cleanString(raw.model) || undefined,
      models: Object.keys(models).length ? models : undefined,
      escalationModel: cleanString(raw.escalationModel) || undefined,
      effort: isEffort(raw.effort) ? raw.effort : undefined,
      notice: cleanString(raw.notice) || undefined,
      agentName: cleanString(raw.agentName) || undefined,
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
 * A model the visitor typed applies to every task; otherwise the site's
 * per-task map (over the built-in defaults) is used.
 */
export function effectiveSettings(saved: BrowserSettings = loadSettings(), site: SiteConfig = siteConfig): EffectiveSettings {
  const models = saved.model ? resolveTaskModels({}, saved.model) : resolveTaskModels(site.models ?? {}, site.model);
  const escalationModel =
    site.escalationModel === undefined ? DEFAULT_ESCALATION_MODEL : site.escalationModel.toLowerCase() === 'off' ? undefined : site.escalationModel;
  const effort: Effort = saved.effort || site.effort || 'high';
  const base = { models, escalationModel, effort, agentName: site.agentName ?? DEFAULT_AGENT_NAME };
  if (saved.baseUrl) {
    return { ...base, apiKey: saved.apiKey, baseUrl: saved.baseUrl, accessCode: saved.accessCode, source: 'own-proxy' };
  }
  if (saved.apiKey) {
    return { ...base, apiKey: saved.apiKey, baseUrl: '', accessCode: '', source: 'own-key' };
  }
  if (site.proxyUrl) {
    return { ...base, apiKey: '', baseUrl: site.proxyUrl, accessCode: site.accessCode ?? '', source: 'site-proxy' };
  }
  return { ...base, apiKey: '', baseUrl: '', accessCode: '', source: 'none' };
}

/** True when Claude can be called: a key, or a proxy that holds one. */
export function hasCredentials(settings: EffectiveSettings = effectiveSettings()): boolean {
  return settings.source !== 'none';
}
