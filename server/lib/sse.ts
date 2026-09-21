import type { Response } from 'express';
import type { StreamEvent } from '../../shared/types.js';

/**
 * Minimal Server-Sent Events writer. Each StreamEvent is written as one
 * `data:` line of JSON. A comment heartbeat keeps proxies from closing idle
 * connections while the model is thinking.
 */
export class SseWriter {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.on('close', () => {
      this.closed = true;
      clearInterval(this.heartbeat);
    });
    this.heartbeat = setInterval(() => {
      if (!this.closed) res.write(': ping\n\n');
    }, 15_000);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: StreamEvent): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  end(): void {
    clearInterval(this.heartbeat);
    if (!this.closed) {
      this.res.end();
      this.closed = true;
    }
  }
}
