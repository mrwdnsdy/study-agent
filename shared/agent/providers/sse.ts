/** Minimal Server-Sent Events reader shared by the Gemini and OpenAI-compatible adapters. */
import type { ProviderId } from '../../types.js';
import { LlmError } from '../llm.js';

export interface SseEvent {
  event?: string;
  data: string;
}

export interface StallOptions {
  /** How long to wait for the response headers, and then for the first bytes of the body. */
  firstByteMs?: number;
  /** How long the body may stay silent once bytes are flowing (keep-alive comments count). */
  idleMs?: number;
}

/** Long guides think for a while before the first token, so the first byte gets far more time than later gaps. */
export const DEFAULT_FIRST_BYTE_MS = 180_000;
export const DEFAULT_IDLE_MS = 90_000;

/** The server stopped sending: no response, or no bytes, within the allowed time. */
export class SseStallError extends Error {
  readonly ms: number;
  constructor(phase: 'headers' | 'first byte' | 'idle', ms: number) {
    const seconds = Math.round(ms / 1000);
    super(phase === 'idle' ? `The stream went silent for ${seconds} s.` : `No response within ${seconds} s (${phase}).`);
    this.name = 'SseStallError';
    this.ms = ms;
  }
}

/** The connection failed while the body was being read (dropped, reset, cut by a proxy). */
export class SseReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SseReadError';
  }
}

/**
 * fetch() for a streaming endpoint that gives up with SseStallError when the
 * response headers take longer than `ms`. The caller's signal keeps working for
 * the whole response, body included.
 */
export async function fetchStream(fetchImpl: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  if (outer?.aborted) controller.abort(outer.reason);
  // Never removed: Stop must still cancel the body read after the headers have arrived.
  else outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    controller.abort();
  }, ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (stalled && !outer?.aborted) throw new SseStallError('headers', ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Errors raised by the transport, as opposed to the stream's content or the caller's handlers. */
export function isTransportError(err: unknown): boolean {
  return err instanceof SseStallError || err instanceof SseReadError;
}

/**
 * Turns a failure to reach or read a stream into an LlmError that the chain and the
 * core can classify: a stall becomes kind 'stalled' (status 504), anything else
 * 'network'. A request the caller aborted keeps its abort error.
 */
export function transportError(err: unknown, opts: { provider: ProviderId; model: string; label: string; signal?: AbortSignal }): unknown {
  const cause = err instanceof SseReadError ? err.cause : err;
  if (opts.signal?.aborted) return cause;
  const { provider, model, label } = opts;
  if (err instanceof SseStallError) return new LlmError(`${label}: ${err.message}`, { provider, model, status: 504, kind: 'stalled', cause: err });
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new LlmError(`${label}: connection failed (${detail})`, { provider, model, kind: 'network', cause });
}

/** The next chunk of the body, or SseStallError when none arrives within `ms`. */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, phase: 'first byte' | 'idle') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SseStallError(phase, ms)), ms);
  });
  const read = reader.read().catch((err: unknown) => {
    throw new SseReadError(err);
  });
  // After a stall the pending read may still fail (the reader is cancelled and released); that is expected.
  read.catch(() => undefined);
  try {
    return await Promise.race([read, stall]);
  } finally {
    clearTimeout(timer);
  }
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>, opts: StallOptions = {}): AsyncGenerator<SseEvent> {
  const firstByteMs = opts.firstByteMs ?? DEFAULT_FIRST_BYTE_MS;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = false;
  const parse = (chunk: string): SseEvent | null => {
    let event: string | undefined;
    const data: string[] = [];
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
    if (data.length === 0) return null;
    return { event, data: data.join('\n') };
  };
  try {
    for (;;) {
      const { value, done } = received ? await readWithin(reader, idleMs, 'idle') : await readWithin(reader, firstByteMs, 'first byte');
      if (done) break;
      received = true;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.search(/\r?\n\r?\n/);
      while (index !== -1) {
        const match = buffer.slice(index).match(/^\r?\n\r?\n/);
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + (match ? match[0].length : 2));
        const event = parse(chunk);
        if (event) yield event;
        index = buffer.search(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parse(buffer);
      if (event) yield event;
    }
  } catch (err) {
    // A stalled server can hold the connection open indefinitely: close it rather than leave the request hanging.
    if (err instanceof SseStallError) await reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
