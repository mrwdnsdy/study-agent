import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, SessionSummary } from '../../shared/types.js';
import { blankSession, summarizeSession } from '../../shared/session.js';
import type { ExtractedMaterial } from './extract.js';
import { config } from '../config.js';

/**
 * File-backed session store. Each session lives in
 *   <DATA_DIR>/sessions/<id>/session.json    – the public Session object
 *   <DATA_DIR>/sessions/<id>/materials.json  – private extracted material parts
 *   <DATA_DIR>/sessions/<id>/files/          – uploads and derived files
 */

const ID_RE = /^[a-z0-9]{12}$/;

export function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function assertId(id: string): string {
  if (!ID_RE.test(id)) throw Object.assign(new Error('Invalid id'), { status: 400 });
  return id;
}

export const sessionsRoot = (): string => path.join(config.dataDir, 'sessions');
export const sessionDir = (id: string): string => path.join(sessionsRoot(), assertId(id));
export const filesDir = (id: string): string => path.join(sessionDir(id), 'files');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

const sessionFile = (id: string) => path.join(sessionDir(id), 'session.json');
const materialsFile = (id: string) => path.join(sessionDir(id), 'materials.json');

export async function listSessions(): Promise<SessionSummary[]> {
  await fs.mkdir(sessionsRoot(), { recursive: true });
  const entries = await fs.readdir(sessionsRoot(), { withFileTypes: true });
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const session = await readJson<Session | null>(sessionFile(entry.name), null);
    if (!session) continue;
    summaries.push(summarizeSession(session));
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSession(title?: string): Promise<Session> {
  const session = blankSession(newId(), title);
  await fs.mkdir(filesDir(session.id), { recursive: true });
  await writeJson(sessionFile(session.id), session);
  await writeJson(materialsFile(session.id), []);
  return session;
}

export async function getSession(id: string): Promise<Session | null> {
  return readJson<Session | null>(sessionFile(id), null);
}

export async function requireSession(id: string): Promise<Session> {
  const session = await getSession(id);
  if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  await fs.rm(sessionDir(id), { recursive: true, force: true });
}

export async function getMaterials(id: string): Promise<ExtractedMaterial[]> {
  return readJson<ExtractedMaterial[]>(materialsFile(id), []);
}

export async function saveMaterials(id: string, materials: ExtractedMaterial[]): Promise<void> {
  await writeJson(materialsFile(id), materials);
}

/** Per-session write lock so concurrent requests never interleave read-modify-write cycles. */
const locks = new Map<string, Promise<unknown>>();

export async function updateSession(
  id: string,
  mutate: (session: Session) => void | Promise<void>,
): Promise<Session> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const session = await requireSession(id);
      await mutate(session);
      session.updatedAt = new Date().toISOString();
      await writeJson(sessionFile(id), session);
      return session;
    });
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
