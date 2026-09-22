/**
 * Cloudflare Worker that lets the GitHub Pages build of Study Agent call Claude
 * without visitors needing an API key: the key lives in a Worker secret and is
 * added to each request here, then the request is forwarded to api.anthropic.com.
 *
 * Protections (all optional, see wrangler.toml):
 *   ALLOWED_ORIGINS  only pages on these origins may call the proxy from a browser
 *   ACCESS_CODE      a shared passphrase visitors enter in Settings
 *   RATE_LIMITER     per-visitor request cap (Cloudflare rate limiting binding)
 * Only the Messages endpoints are forwarded. Set a monthly spend limit for the
 * key in the Anthropic Console as the real backstop.
 *
 * Deploy:
 *   npm i -g wrangler && wrangler login
 *   cd proxy
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler secret put ACCESS_CODE        # optional
 *   wrangler deploy                        # prints https://study-agent-proxy.<you>.workers.dev
 */

const UPSTREAM = 'https://api.anthropic.com';
const ALLOWED_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];
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
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ?? 'content-type, x-api-key, x-access-code, anthropic-version, anthropic-beta',
  );
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Access-Control-Max-Age', '86400');
  headers.append('Vary', 'Origin');
  return headers;
}

function error(status, type, message, request, origin, extra = {}) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  const headers = new Headers({ 'content-type': 'application/json', ...extra });
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
    if (!origin) return error(403, 'permission_error', 'This origin is not allowed to use the proxy.', request, null);

    const url = new URL(request.url);
    if (request.method !== 'POST' || !ALLOWED_PATHS.includes(url.pathname)) {
      return error(404, 'not_found_error', 'Only the Messages API is available through this proxy.', request, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return error(500, 'api_error', 'The proxy has no ANTHROPIC_API_KEY secret yet. The site owner needs to add it in the Cloudflare dashboard.', request, origin);
    }
    if (env.ACCESS_CODE && request.headers.get('x-access-code') !== env.ACCESS_CODE) {
      return error(403, 'permission_error', 'Wrong or missing access code. Enter it in Settings.', request, origin);
    }

    if (env.RATE_LIMITER) {
      const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) {
        return error(429, 'rate_limit_error', 'Too many requests from your connection. Wait a minute and try again.', request, origin, {
          'retry-after': '60',
        });
      }
    }

    const headers = new Headers(request.headers);
    for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
    headers.set('x-api-key', env.ANTHROPIC_API_KEY);

    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: 'POST',
      headers,
      body: request.body,
      redirect: 'manual',
    });

    const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
    withCors(response.headers, request, origin);
    return response;
  },
};
