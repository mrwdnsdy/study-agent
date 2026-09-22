/** Minimal Server-Sent Events reader shared by the Gemini and OpenAI-compatible adapters. */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      const { value, done } = await reader.read();
      if (done) break;
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
  } finally {
    reader.releaseLock();
  }
}
