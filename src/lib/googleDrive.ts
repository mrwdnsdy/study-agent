/**
 * Save to Google Drive. Every visitor signs in with their own Google account
 * (Google Identity Services' token model, entirely in the browser) and the app
 * saves into "Kiiku Study Buddy / <session title>" in that visitor's own Drive:
 * documents as .docx converted to Google Docs, diagrams as PNG. The only scope
 * is drive.file, so the app can see nothing but the files it created.
 *
 * Signing in opens a Google popup, and browsers only allow a popup from a
 * click. So a click handler calls `connect()` before it awaits anything else,
 * and menus call `preloadGoogleSignIn()` when they open so Google's script is
 * ready by the time the visitor clicks.
 */
import type { DocxExportOptions } from './exportDocx';
import { formatBytes } from './format';
import { isArtifactHost } from '../../shared/agent/providers/artifactSample';
import { getSiteConfig, parseGoogleClientId } from '../browser/settings';

/** Top-level folder in the visitor's Drive; each session gets a subfolder inside it. */
export const DRIVE_ROOT_FOLDER = 'Kiiku Study Buddy';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
/** Largest file Drive accepts in one multipart request; the resumable protocol has no such cap. */
const MULTIPART_LIMIT = 5 * 1024 * 1024;
/** Refresh the cached token this many ms before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** localStorage: '1' once the visitor has connected Drive in this browser. */
const CONNECTED_KEY = 'kiiku:drive-connected';
/** localStorage: folder ids by path, so repeat saves skip the lookups. */
const FOLDERS_KEY = 'kiiku:drive-folders';
const DRIVE_API_HINT = 'Check that the Google Drive API is enabled for this OAuth client.';

// ---------------------------------------------------------------------------
// Google Identity Services, the part used here (no @types package needed)
// ---------------------------------------------------------------------------

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  /** Space-separated scopes actually granted: with granular consent, Drive can be left unticked. */
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GisOAuth2 {
  initTokenClient(config: GisTokenClientConfig): GisTokenClient;
  revoke?(accessToken: string, done?: (response?: { successful?: boolean }) => void): void;
}

/** Read from globalThis rather than window so the module also runs under node:test with a fake. */
function gis(): GisOAuth2 | undefined {
  return (globalThis as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A failure worded for the visitor. `cancelled` marks a sign-in they closed or declined (worth an
 * info note, not an error); `status` is Drive's HTTP status when a request failed.
 */
export class DriveError extends Error {
  cancelled: boolean;
  status?: number;
  constructor(message: string, options: { cancelled?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'DriveError';
    this.cancelled = options.cancelled ?? false;
    this.status = options.status;
  }
}

export interface DriveAccount {
  name: string;
  email: string;
}

export interface DriveFile {
  id: string;
  /** Opens the file in Google Docs or Drive. */
  url: string;
}

export interface UploadRequest {
  name: string;
  /** Type of `body`. */
  mimeType: string;
  body: Blob;
  parentId: string;
  /** A Google type Drive converts the upload to, e.g. 'application/vnd.google-apps.document'. */
  convertTo?: string;
}

export interface SaveDocumentOptions {
  title: string;
  subtitle?: string;
  /** Folder path from the top of My Drive, e.g. [DRIVE_ROOT_FOLDER, session title]. */
  folder: string[];
  onProgress?: (message: string) => void;
  /** Diagram renderer for the .docx; "Save all" passes a cached one so each diagram is drawn once. */
  renderDiagram?: DocxExportOptions['renderDiagram'];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Looks the global up per call, so a page (or test) that replaces fetch later is honoured.
let fetcher: Fetch = (url, init) => fetch(url, init);

/** Replaces the network layer (tests). Returns a function that restores the previous one. */
export function setDriveFetch(next: Fetch): () => void {
  const previous = fetcher;
  fetcher = next;
  return () => {
    fetcher = previous;
  };
}

/** Vite inlines VITE_GOOGLE_CLIENT_ID at build time; under node:test there is no import.meta.env. */
function buildTimeClientId(): string | undefined {
  try {
    return parseGoogleClientId(import.meta.env.VITE_GOOGLE_CLIENT_ID);
  } catch {
    return undefined;
  }
}

/**
 * The OAuth client id, read at runtime: `googleClientId` from public/config.json, else the
 * build-time VITE_GOOGLE_CLIENT_ID. Undefined when neither is set.
 */
export function clientId(): string | undefined {
  return getSiteConfig().googleClientId ?? buildTimeClientId();
}

/**
 * True when this page can save straight to the visitor's Drive: a client id is configured and the
 * page is not inside the claude.ai artifact viewer, whose sandbox blocks Google's script and popup.
 */
export function isDriveAvailable(): boolean {
  return Boolean(clientId()) && !isArtifactHost();
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

let gisLoading: Promise<GisOAuth2> | null = null;
let token: { value: string; expiresAt: number } | null = null;
let pendingToken: Promise<string> | null = null;

/** Injects Google's sign-in script once and resolves when `google.accounts.oauth2` is ready. */
function loadGis(): Promise<GisOAuth2> {
  const ready = gis();
  if (ready) return Promise.resolve(ready);
  if (gisLoading) return gisLoading;
  gisLoading = new Promise<GisOAuth2>((resolve, reject) => {
    const fail = (): void => {
      gisLoading = null;
      reject(new DriveError('Could not load Google sign-in. Check your connection or ad blocker and try again.'));
    };
    const settle = (): boolean => {
      const api = gis();
      if (api) resolve(api);
      return Boolean(api);
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (!existing) {
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener(
        'load',
        () => {
          if (!settle()) fail();
        },
        { once: true },
      );
      script.addEventListener(
        'error',
        () => {
          script.remove(); // so the next attempt injects a fresh tag instead of waiting on this one
          fail();
        },
        { once: true },
      );
      document.head.appendChild(script);
      return;
    }
    // A tag added earlier may have finished loading before these listeners could see it: poll briefly.
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (settle()) window.clearInterval(poll);
      else if (Date.now() - started > 15_000) {
        window.clearInterval(poll);
        fail();
      }
    }, 150);
  });
  return gisLoading;
}

/** Starts loading Google sign-in so a click moments later can open its popup at once. Cheap to repeat. */
export function preloadGoogleSignIn(): void {
  if (!isDriveAvailable()) return;
  loadGis().catch(() => undefined); // reported when the visitor actually connects
}

function liveToken(): string | null {
  return token && token.expiresAt > Date.now() ? token.value : null;
}

/** True while a valid token is held, so saving needs no popup. */
export function isSignedIn(): boolean {
  return liveToken() !== null;
}

/**
 * True once the visitor has connected Drive in this browser and not disconnected. The token itself
 * lives in memory for an hour; after a reload the next save asks Google for a fresh one.
 */
export function isConnected(): boolean {
  return isSignedIn() || readFlag();
}

/**
 * Signs the visitor in to Google (a consent popup the first time) and resolves with a Drive access
 * token. Call it straight from a click handler, before any other await, so the browser lets the
 * popup open. Resolves at once while an earlier token is still valid.
 */
export function connect(): Promise<string> {
  const current = liveToken();
  return current ? Promise.resolve(current) : requestToken();
}

/** Asks Google for a fresh token; callers that overlap share one popup. */
function requestToken(): Promise<string> {
  if (pendingToken) return pendingToken;
  const id = clientId();
  if (!id || isArtifactHost()) return Promise.reject(new DriveError('Saving to Google Drive is not available on this page.'));
  const ready = gis();
  const request = ready
    ? askForToken(ready, id)
    : // Google's script is still loading (menus preload it, so this is rare; a first tap on a phone,
      // with no hover to preload on, is the usual case). The popup then opens after the click has
      // been handled and the browser may block it. By then the script is loaded, so trying again
      // works, and the error says exactly that.
      loadGis().then((loaded) => askForToken(loaded, id, true));
  const pending: Promise<string> = request.finally(() => {
    if (pendingToken === pending) pendingToken = null;
  });
  pendingToken = pending;
  return pending;
}

/**
 * Opens Google's popup synchronously (inside the caller's click) and settles with its answer.
 * `late` marks a request that had to wait for the script, outside the click.
 */
function askForToken(api: GisOAuth2, id: string, late = false): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let client: GisTokenClient;
    try {
      client = api.initTokenClient({
        client_id: id,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          try {
            resolve(acceptToken(response));
          } catch (error) {
            reject(error);
          }
        },
        error_callback: (error) => reject(signInError(error?.type, error?.message, late)),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new DriveError('Could not start Google sign-in.'));
      return;
    }
    try {
      // prompt '' shows the consent screen only the first time; later the popup closes by itself.
      client.requestAccessToken({ prompt: '' });
    } catch (error) {
      reject(error instanceof Error ? error : new DriveError('Could not open the Google sign-in popup.'));
    }
  });
}

/** Checks Google's answer, then caches the token and remembers the connection. */
function acceptToken(response: GisTokenResponse): string {
  if (response.error) {
    if (response.error === 'access_denied') {
      throw new DriveError('Google Drive access was declined, so nothing was saved.', { cancelled: true });
    }
    const detail = response.error_description ? ` (${response.error_description})` : '';
    throw new DriveError(`Google sign-in failed: ${response.error}${detail}`);
  }
  if (typeof response.scope === 'string' && !response.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
    throw new DriveError('Google Drive access was not granted. Try again and allow access to your Drive.', { cancelled: true });
  }
  if (!response.access_token) throw new DriveError('Google sign-in did not return an access token.');
  const seconds = Number(response.expires_in ?? 3600);
  token = {
    value: response.access_token,
    expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 - EXPIRY_MARGIN_MS,
  };
  writeFlag(true);
  return response.access_token;
}

function signInError(type: string | undefined, message: string | undefined, late: boolean): DriveError {
  switch (type) {
    case 'popup_closed':
      return new DriveError('Google sign-in was closed before access was granted, so nothing was saved.', { cancelled: true });
    case 'popup_failed_to_open':
      return new DriveError(
        late
          ? 'Google sign-in was still loading, so the browser held back its window. It is ready now: please try again.'
          : 'The Google sign-in popup was blocked. Allow popups for this site and try again.',
      );
    default:
      return new DriveError(message ? `Google sign-in failed: ${message}` : 'Google sign-in failed.');
  }
}

function readFlag(): boolean {
  try {
    return localStorage.getItem(CONNECTED_KEY) === '1';
  } catch {
    return false; // storage disabled (private mode, sandbox): the in-memory token still works
  }
}

function writeFlag(connected: boolean): void {
  try {
    if (connected) localStorage.setItem(CONNECTED_KEY, '1');
    else localStorage.removeItem(CONNECTED_KEY);
  } catch {
    /* storage disabled: the flag is only a hint for the UI */
  }
}

/**
 * Disconnects Drive: revokes the grant at Google when a token is at hand, then forgets the token,
 * the connected flag and the cached folders. Resolves false when nothing could be revoked (no token
 * since the last reload): the access then stays listed in the visitor's Google Account until they
 * remove it there.
 */
export async function disconnect(): Promise<boolean> {
  const held = token?.value;
  const api = gis();
  const revoke = api?.revoke;
  let revoked = false;
  if (held && api && revoke) {
    revoked = await new Promise<boolean>((resolve) => {
      // Never leave the button spinning if Google does not answer.
      const timer = setTimeout(() => resolve(false), 5_000);
      try {
        revoke.call(api, held, (response) => {
          clearTimeout(timer);
          resolve(response?.successful !== false);
        });
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }
  token = null;
  pendingToken = null;
  writeFlag(false);
  forgetFolders();
  return revoked;
}

/**
 * The Google account files are saved to. Never opens a popup: without a valid token it rejects, so
 * call connect() first (from a click) or check isSignedIn().
 */
export async function account(): Promise<DriveAccount> {
  const response = await driveFetch(ABOUT_URL, { method: 'GET' }, false);
  if (!response.ok) throw await httpError(response, 'account lookup');
  const about = (await response.json()) as { user?: { displayName?: string; emailAddress?: string } };
  return { name: about.user?.displayName?.trim() ?? '', email: about.user?.emailAddress?.trim() ?? '' };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface DriveRequest {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}

/** fetch, with a request that never got an answer turned into a readable error. */
async function send(url: string, request: DriveRequest): Promise<Response> {
  try {
    return await fetcher(url, request);
  } catch (error) {
    // fetch rejects with a TypeError when offline, on DNS failures and when something blocks the request.
    if (error instanceof TypeError) throw new DriveError('Could not reach Google Drive. Check your connection and try again.');
    throw error;
  }
}

/**
 * A Drive API request with the visitor's token. On a 401 (token revoked or expired early) it signs
 * in again once and retries. With `interactive` false it never opens a popup and rejects instead.
 */
async function driveFetch(url: string, request: DriveRequest, interactive = true): Promise<Response> {
  const authorised = (value: string): DriveRequest => ({ ...request, headers: { ...request.headers, Authorization: `Bearer ${value}` } });
  let current = liveToken();
  if (!current) {
    if (!interactive) throw new DriveError('Connect Google Drive first.');
    current = await requestToken();
  }
  let response = await send(url, authorised(current));
  if (response.status === 401) {
    if (token?.value === current) token = null;
    if (!interactive) throw new DriveError('Your Google sign-in has expired. Connect Google Drive again.', { status: 401 });
    response = await send(url, authorised(await requestToken()));
  }
  return response;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string };
      if (typeof json.error === 'string') return json.error;
      if (json.error?.message) return json.error.message;
    } catch {
      // not JSON
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/** A readable error for a failed Drive request; `what` names the request, e.g. "upload". */
async function httpError(response: Response, what: string): Promise<DriveError> {
  const detail = (await readErrorMessage(response)).trim();
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  if (response.status === 403) {
    // Google's own message is the most useful (disabled API, full Drive, rate limit); the hint covers an empty one.
    return new DriveError(`Google Drive refused the ${what} (${status}). ${detail || DRIVE_API_HINT}`, { status: 403 });
  }
  return new DriveError(`Google Drive ${what} failed (${status})${detail ? `: ${detail}` : ''}`, { status: response.status });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** Folder ids by path: read from localStorage once, then kept in memory and written through. */
let folderCache: Record<string, string> | null = null;
/** Folder ids seen to exist during this page load; a cached id from an earlier visit is checked once. */
const confirmedFolders = new Set<string>();
/** Folder lookups in progress by path, so saves started together share one folder instead of making two. */
const pendingFolders = new Map<string, Promise<string>>();

function folders(): Record<string, string> {
  if (!folderCache) {
    folderCache = {};
    try {
      const stored = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '{}') as unknown;
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [key, id] of Object.entries(stored)) if (typeof id === 'string' && id) folderCache[key] = id;
      }
    } catch {
      /* storage disabled or corrupt: start empty */
    }
  }
  return folderCache;
}

/** Unambiguous even when a name contains a slash. */
function folderKey(names: string[]): string {
  return JSON.stringify(names);
}

function rememberFolder(names: string[], id: string): void {
  const cache = folders();
  cache[folderKey(names)] = id;
  confirmedFolders.add(id);
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(cache));
  } catch {
    /* storage disabled: remembered for this page load only */
  }
}

function forgetFolders(): void {
  folderCache = null;
  confirmedFolders.clear();
  pendingFolders.clear();
  try {
    localStorage.removeItem(FOLDERS_KEY);
  } catch {
    /* nothing stored */
  }
}

function cleanName(name: string, fallback: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

/** Drive's query language quotes strings with ' and escapes \ and ' inside them. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function queryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * Finds or creates a folder path in the visitor's Drive, one level at a time from My Drive, and
 * resolves with the last folder's id. Ids are cached by path; a cached folder that has gone
 * (deleted, in the bin, or made under another Google account) is forgotten and the path looked up
 * again, once.
 */
export async function ensureFolder(path: string[]): Promise<string> {
  const names = path.map((name) => cleanName(name, 'Untitled'));
  if (names.length === 0) return 'root';
  const cached = deepestCachedFolder(names);
  if (!cached) return walkFolders(names, 0, 'root');
  try {
    if (!confirmedFolders.has(cached.id)) await checkFolder(cached.id);
    return await walkFolders(names, cached.depth, cached.id);
  } catch (error) {
    if (!(error instanceof DriveError && error.status === 404)) throw error;
    forgetFolders();
    return walkFolders(names, 0, 'root');
  }
}

function deepestCachedFolder(names: string[]): { id: string; depth: number } | null {
  const cache = folders();
  for (let depth = names.length; depth > 0; depth--) {
    const id = cache[folderKey(names.slice(0, depth))];
    if (id) return { id, depth };
  }
  return null;
}

/** Confirms a cached folder still exists; one that is gone or in the bin counts as a 404. */
async function checkFolder(id: string): Promise<void> {
  const response = await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}?fields=id,trashed`, { method: 'GET' });
  if (!response.ok) throw await httpError(response, 'folder lookup');
  const folder = (await response.json()) as { trashed?: boolean };
  if (folder.trashed) throw new DriveError('The Drive folder is in the bin.', { status: 404 });
  confirmedFolders.add(id);
}

/** Walks down from `parentId`, `depth` levels in, finding or creating each remaining folder. */
async function walkFolders(names: string[], depth: number, parentId: string): Promise<string> {
  let parent = parentId;
  for (let level = depth; level < names.length; level++) parent = await folderAt(names.slice(0, level + 1), parent);
  return parent;
}

/** Finds or creates the last folder of `path` inside `parentId`, sharing the request with any save already doing the same. */
function folderAt(path: string[], parentId: string): Promise<string> {
  const key = folderKey(path);
  const running = pendingFolders.get(key);
  if (running) return running;
  const name = path[path.length - 1];
  const lookup = (async () => {
    const id = (await findFolder(name, parentId)) ?? (await createFolder(name, parentId));
    rememberFolder(path, id);
    return id;
  })();
  const shared: Promise<string> = lookup.finally(() => {
    if (pendingFolders.get(key) === shared) pendingFolders.delete(key);
  });
  pendingFolders.set(key, shared);
  return shared;
}

async function findFolder(name: string, parentId: string): Promise<string | null> {
  const q = `name = ${quote(name)} and mimeType = '${FOLDER_MIME}' and ${quote(parentId)} in parents and trashed = false`;
  // The oldest match wins, so saves keep landing in the same folder if a duplicate ever appears.
  const url = `${FILES_URL}?${queryString({ q, fields: 'files(id)', orderBy: 'createdTime', pageSize: '1', spaces: 'drive' })}`;
  const response = await driveFetch(url, { method: 'GET' });
  if (!response.ok) throw await httpError(response, 'folder lookup');
  const list = (await response.json()) as { files?: { id?: string }[] };
  return list.files?.find((file) => file.id)?.id ?? null;
}

async function createFolder(name: string, parentId: string): Promise<string> {
  const response = await driveFetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!response.ok) throw await httpError(response, 'folder creation');
  const folder = (await response.json()) as { id?: string };
  if (!folder.id) throw new DriveError('Google Drive did not return a folder id.');
  return folder.id;
}

/** Opens a folder in Google Drive. */
export function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function fileUrl(id: string, mimeType: string): string {
  return mimeType === GOOGLE_DOC_MIME ? `https://docs.google.com/document/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
}

/** Metadata and bytes in one request: Drive's multipart upload, limited to 5 MB. */
function postMultipart(metadata: string, mimeType: string, body: Blob): Promise<Response> {
  const boundary = `kiiku_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const payload = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      body,
      `\r\n--${boundary}--\r\n`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  return driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: payload,
  });
}

/**
 * Uploads a file into a Drive folder with the resumable protocol, which has no size cap: one
 * request opens an upload session, a second sends the bytes to it. With `convertTo`, Drive
 * converts the upload, e.g. a .docx into a Google Doc.
 */
export async function uploadFile({ name, mimeType, body, parentId, convertTo }: UploadRequest): Promise<DriveFile> {
  const metadata = JSON.stringify({ name, mimeType: convertTo ?? mimeType, parents: [parentId] });
  const session = await driveFetch(`${UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(body.size),
    },
    body: metadata,
  });
  if (!session.ok) throw await httpError(session, 'upload');
  const location = session.headers.get('Location');
  let response: Response;
  if (location) {
    // The session URL authorises the upload by itself, so the bytes go without the token.
    response = await send(location, { method: 'PUT', headers: { 'Content-Type': mimeType }, body });
  } else {
    // Google always sends the session URL, but the page can read it only when CORS exposes the
    // header, which some privacy extensions and proxies prevent. Small files fit in one request.
    if (body.size > MULTIPART_LIMIT) {
      throw new DriveError(
        `Google Drive did not return an upload address, and this file (${formatBytes(body.size)}) is too big to send in one request. ` +
          'Check that no browser extension or proxy is interfering with Google Drive, then try again.',
      );
    }
    response = await postMultipart(metadata, mimeType, body);
  }
  if (!response.ok) throw await httpError(response, 'upload');
  const file = (await response.json()) as { id?: string; webViewLink?: string };
  if (!file.id) throw new DriveError('Google Drive did not return a file id.');
  return { id: file.id, url: file.webViewLink ?? fileUrl(file.id, convertTo ?? mimeType) };
}

/** Uploads into a folder path; if the folder vanished after it was cached, finds it again and retries once. */
async function uploadToFolder(folder: string[], file: Omit<UploadRequest, 'parentId'>): Promise<DriveFile> {
  const parentId = await ensureFolder(folder);
  try {
    return await uploadFile({ ...file, parentId });
  } catch (error) {
    if (!(error instanceof DriveError && error.status === 404)) throw error;
    forgetFolders();
    return uploadFile({ ...file, parentId: await ensureFolder(folder) });
  }
}

/** Builds a .docx from markdown and saves it to the folder as a Google Doc named after the title. */
export async function saveDocument(markdown: string, options: SaveDocumentOptions): Promise<{ url: string }> {
  // Loaded on demand: the .docx builder is large and most visits never export.
  const { DOCX_MIME_TYPE, markdownToDocxBlob } = await import('./exportDocx');
  const title = cleanName(options.title.replace(/\.docx$/i, ''), 'Untitled document');
  const docx = await markdownToDocxBlob(markdown, {
    title,
    subtitle: options.subtitle,
    onProgress: options.onProgress,
    renderDiagram: options.renderDiagram,
  });
  options.onProgress?.('Uploading to Google Drive…');
  const file = await uploadToFolder(options.folder, { name: title, mimeType: DOCX_MIME_TYPE, body: docx, convertTo: GOOGLE_DOC_MIME });
  return { url: file.url };
}

/** Saves a PNG to the folder as an image file (no conversion). */
export async function saveImage(png: Blob, name: string, folder: string[]): Promise<{ url: string }> {
  const base = cleanName(name.replace(/\.png$/i, ''), 'Diagram');
  const file = await uploadToFolder(folder, { name: `${base}.png`, mimeType: 'image/png', body: png });
  return { url: file.url };
}
