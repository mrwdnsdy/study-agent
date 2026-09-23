import {
  AGENT_TASKS,
  DEFAULT_AGENT_NAME,
  DEFAULT_ESCALATION_MODEL,
  DEFAULT_TASK_MODELS,
  displayModel,
  isEffort,
  parseModelRef,
  resolveTaskModels,
  type Effort,
} from '../../shared/agent/constants';
import { isArtifactHost } from '../../shared/agent/providers/artifactSample';
import type { AgentTask, LaneInfo, ProviderId, TaskModels } from '../../shared/types';

/**
 * What the visitor typed in Settings. Every field is optional: an empty or
 * missing value means "use the site default" from public/config.json.
 */
export interface BrowserSettings {
  /** The visitor's own Anthropic API key. Stays in this browser's localStorage. */
  apiKey: string;
  /** One model for every task (overrides the lane). */
  model: string;
  effort: Effort | '';
  /** The visitor's own proxy (see proxy/). Empty: call api.anthropic.com directly, or use the site proxy. */
  baseUrl: string;
  accessCode: string;
  /** Chosen lane id when the site offers several (e.g. "free" or "claude"). */
  lane: string;
}

type TaskModelOverrides = Partial<Record<AgentTask, string | string[]>>;

/** A selectable set of model chains, e.g. the free chain or the Claude models. */
export interface LaneConfig {
  label?: string;
  /** Model chain per task; missing tasks fall back to `model`, then the built-in defaults. */
  models?: TaskModelOverrides;
  /** One chain for every task. */
  model?: string | string[];
  /** Model for maximum-quality guides and retries when a model declines; "off" disables it. */
  escalationModel?: string;
}

/**
 * Defaults the site owner ships in public/config.json so visitors need no
 * setup: a proxy that holds the owner's keys, the lanes (model chains) to
 * choose from, and a short notice shown in Settings.
 */
export interface SiteConfig {
  proxyUrl?: string;
  accessCode?: string;
  /** Legacy single-lane form: one model (or chain) for every task. */
  model?: string | string[];
  models?: TaskModelOverrides;
  escalationModel?: string;
  /** Named lanes the visitor can switch between in Settings. */
  lanes?: Record<string, LaneConfig>;
  defaultLane?: string;
  effort?: Effort;
  notice?: string;
  /** Persona name of the study agent (default: Kiiku). */
  agentName?: string;
  /** Which providers the site proxy has keys for (fetched from the proxy). */
  providers?: Partial<Record<ProviderId, boolean>>;
  /** True inside the claude.ai artifact viewer, where "artifact/…" models reach Claude on the viewer's own account. */
  artifact?: boolean;
  /** False for a white-label page: the UI never names the providers or models in use. */
  showModels?: boolean;
}

export type CredentialSource = 'own-key' | 'own-proxy' | 'site-proxy' | 'artifact' | 'none';

/** Fully resolved values used to call the models. */
export interface EffectiveSettings {
  apiKey: string;
  agentName: string;
  models: TaskModels;
  escalationModel?: string;
  effort: Effort;
  baseUrl: string;
  accessCode: string;
  source: CredentialSource;
  /** Active lane id and the lanes on offer (empty when the site defines none). */
  lane?: string;
  lanes: LaneInfo[];
  providers?: Partial<Record<ProviderId, boolean>>;
  /** False for a white-label page. */
  showModels: boolean;
}

const STORAGE_KEY = 'study-agent:settings';

export const EMPTY_SETTINGS: BrowserSettings = { apiKey: '', model: '', effort: '', baseUrl: '', accessCode: '', lane: '' };

let siteConfig: SiteConfig = {};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanChain(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.map(cleanString).filter(Boolean);
    return list.length ? list : undefined;
  }
  return cleanString(value) || undefined;
}

function cleanModels(raw: unknown): TaskModelOverrides | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const models: TaskModelOverrides = {};
  for (const task of AGENT_TASKS) {
    const chain = cleanChain((raw as Record<string, unknown>)[task]);
    if (chain) models[task] = chain;
  }
  return Object.keys(models).length ? models : undefined;
}

function cleanLane(raw: unknown): LaneConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    label: cleanString(r.label) || undefined,
    models: cleanModels(r.models),
    model: cleanChain(r.model),
    escalationModel: cleanString(r.escalationModel) || undefined,
  };
}

function parseSiteConfig(raw: Record<string, unknown>): SiteConfig {
  const lanes: Record<string, LaneConfig> = {};
  if (raw.lanes && typeof raw.lanes === 'object') {
    for (const [id, value] of Object.entries(raw.lanes as Record<string, unknown>)) {
      const lane = cleanLane(value);
      if (lane && /^[a-z0-9_-]+$/i.test(id)) lanes[id] = lane;
    }
  }
  return {
    proxyUrl: cleanString(raw.proxyUrl).replace(/\/+$/, '') || undefined,
    accessCode: cleanString(raw.accessCode) || undefined,
    model: cleanChain(raw.model),
    models: cleanModels(raw.models),
    escalationModel: cleanString(raw.escalationModel) || undefined,
    lanes: Object.keys(lanes).length ? lanes : undefined,
    defaultLane: cleanString(raw.defaultLane) || undefined,
    effort: isEffort(raw.effort) ? raw.effort : undefined,
    notice: cleanString(raw.notice) || undefined,
    agentName: cleanString(raw.agentName) || undefined,
    showModels: raw.showModels === false ? false : undefined,
  };
}

/**
 * Loads the site defaults once at start-up (browser mode only): the config baked into the
 * build (VITE_SITE_CONFIG, used by the artifact build) or public/config.json. Missing or
 * invalid config means "no defaults".
 */
export async function loadSiteConfig(): Promise<SiteConfig> {
  try {
    const embedded = import.meta.env.VITE_SITE_CONFIG as string | undefined;
    let raw: Record<string, unknown> | null = null;
    if (embedded) {
      raw = JSON.parse(embedded) as Record<string, unknown>;
    } else {
      const response = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.ok) raw = (await response.json()) as Record<string, unknown>;
    }
    siteConfig = raw ? parseSiteConfig(raw) : {};
    siteConfig.artifact = isArtifactHost();
    if (siteConfig.proxyUrl) siteConfig.providers = await fetchProviders(siteConfig.proxyUrl);
  } catch {
    siteConfig = { artifact: isArtifactHost() };
  }
  return siteConfig;
}

/** Asks the proxy which provider keys it holds (best effort, short timeout). */
async function fetchProviders(proxyUrl: string): Promise<Partial<Record<ProviderId, boolean>> | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${proxyUrl}/providers`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!response.ok) return undefined;
    const raw = (await response.json()) as Record<string, unknown>;
    const out: Partial<Record<ProviderId, boolean>> = {};
    for (const id of ['anthropic', 'gemini', 'openrouter', 'zai', 'workers-ai'] as ProviderId[]) {
      if (typeof raw[id] === 'boolean') out[id] = raw[id] as boolean;
    }
    return out;
  } catch {
    return undefined;
  }
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
      lane: cleanString(parsed.lane),
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

function allFrom(provider: ProviderId, models: TaskModels, escalation?: string): boolean {
  return [...Object.values(models).flat(), ...(escalation ? [escalation] : [])].every((ref) => parseModelRef(ref).provider === provider);
}

function allAnthropic(models: TaskModels, escalation?: string): boolean {
  return allFrom('anthropic', models, escalation);
}

/** "off" disables; undefined means "Fable when everything else is Claude, otherwise none". */
function resolveEscalation(configured: string | undefined, models: TaskModels): string | undefined {
  if (configured === undefined) return allAnthropic(models) ? DEFAULT_ESCALATION_MODEL : undefined;
  return configured.toLowerCase() === 'off' ? undefined : configured;
}

interface ResolvedLane {
  id?: string;
  models: TaskModels;
  escalationModel?: string;
}

function resolveLaneModels(lane: LaneConfig, site: SiteConfig): ResolvedLane {
  const models = resolveTaskModels(lane.models ?? {}, lane.model ?? site.model);
  return { models, escalationModel: resolveEscalation(lane.escalationModel, models) };
}

function pickLane(site: SiteConfig, wanted: string): ResolvedLane {
  const lanes = site.lanes ?? {};
  const ids = Object.keys(lanes);
  if (ids.length === 0) {
    const models = resolveTaskModels(site.models ?? {}, site.model);
    return { models, escalationModel: resolveEscalation(site.escalationModel, models) };
  }
  const id = wanted && lanes[wanted] ? wanted : site.defaultLane && lanes[site.defaultLane] ? site.defaultLane : ids[0];
  return { id, ...resolveLaneModels(lanes[id], site) };
}

function laneInfos(site: SiteConfig): LaneInfo[] {
  return Object.entries(site.lanes ?? {}).map(([id, lane]) => {
    const resolved = resolveLaneModels(lane, site);
    return { id, label: lane.label ?? id, primary: displayModel(resolved.models.guide), escalation: displayModel(resolved.escalationModel) || undefined };
  });
}

/**
 * Resolves what to use for the next model call. The visitor's own proxy wins,
 * then the visitor's own key (called directly, Claude only), then the site's
 * preset proxy with the chosen lane, then the artifact runtime when the page is a
 * claude.ai artifact. A model the visitor typed applies to every task.
 */
export function effectiveSettings(saved: BrowserSettings = loadSettings(), site: SiteConfig = siteConfig): EffectiveSettings {
  const effort: Effort = saved.effort || site.effort || 'high';
  const agentName = site.agentName ?? DEFAULT_AGENT_NAME;
  const lanes = laneInfos(site);
  const showModels = site.showModels !== false;

  if (saved.baseUrl) {
    const lane = pickLane(site, saved.lane);
    const models = saved.model ? resolveTaskModels({}, saved.model) : lane.models;
    return {
      apiKey: saved.apiKey,
      agentName,
      models,
      escalationModel: lane.escalationModel,
      effort,
      baseUrl: saved.baseUrl,
      accessCode: saved.accessCode,
      source: 'own-proxy',
      lane: lane.id,
      lanes,
      showModels,
    };
  }
  if (saved.apiKey) {
    // Only Claude is reachable with a bare key: prefer the site's Claude lane, else the built-in Claude defaults.
    const claudeLane = site.lanes?.claude ? resolveLaneModels(site.lanes.claude, site) : undefined;
    const base = claudeLane?.models ?? DEFAULT_TASK_MODELS;
    const models = saved.model ? resolveTaskModels({}, saved.model) : base;
    return {
      apiKey: saved.apiKey,
      agentName,
      models,
      escalationModel: claudeLane ? claudeLane.escalationModel : DEFAULT_ESCALATION_MODEL,
      effort,
      baseUrl: '',
      accessCode: '',
      source: 'own-key',
      lane: claudeLane ? 'claude' : undefined,
      lanes,
      showModels,
    };
  }
  const lane = pickLane(site, saved.lane);
  const models = saved.model ? resolveTaskModels({}, saved.model) : lane.models;
  const base = { apiKey: '', agentName, models, escalationModel: lane.escalationModel, effort, lane: lane.id, lanes, providers: site.providers, showModels };
  if (site.proxyUrl) {
    return { ...base, baseUrl: site.proxyUrl, accessCode: site.accessCode ?? '', source: 'site-proxy' };
  }
  // Inside the claude.ai artifact viewer, "artifact/…" models run on the viewer's own Claude account: nothing to configure.
  if (site.artifact && allFrom('artifact', models, lane.escalationModel)) {
    return { ...base, baseUrl: '', accessCode: '', source: 'artifact' };
  }
  return { ...base, baseUrl: '', accessCode: '', source: 'none' };
}

/** True when a model can be called: a key, or a proxy that holds one. */
export function hasCredentials(settings: EffectiveSettings = effectiveSettings()): boolean {
  return settings.source !== 'none';
}
