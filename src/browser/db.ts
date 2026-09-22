import type { MaterialKind, Session } from '../../shared/types';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export type BrowserPart =
  | { type: 'pdf'; fileId: string; pages?: number }
  | { type: 'image'; fileId: string; mediaType: ImageMediaType; label?: string }
  | { type: 'text'; text: string; label?: string };

/** Private (extracted) form of a material, kept out of the public Session object. */
export interface BrowserMaterial {
  id: string;
  name: string;
  kind: MaterialKind;
  summary: string;
  pages?: number;
  imageCount?: number;
  parts: BrowserPart[];
}

interface MaterialsRecord {
  id: string;
  items: BrowserMaterial[];
}

const DB_NAME = 'study-agent';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const MATERIALS = 'materials';
const FILES = 'files';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support IndexedDB, which browser mode needs to store your sessions.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(MATERIALS)) db.createObjectStore(MATERIALS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
      request.onblocked = () => reject(new Error('The local database is open in another tab. Close it and reload.'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Local database operation failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Local database transaction aborted.'));
      }),
  );
}

export const localDb = {
  allSessions: () => run<Session[]>(SESSIONS, 'readonly', (s) => s.getAll() as IDBRequest<Session[]>),
  getSession: (id: string) => run<Session | undefined>(SESSIONS, 'readonly', (s) => s.get(id) as IDBRequest<Session | undefined>),
  putSession: (session: Session) => run(SESSIONS, 'readwrite', (s) => s.put(session)),
  deleteSession: (id: string) => run(SESSIONS, 'readwrite', (s) => s.delete(id)),

  getMaterials: async (sessionId: string): Promise<BrowserMaterial[]> => {
    const record = await run<MaterialsRecord | undefined>(MATERIALS, 'readonly', (s) => s.get(sessionId) as IDBRequest<MaterialsRecord | undefined>);
    return record?.items ?? [];
  },
  putMaterials: (sessionId: string, items: BrowserMaterial[]) =>
    run(MATERIALS, 'readwrite', (s) => s.put({ id: sessionId, items } satisfies MaterialsRecord)),
  deleteMaterials: (sessionId: string) => run(MATERIALS, 'readwrite', (s) => s.delete(sessionId)),

  getFile: (fileId: string) => run<Blob | undefined>(FILES, 'readonly', (s) => s.get(fileId) as IDBRequest<Blob | undefined>),
  putFile: (fileId: string, blob: Blob) => run(FILES, 'readwrite', (s) => s.put(blob, fileId)),
  deleteFile: (fileId: string) => run(FILES, 'readwrite', (s) => s.delete(fileId)),
};

export function partFileIds(material: BrowserMaterial): string[] {
  return material.parts.flatMap((p) => (p.type === 'text' ? [] : [p.fileId]));
}
