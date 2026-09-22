/**
 * Cloudflare Worker that lets the GitHub Pages build of Study Agent call model
 * providers without visitors needing an API key: each provider's key lives in a
 * Worker secret and is added to the request here, then the request is forwarded
 * to that provider. Adding a secret enables its provider; GET /providers tells
 * the page which ones are available.
 *
 * Protections (all optional, see wrangler.toml):
 *   ALLOWED_ORIGINS  only pages on these origins may call the proxy from a browser
 *   ACCESS_CODE      a shared passphrase visitors enter in Settings
 *   RATE_LIMITER     per-visitor request cap (Cloudflare rate limiting binding)
 * Only the model endpoints in PROVIDERS are forwarded, and any auth header the
 * visitor sends is replaced with the Worker's own. Set spend limits in each
 * provider's console as the real backstop.
 *
 * Deploy:
 *   npm i -g wrangler && wrangler login
 *   cd proxy
 *   wrangler secret put GEMINI_API_KEY     # or any other provider secret; each enables one provider
 *   wrangler secret put ACCESS_CODE        # optional
 *   wrangler deploy                        # prints https://study-agent-proxy.<you>.workers.dev
 */

const DEFAULT_APP_URL = 'https://mrwdnsdy.github.io/study-agent/';

/**
 * Never forwarded upstream: browser and Cloudflare identity headers, the proxy's
 * own access code, and any provider auth the visitor sent (the Worker sets its own).
 */
const STRIP_REQUEST_HEADERS = [
  'host', 'origin', 'referer', 'cookie', 'x-access-code',
  'authorization', 'x-api-key', 'x-goog-api-key',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
];

/**
 * One entry per provider: the secrets that enable it, its upstream base URL (a
 * string, or a function of env when it depends on a variable), match(pathname)
 * giving the upstream path for a proxy path (null when it is not one of this
 * provider's endpoints), and auth(headers, env) adding the provider's credentials.
 * The order here is the order of the keys in GET /providers.
 */
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    secrets: ['ANTHROPIC_API_KEY'],
    upstream: 'https://api.anthropic.com',
    // /anthropic/v1/messages[/count_tokens]; the unprefixed form is the path from before the proxy had several providers.
    match: (pathname) => /^(?:\/anthropic)?(\/v1\/messages(?:\/count_tokens)?)$/.exec(pathname)?.[1] ?? null,
    auth: (headers, env) => headers.set('x-api-key', env.ANTHROPIC_API_KEY),
  },
  gemini: {
    label: 'Google Gemini',
    secrets: ['GEMINI_API_KEY'],
    upstream: 'https://generativelanguage.googleapis.com',
    // /gemini/v1beta/models/<model>:streamGenerateContent or :generateContent; the query string (?alt=sse) is kept.
    match: (pathname) => /^\/gemini(\/v1beta\/models\/[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent))$/.exec(pathname)?.[1] ?? null,
    auth: (headers, env) => headers.set('x-goog-api-key', env.GEMINI_API_KEY),
  },
  openrouter: {
    label: 'OpenRouter',
    secrets: ['OPENROUTER_API_KEY'],
    upstream: 'https://openrouter.ai/api',
    match: (pathname) => (pathname === '/openrouter/v1/chat/completions' ? '/v1/chat/completions' : null),
    auth: (headers, env) => {
      headers.set('Authorization', `Bearer ${env.OPENROUTER_API_KEY}`);
      headers.set('HTTP-Referer', appUrl(env)); // OpenRouter's app attribution headers
      headers.set('X-Title', 'Study Agent');
    },
  },
  zai: {
    label: 'Z.ai',
    secrets: ['ZAI_API_KEY'],
    upstream: 'https://api.z.ai/api/paas/v4',
    match: (pathname) => (pathname === '/zai/chat/completions' ? '/chat/completions' : null),
    auth: (headers, env) => headers.set('Authorization', `Bearer ${env.ZAI_API_KEY}`),
  },
  'workers-ai': {
    label: 'Cloudflare Workers AI',
    secrets: ['WORKERS_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    upstream: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    match: (pathname) => (pathname === '/workers-ai/chat/completions' ? '/chat/completions' : null),
    auth: (headers, env) => headers.set('Authorization', `Bearer ${env.WORKERS_AI_TOKEN}`),
  },
};

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
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ??
      'content-type, authorization, x-api-key, x-goog-api-key, x-access-code, anthropic-version, anthropic-beta',
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

function notFound(request, origin) {
  return error(404, 'not_found_error', 'Only the model endpoints are available through this proxy.', request, origin);
}

/** Where the app lives, for OpenRouter's HTTP-Referer: APP_URL, else the first allowed origin, else the public GitHub Pages URL. */
function appUrl(env) {
  if (env.APP_URL) return env.APP_URL;
  const first = String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .find((o) => o && o !== '*');
  return first || DEFAULT_APP_URL;
}

function isConfigured(provider, env) {
  return provider.secrets.every((name) => Boolean(env[name]));
}

function upstreamBase(provider, env) {
  return typeof provider.upstream === 'function' ? provider.upstream(env) : provider.upstream;
}

/** The provider that serves url.pathname and the path to request from its upstream, or null. */
function route(url) {
  for (const provider of Object.values(PROVIDERS)) {
    const path = provider.match(url.pathname);
    if (path) return { provider, path };
  }
  return null;
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

    // Which providers have a key, so the page can build its model chain. No access code needed.
    if (request.method === 'GET' && url.pathname === '/providers') {
      const available = Object.fromEntries(Object.entries(PROVIDERS).map(([id, provider]) => [id, isConfigured(provider, env)]));
      const headers = withCors(new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' }), request, origin);
      return new Response(JSON.stringify(available), { status: 200, headers });
    }

    if (request.method !== 'POST') return notFound(request, origin);
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

    const target = route(url);
    if (!target) return notFound(request, origin);
    const { provider, path } = target;
    if (!isConfigured(provider, env)) {
      return error(501, 'not_configured', `The site owner has not added a ${provider.label} key to the proxy yet.`, request, origin);
    }

    const headers = new Headers(request.headers);
    for (const name of STRIP_REQUEST_HEADERS) headers.delete(name);
    provider.auth(headers, env);

    const upstream = await fetch(`${upstreamBase(provider, env)}${path}${url.search}`, {
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
