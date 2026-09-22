# Study Agent proxy

The GitHub Pages build of Study Agent runs entirely in the browser. This Cloudflare Worker lets visitors use it **without a key of their own**: the provider API keys are stored as Worker secrets, the Worker adds the right key to each request and forwards the request to the provider. Nothing else touches the keys.

## Providers

The Worker fronts five providers. Each one is enabled by adding its secret; `GET /providers` returns `{"anthropic": …, "gemini": …, "openrouter": …, "zai": …, "workers-ai": …}` with `true` for the ones that have a key, so the page only offers models it can actually reach. A request to a provider without a key gets `501 not_configured`.

| Provider | Secret | Proxy path → upstream |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `/anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens` (and the older `/v1/messages…`) → `api.anthropic.com` |
| Google Gemini | `GEMINI_API_KEY` | `/gemini/v1beta/models/<model>:streamGenerateContent`, `:generateContent` → `generativelanguage.googleapis.com` |
| OpenRouter | `OPENROUTER_API_KEY` | `/openrouter/v1/chat/completions` → `openrouter.ai/api/v1` |
| Z.ai | `ZAI_API_KEY` | `/zai/chat/completions` → `api.z.ai/api/paas/v4` |
| Cloudflare Workers AI | `WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (a variable, already in `wrangler.toml`) | `/workers-ai/chat/completions` → `api.cloudflare.com/client/v4/accounts/<id>/ai/v1` |

- **Free lane:** `GEMINI_API_KEY`. Get a free key from Google AI Studio at [aistudio.google.com](https://aistudio.google.com). Without it the page has no zero-cost models.
- **Optional extra fallbacks:** `OPENROUTER_API_KEY`, `ZAI_API_KEY` and `WORKERS_AI_TOKEN` (a Cloudflare API token with the Workers AI permission; the account id is already in `wrangler.toml`). They are used when the model ahead of them in the chain is unavailable.
- **Claude:** `ANTHROPIC_API_KEY`, billed to your Anthropic account.

## Deploy

```bash
npm i -g wrangler
wrangler login
cd proxy
wrangler deploy                           # prints https://study-agent-proxy.<you>.workers.dev
wrangler secret put GEMINI_API_KEY        # free lane; add the other provider secrets the same way
wrangler secret put ACCESS_CODE           # optional passphrase
```

Or in the Cloudflare dashboard: Workers & Pages → Create → upload `worker.js`, then Settings → Variables and Secrets → add the provider keys as *Secrets* and `ALLOWED_ORIGINS`, `APP_URL` and `CLOUDFLARE_ACCOUNT_ID` as variables.

Then put the Worker URL into `public/config.json` (`"proxyUrl": "https://…workers.dev"`) and push; the page is rebuilt and visitors start straight away. Visitors who prefer their own key can still enter one in Settings.

## Guard rails

Everyone with the page link can spend the keys' credit, so the Worker:

- accepts browser requests only from the origins in `ALLOWED_ORIGINS` (`wrangler.toml`, default `https://mrwdnsdy.github.io`);
- caps each visitor (IP address) at 40 requests per minute through a [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/);
- forwards only `POST` requests to the endpoints in the table above, and drops any `Authorization`, `x-api-key` or `x-goog-api-key` header a visitor sends before adding its own, so a key cannot be used for anything else through the proxy;
- optionally requires the `ACCESS_CODE` passphrase (visitors enter it in Settings; `GET /providers` does not need it).

Also set a **monthly spend limit** for each paid key in its provider's console (Anthropic: [Console → Limits](https://console.anthropic.com/settings/limits)), ideally with a dedicated key for this page, and rotate a key from the dashboard if usage looks wrong.

The free Cloudflare plan is enough: the Worker only streams bytes through, so a study-guide generation uses a few milliseconds of CPU time. Workers AI usage itself counts against the account named by `CLOUDFLARE_ACCOUNT_ID` (free daily allowance first, then paid).
