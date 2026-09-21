import type { StreamEvent } from '../../shared/types';

/**
 * POSTs JSON and consumes the server-sent event stream that comes back.
 * Resolves when the stream ends; rejects on HTTP errors or an `error` event.
 */
export async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `Request failed (${response.status})`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleChunk = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      const event = JSON.parse(json) as StreamEvent;
      onEvent(event);
      if (event.type === 'error') throw new Error(event.message);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleChunk(chunk);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) handleChunk(buffer);
}
