/**
 * Server mode talks to the Express API (/api/...). Browser mode runs everything
 * in the page: Claude is called directly from the browser with the visitor's own
 * key (or a proxy), and sessions live in IndexedDB. Static hosts such as GitHub
 * Pages always run in browser mode.
 */
export type AppMode = 'server' | 'browser';

const forced = import.meta.env.VITE_BROWSER_MODE === 'true';
let mode: AppMode = forced ? 'browser' : 'server';
let detected = forced;

export function getMode(): AppMode {
  return mode;
}

export async function detectMode(): Promise<AppMode> {
  if (detected) return mode;
  detected = true;
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/health`, { headers: { Accept: 'application/json' } });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('application/json')) mode = 'browser';
  } catch {
    mode = 'browser';
  }
  return mode;
}
