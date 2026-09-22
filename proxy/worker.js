/**
 * Cloudflare Worker that lets the GitHub Pages build of Study Agent call Claude
 * without every visitor needing an API key: the key lives in a Worker secret and
 * is added to each request here. An optional access code keeps strangers out.
 *
 * Deploy:
 *   npm i -g wrangler
 *   cd proxy
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put ACCESS_CODE          # optional but recommended
 *   wrangler deploy
 * Then paste the Worker URL (and access code) into Settings on the web page.
 *
 * Variables (wrangler.toml [vars] or the dashboard):
 *   ALLOWED_ORIGINS  comma-separated page origins, e.g. "https://you.github.io"; "*" allows any.
 */

const UPSTREAM = 'https://api.anthropic.com';
const STRIP_REQUEST_HEADERS = ['host', 'origin', 'referer', 'cookie', 'x-access-code', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor'];

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const list = String(env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (list.includes('*')) return origin || '*';
  return list.includes(origin) ? origin : null;
}

function withCors(headers, request, origin) {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ?? 'content-type, x-api-key, x-access-code, anthropic-version, anthropic-beta',
  );
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
  return headers;
}

function error(status, message, request, origin) {
  const body = JSON.stringify({ type: 'error', error: { type: status === 403 ? 'permission_error' : 'api_error', message } });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) withCors(headers, request, origin);
  return new Response(body, { status, headers });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: withCors(new Headers(), request, origin) });
    }
    if (!origin) return error(403, 'This origin is not allowed to use the proxy.', request, null);
    if (!env.ANTHROPIC_API_KEY) return error(500, 'The proxy has no ANTHROPIC_API_KEY secret.', request, origin);
    if (env.ACCESS_CODE && request.headers.get('x-access-code') !== env.ACCESS_CODE) {
      return error(403, 'Wrong or missing access code. Enter it in Settings.', request, origin);
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return error(404, 'Not found', request, origin);

    const headers = new Headers(request.headers);
    for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
    headers.set('x-api-key', env.ANTHROPIC_API_KEY);

    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });

    const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    withCors(response.headers, request, origin);
    return response;
  },
};
