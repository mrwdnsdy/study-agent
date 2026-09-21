import type { Request, Response } from 'express';
import { SseWriter } from '../lib/sse.js';

export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Opens an SSE response and aborts the in-flight Claude request if the client disconnects. */
export function startStream(_req: Request, res: Response): { sse: SseWriter; signal: AbortSignal } {
  const sse = new SseWriter(res);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  return { sse, signal: controller.signal };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'New study session';
  const title = base.charAt(0).toUpperCase() + base.slice(1);
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}
