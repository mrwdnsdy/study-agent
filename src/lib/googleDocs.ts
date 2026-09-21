/**
 * "Open in Google Docs": upload a DOCX to Google Drive with conversion to a
 * native Google Doc. Uses Google Identity Services (GIS) for OAuth in the
 * browser; no server round-trip and no @types package required.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
/** Refresh the cached token this many ms before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
  prompt?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(config: GisTokenClientConfig): GisTokenClient;
        };
      };
    };
  }
}

/** True when a Google OAuth client id has been configured for this build. */
export function isGoogleDocsConfigured(): boolean {
  return Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);
}

let gisLoading: Promise<void> | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

function clientId(): string {
  const id = String(import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  if (!id) throw new Error('Google Docs export is not configured (VITE_GOOGLE_CLIENT_ID is missing).');
  return id;
}

/** Inject the GIS script once and resolve when `google.accounts.oauth2` is available. */
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise<void>((resolve, reject) => {
    const fail = (): void => {
      gisLoading = null;
      reject(new Error('Could not load Google Sign-In. Check your connection or ad blocker and try again.'));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    const onLoad = (): void => {
      if (window.google?.accounts?.oauth2) resolve();
      else fail();
    };
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
      return;
    }
    // A tag added elsewhere may have finished loading before our listeners were attached: poll briefly.
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(poll);
        resolve();
      } else if (Date.now() - started > 15_000) {
        window.clearInterval(poll);
        fail();
      }
    }, 150);
  });
  return gisLoading;
}

function describeGisError(type?: string, message?: string): string {
  switch (type) {
    case 'popup_closed':
      return 'Google sign-in was cancelled before access was granted.';
    case 'popup_failed_to_open':
      return 'The Google sign-in popup was blocked. Allow popups for this site and try again.';
    default:
      return message ? `Google sign-in failed: ${message}` : 'Google sign-in failed.';
  }
}

/** Get a Drive access token, prompting the user only when the cached one is missing or stale. */
async function getAccessToken(forceNew = false): Promise<string> {
  if (!forceNew && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  cachedToken = null;
  const id = clientId();
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google Sign-In loaded but the OAuth client is unavailable.');

  const token = await new Promise<string>((resolve, reject) => {
    let client: GisTokenClient;
    try {
      client = oauth2.initTokenClient({
        client_id: id,
        scope: DRIVE_SCOPE,
        callback: (response) => {
          if (response.error) {
            const detail = response.error_description ? ` (${response.error_description})` : '';
            reject(
              new Error(
                response.error === 'access_denied'
                  ? 'Google Drive access was denied. Grant access to create the document.'
                  : `Google sign-in failed: ${response.error}${detail}`,
              ),
            );
            return;
          }
          const accessToken = response.access_token;
          if (!accessToken) {
            reject(new Error('Google sign-in did not return an access token.'));
            return;
          }
          const expiresIn = Number(response.expires_in ?? 3600);
          cachedToken = {
            token: accessToken,
            expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000 - EXPIRY_MARGIN_MS,
          };
          resolve(accessToken);
        },
        error_callback: (error) => reject(new Error(describeGisError(error?.type, error?.message))),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not initialise Google sign-in.'));
      return;
    }
    try {
      client.requestAccessToken({ prompt: '' });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not open the Google sign-in popup.'));
    }
  });
  return token;
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

async function postMultipart(token: string, body: Blob, boundary: string): Promise<Response> {
  return fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

/**
 * Upload `docx` to Google Drive, converting it to a Google Doc named `name`.
 * Resolves with the new file id and a link that opens it in Google Docs.
 */
export async function uploadDocxToGoogleDocs(docx: Blob, name: string): Promise<{ id: string; url: string }> {
  const docName = (name ?? '').replace(/\.docx$/i, '').trim() || 'Study guide';
  const boundary = `prereq_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const metadata = JSON.stringify({ name: docName, mimeType: GOOGLE_DOC_MIME });
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`,
      docx,
      `\r\n--${boundary}--\r\n`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );

  let response: Response;
  try {
    response = await postMultipart(await getAccessToken(), body, boundary);
    if (response.status === 401) {
      // Token revoked or expired early: prompt once more and retry.
      response = await postMultipart(await getAccessToken(true), body, boundary);
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Could not reach Google Drive. Check your connection and try again.');
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    if (response.status === 403) {
      throw new Error(`Google Drive refused the upload (${status}). ${detail || 'Check that the Drive API is enabled for this OAuth client.'}`);
    }
    throw new Error(`Google Drive upload failed (${status})${detail ? `: ${detail}` : ''}`);
  }

  const result = (await response.json()) as { id?: string; webViewLink?: string };
  if (!result.id) throw new Error('Google Drive did not return a document id.');
  return { id: result.id, url: result.webViewLink ?? `https://docs.google.com/document/d/${result.id}/edit` };
}
