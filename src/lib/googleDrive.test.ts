/**
 * Save to Google Drive, against a fake Google sign-in (`google` global), a fake
 * Drive API (setDriveFetch) and an in-memory localStorage. Run with:
 *   node --import tsx --test src/lib/googleDrive.test.ts
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applySiteConfig } from '../browser/settings';
import {
  DRIVE_ROOT_FOLDER,
  DriveError,
  account,
  clientId,
  connect,
  disconnect,
  ensureFolder,
  folderUrl,
  isConnected,
  isDriveAvailable,
  isSignedIn,
  saveDocument,
  saveImage,
  setDriveFetch,
  uploadFile,
} from './googleDrive';

const CLIENT_ID = '1234567890-kiiku.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDERS_KEY = 'kiiku:drive-folders';

// ---------------------------------------------------------------------------
// Browser stand-ins
// ---------------------------------------------------------------------------

class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: Record<string, unknown>) => void;
  error_callback?: (error: { type: string }) => void;
}

/** Google Identity Services stand-in: each popup hands out the next token, or reports a closed popup when none are left. */
function installGoogle(tokens: string[], grantedScope = `${DRIVE_SCOPE} openid`) {
  const fake = { popups: [] as { prompt?: string }[], revoked: [] as string[] };
  const queue = [...tokens];
  (globalThis as { google?: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient(config: TokenClientConfig) {
          assert.equal(config.client_id, CLIENT_ID);
          assert.equal(config.scope, DRIVE_SCOPE, 'drive.file is the only scope requested');
          return {
            requestAccessToken(overrides?: { prompt?: string }) {
              fake.popups.push(overrides ?? {});
              const next = queue.shift();
              if (next) config.callback({ access_token: next, expires_in: 3599, scope: grantedScope });
              else config.error_callback?.({ type: 'popup_closed' });
            },
          };
        },
        revoke(accessToken: string, done?: (response: { successful: boolean }) => void) {
          fake.revoked.push(accessToken);
          done?.({ successful: true });
        },
      },
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Drive API stand-in
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

let restoreFetch: (() => void) | null = null;

/** Routes every request through `route`; an unrouted request fails the test. */
function fakeDrive(route: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  restoreFetch = setDriveFetch(async (url, init = {}) => {
    const call: Call = { method: init.method ?? 'GET', url: new URL(url), headers: { ...(init.headers as Record<string, string>) }, body: init.body };
    calls.push(call);
    const response = route(call);
    if (!response) throw new Error(`unexpected request: ${call.method} ${url}`);
    return response;
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionStart(location: string | null): Response {
  return new Response(null, { status: 200, headers: location ? { Location: location } : {} });
}

const isFolderList = (call: Call) => call.method === 'GET' && call.url.pathname === '/drive/v3/files';
const isFolderCreate = (call: Call) => call.method === 'POST' && call.url.pathname === '/drive/v3/files';
const isUploadStart = (call: Call) => call.method === 'POST' && call.url.pathname === '/upload/drive/v3/files';

beforeEach(async () => {
  applySiteConfig({ googleClientId: CLIENT_ID });
  installGoogle([]);
  await disconnect(); // forget the previous test's token and folders
  storage.clear();
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('reads the client id from the site config at runtime', () => {
    assert.equal(clientId(), CLIENT_ID);
    assert.equal(isDriveAvailable(), true);
    applySiteConfig({});
    assert.equal(clientId(), undefined, 'no config.json value, and no build-time value under node:test');
    assert.equal(isDriveAvailable(), false);
  });

  it('is unavailable inside the claude.ai artifact viewer, whose sandbox blocks Google sign-in', async () => {
    const host = globalThis as { claude?: unknown };
    host.claude = { use() {} };
    try {
      assert.equal(isDriveAvailable(), false);
      await assert.rejects(connect(), DriveError);
    } finally {
      delete host.claude;
    }
    assert.equal(isDriveAvailable(), true);
  });

  it('names the top folder and links to folders', () => {
    assert.equal(DRIVE_ROOT_FOLDER, 'Kiiku Study Buddy');
    assert.equal(folderUrl('abc_123'), 'https://drive.google.com/drive/folders/abc_123');
  });
});

describe('sign-in', () => {
  it("opens Google's popup synchronously, inside the caller's click, then reuses the token", async () => {
    const google = installGoogle(['tok-1']);
    const pending = connect();
    assert.equal(google.popups.length, 1, 'the popup must be requested before connect() awaits anything');
    assert.deepEqual(google.popups[0], { prompt: '' });
    assert.equal(await pending, 'tok-1');
    assert.equal(isSignedIn(), true);
    assert.equal(isConnected(), true);
    assert.equal(storage.getItem('kiiku:drive-connected'), '1');

    assert.equal(await connect(), 'tok-1', 'a valid token needs no second popup');
    assert.equal(google.popups.length, 1);
  });

  it('disconnect() revokes the grant and forgets the token, the flag and the folders', async () => {
    const google = installGoogle(['tok-1']);
    await connect();
    storage.setItem(FOLDERS_KEY, JSON.stringify({ [JSON.stringify([DRIVE_ROOT_FOLDER])]: 'folder-1' }));

    assert.equal(await disconnect(), true);
    assert.deepEqual(google.revoked, ['tok-1']);
    assert.equal(isSignedIn(), false);
    assert.equal(isConnected(), false);
    assert.equal(storage.getItem('kiiku:drive-connected'), null);
    assert.equal(storage.getItem(FOLDERS_KEY), null);
    assert.equal(await disconnect(), false, 'nothing left to revoke');
  });

  it('remembers the connection across reloads through the flag alone', () => {
    storage.setItem('kiiku:drive-connected', '1');
    assert.equal(isConnected(), true);
    assert.equal(isSignedIn(), false, 'the token itself is never stored');
  });

  it('treats a closed popup, or Drive left unticked, as a cancellation', async () => {
    installGoogle([]);
    await assert.rejects(connect(), (error: unknown) => error instanceof DriveError && error.cancelled && /closed/.test(error.message));
    installGoogle(['tok-1'], 'openid email');
    await assert.rejects(connect(), (error: unknown) => error instanceof DriveError && error.cancelled && /not granted/.test(error.message));
    assert.equal(isSignedIn(), false);
    assert.equal(isConnected(), false);
  });
});

describe('account', () => {
  it('reads the signed-in Google account, and never opens a popup by itself', async () => {
    const google = installGoogle(['tok-1']);
    await assert.rejects(account(), DriveError);
    assert.equal(google.popups.length, 0);

    const calls = fakeDrive((call) =>
      call.url.pathname === '/drive/v3/about' ? json({ user: { displayName: 'Ana Pereira', emailAddress: 'ana@example.com' } }) : undefined,
    );
    await connect();
    assert.deepEqual(await account(), { name: 'Ana Pereira', email: 'ana@example.com' });
    assert.equal(calls[0].url.searchParams.get('fields'), 'user(displayName,emailAddress)');
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
  });
});

describe('ensureFolder', () => {
  it('finds the top folder, creates the missing session folder, one level at a time', async () => {
    installGoogle(['tok-1']);
    const created: unknown[] = [];
    const calls = fakeDrive((call) => {
      if (isFolderList(call)) {
        const q = call.url.searchParams.get('q') ?? '';
        return json({ files: q.includes("'root' in parents") ? [{ id: 'top' }] : [] });
      }
      if (isFolderCreate(call)) {
        created.push(JSON.parse(String(call.body)));
        return json({ id: 'session' });
      }
      return undefined;
    });
    await connect();

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, "Bob's \\ biology"]), 'session');
    assert.deepEqual(
      calls.map((call) => call.url.searchParams.get('q')),
      [
        "name = 'Kiiku Study Buddy' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
        "name = 'Bob\\'s \\\\ biology' and mimeType = 'application/vnd.google-apps.folder' and 'top' in parents and trashed = false",
        null,
      ],
    );
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
    assert.deepEqual(created, [{ name: "Bob's \\ biology", mimeType: FOLDER_MIME, parents: ['top'] }]);
  });

  it('caches folder ids by path in localStorage, so repeat saves make no requests', async () => {
    installGoogle(['tok-1']);
    let next = 0;
    const calls = fakeDrive((call) => {
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) return json({ id: `folder-${++next}` });
      return undefined;
    });
    await connect();

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']), 'folder-2');
    assert.equal(calls.length, 4, 'two lookups, two creations');
    assert.deepEqual(JSON.parse(storage.getItem(FOLDERS_KEY) ?? '{}'), {
      [JSON.stringify([DRIVE_ROOT_FOLDER])]: 'folder-1',
      [JSON.stringify([DRIVE_ROOT_FOLDER, 'Biology'])]: 'folder-2',
    });

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, '  Biology ']), 'folder-2');
    assert.equal(calls.length, 4, 'a cached path needs no request');

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Chemistry']), 'folder-3');
    assert.equal(calls.length, 6, 'a new session reuses the cached top folder');
    assert.equal(calls[4].url.searchParams.get('q')?.includes("'folder-1' in parents"), true);
  });

  it('makes each folder once when several saves start together', async () => {
    installGoogle(['tok-1']);
    const created: string[] = [];
    fakeDrive((call) => {
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) {
        const { name } = JSON.parse(String(call.body)) as { name: string };
        created.push(name);
        return json({ id: `id-${name}` });
      }
      return undefined;
    });
    await connect();

    const ids = await Promise.all([
      ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']),
      ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']),
      ensureFolder([DRIVE_ROOT_FOLDER, 'Chemistry']),
    ]);
    assert.deepEqual(ids, ['id-Biology', 'id-Biology', 'id-Chemistry']);
    assert.deepEqual(created.sort(), ['Biology', 'Chemistry', DRIVE_ROOT_FOLDER].sort());
  });

  it('checks a folder cached on an earlier visit once, then trusts it', async () => {
    installGoogle(['tok-1']);
    storage.setItem(FOLDERS_KEY, JSON.stringify({ [JSON.stringify([DRIVE_ROOT_FOLDER, 'Biology'])]: 'kept' }));
    const calls = fakeDrive((call) => (call.url.pathname === '/drive/v3/files/kept' ? json({ id: 'kept', trashed: false }) : undefined));
    await connect();

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']), 'kept');
    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']), 'kept');
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url.pathname}?${call.url.searchParams}`),
      ['GET /drive/v3/files/kept?fields=id%2Ctrashed'],
    );
  });

  it('forgets a cached folder that returns 404 and looks the path up again, once', async () => {
    installGoogle(['tok-1']);
    storage.setItem(FOLDERS_KEY, JSON.stringify({ [JSON.stringify([DRIVE_ROOT_FOLDER, 'Biology'])]: 'deleted' }));
    const calls = fakeDrive((call) => {
      if (call.url.pathname === '/drive/v3/files/deleted') return json({ error: { message: 'File not found: deleted.' } }, 404);
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) return json({ id: `new-${(JSON.parse(String(call.body)) as { name: string }).name}` });
      return undefined;
    });
    await connect();

    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']), 'new-Biology');
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url.pathname}`),
      ['GET /drive/v3/files/deleted', 'GET /drive/v3/files', 'POST /drive/v3/files', 'GET /drive/v3/files', 'POST /drive/v3/files'],
    );
    assert.equal(storage.getItem(FOLDERS_KEY)?.includes('deleted'), false);
  });

  it('treats a cached folder in the bin like a deleted one', async () => {
    installGoogle(['tok-1']);
    storage.setItem(FOLDERS_KEY, JSON.stringify({ [JSON.stringify([DRIVE_ROOT_FOLDER])]: 'binned' }));
    fakeDrive((call) => {
      if (call.url.pathname === '/drive/v3/files/binned') return json({ id: 'binned', trashed: true });
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) return json({ id: 'fresh' });
      return undefined;
    });
    await connect();
    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER]), 'fresh');
  });
});

describe('uploadFile', () => {
  it('opens a resumable session, then sends the bytes to it, converting to a Google Doc', async () => {
    installGoogle(['tok-1']);
    const calls = fakeDrive((call) => {
      if (isUploadStart(call)) return sessionStart('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1');
      if (call.method === 'PUT' && call.url.searchParams.get('upload_id') === 'session-1') {
        return json({ id: 'doc-1', webViewLink: 'https://docs.google.com/document/d/doc-1/edit?usp=drivesdk' });
      }
      return undefined;
    });
    await connect();

    const body = new Blob(['PK not really a docx'], { type: DOCX_MIME });
    const file = await uploadFile({ name: 'Quiz — Cells', mimeType: DOCX_MIME, body, parentId: 'folder-1', convertTo: GOOGLE_DOC_MIME });
    assert.deepEqual(file, { id: 'doc-1', url: 'https://docs.google.com/document/d/doc-1/edit?usp=drivesdk' });

    assert.equal(calls.length, 2);
    const [start, put] = calls;
    assert.equal(start.url.searchParams.get('uploadType'), 'resumable');
    assert.equal(start.url.searchParams.get('fields'), 'id,webViewLink');
    assert.equal(start.headers.Authorization, 'Bearer tok-1');
    assert.equal(start.headers['X-Upload-Content-Type'], DOCX_MIME);
    assert.equal(start.headers['X-Upload-Content-Length'], String(body.size));
    assert.deepEqual(JSON.parse(String(start.body)), { name: 'Quiz — Cells', mimeType: GOOGLE_DOC_MIME, parents: ['folder-1'] });
    assert.equal(put.headers['Content-Type'], DOCX_MIME);
    assert.equal(put.headers.Authorization, undefined, 'the session URL carries its own authorisation');
    assert.equal(put.body, body);
  });

  it('falls back to one multipart request when the session URL cannot be read, up to 5 MB', async () => {
    installGoogle(['tok-1']);
    const calls = fakeDrive((call) => {
      if (call.url.searchParams.get('uploadType') === 'resumable') return sessionStart(null);
      if (call.url.searchParams.get('uploadType') === 'multipart') return json({ id: 'img-1' });
      return undefined;
    });
    await connect();

    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const file = await uploadFile({ name: 'Diagram 1.png', mimeType: 'image/png', body: png, parentId: 'folder-1' });
    assert.deepEqual(file, { id: 'img-1', url: 'https://drive.google.com/file/d/img-1/view' });
    const multipart = calls[1];
    assert.equal(multipart.headers.Authorization, 'Bearer tok-1');
    assert.match(multipart.headers['Content-Type'], /^multipart\/related; boundary=kiiku_\w+$/);
    const payload = await (multipart.body as Blob).text();
    assert.ok(payload.includes(JSON.stringify({ name: 'Diagram 1.png', mimeType: 'image/png', parents: ['folder-1'] })));
    assert.ok(payload.includes('Content-Type: image/png\r\n\r\n'));

    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' });
    await assert.rejects(uploadFile({ name: 'big.png', mimeType: 'image/png', body: big, parentId: 'folder-1' }), /too big to send in one request/);
    assert.equal(calls.filter((call) => call.url.searchParams.get('uploadType') === 'multipart').length, 1, 'the big file never went up');
  });

  it('signs in again once on a 401 and retries with the new token', async () => {
    const google = installGoogle(['tok-old', 'tok-new']);
    const calls = fakeDrive((call) => {
      if (call.headers.Authorization === 'Bearer tok-old') return json({ error: { message: 'Invalid Credentials' } }, 401);
      if (isUploadStart(call)) return sessionStart('https://upload.test/session');
      if (call.method === 'PUT') return json({ id: 'f-1' });
      return undefined;
    });
    await connect();

    const file = await uploadFile({ name: 'x.png', mimeType: 'image/png', body: new Blob(['x']), parentId: 'p' });
    assert.equal(file.id, 'f-1');
    assert.equal(google.popups.length, 2);
    assert.deepEqual(
      calls.map((call) => call.headers.Authorization),
      ['Bearer tok-old', 'Bearer tok-new', undefined],
    );
  });

  it('explains a 403 with the Drive API hint, and a network failure as a connection problem', async () => {
    installGoogle(['tok-1']);
    fakeDrive(() => new Response('', { status: 403, statusText: 'Forbidden' }));
    await connect();
    await assert.rejects(
      uploadFile({ name: 'x.png', mimeType: 'image/png', body: new Blob(['x']), parentId: 'p' }),
      /^DriveError: Google Drive refused the upload \(403 Forbidden\)\. Check that the Google Drive API is enabled for this OAuth client\.$/,
    );
    restoreFetch?.();

    fakeDrive(() => {
      throw new TypeError('Failed to fetch');
    });
    await assert.rejects(ensureFolder(['Anything']), /Could not reach Google Drive\. Check your connection and try again\./);
  });
});

describe('saveDocument and saveImage', () => {
  it('builds a real .docx and saves it as a Google Doc in the session folder', async () => {
    installGoogle(['tok-1']);
    let folders = 0;
    const calls = fakeDrive((call) => {
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) return json({ id: `folder-${++folders}` });
      if (isUploadStart(call)) return sessionStart('https://upload.test/session');
      if (call.method === 'PUT') return json({ id: 'doc-9' });
      return undefined;
    });
    await connect();

    const progress: string[] = [];
    const { url } = await saveDocument('# Quiz — Cells\n\nWhat does a **membrane** do?', {
      title: 'Quiz — Cells.docx',
      subtitle: 'Biology',
      folder: [DRIVE_ROOT_FOLDER, 'Biology'],
      onProgress: (message) => progress.push(message),
    });
    assert.equal(url, 'https://docs.google.com/document/d/doc-9/edit');

    const start = calls.find(isUploadStart)!;
    assert.deepEqual(JSON.parse(String(start.body)), { name: 'Quiz — Cells', mimeType: GOOGLE_DOC_MIME, parents: ['folder-2'] });
    assert.equal(start.headers['X-Upload-Content-Type'], DOCX_MIME);
    const put = calls.find((call) => call.method === 'PUT')!;
    const bytes = new Uint8Array(await (put.body as Blob).arrayBuffer());
    assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK', 'a real .docx (a zip) is uploaded');
    assert.equal(progress.at(-1), 'Uploading to Google Drive…');
  });

  it('saves a PNG as is, and recreates a folder deleted since it was cached', async () => {
    installGoogle(['tok-1']);
    let folders = 0;
    const calls = fakeDrive((call) => {
      if (isFolderList(call)) return json({ files: [] });
      if (isFolderCreate(call)) return json({ id: `folder-${++folders}` });
      if (isUploadStart(call)) {
        const { parents } = JSON.parse(String(call.body)) as { parents: string[] };
        // The first session folder was deleted in Drive after this page cached it.
        return parents[0] === 'folder-2' ? json({ error: { message: 'File not found: folder-2.' } }, 404) : sessionStart('https://upload.test/s');
      }
      if (call.method === 'PUT') return json({ id: 'png-1', webViewLink: 'https://drive.google.com/file/d/png-1/view?usp=drivesdk' });
      return undefined;
    });
    await connect();
    assert.equal(await ensureFolder([DRIVE_ROOT_FOLDER, 'Biology']), 'folder-2');

    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const { url } = await saveImage(png, 'Diagram 1 — The cell cycle', [DRIVE_ROOT_FOLDER, 'Biology']);
    assert.equal(url, 'https://drive.google.com/file/d/png-1/view?usp=drivesdk');

    const starts = calls.filter(isUploadStart).map((call) => JSON.parse(String(call.body)) as Record<string, unknown>);
    assert.deepEqual(starts, [
      { name: 'Diagram 1 — The cell cycle.png', mimeType: 'image/png', parents: ['folder-2'] },
      { name: 'Diagram 1 — The cell cycle.png', mimeType: 'image/png', parents: ['folder-4'] },
    ]);
    assert.equal(calls.filter(isUploadStart)[0].headers['X-Upload-Content-Type'], 'image/png');
  });
});
