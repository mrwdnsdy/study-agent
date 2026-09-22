# Study Agent proxy

The GitHub Pages build of Study Agent runs entirely in the browser. This Cloudflare Worker lets visitors use it **without a key of their own**: your Anthropic API key is stored as a Worker secret, the Worker adds it to every request and forwards the request to `api.anthropic.com`. Nothing else touches the key.

## Deploy

```bash
npm i -g wrangler
wrangler login
cd proxy
wrangler deploy                           # prints https://study-agent-proxy.<you>.workers.dev
wrangler secret put ANTHROPIC_API_KEY     # paste your key
wrangler secret put ACCESS_CODE           # optional passphrase
```

Or in the Cloudflare dashboard: Workers & Pages → Create → upload `worker.js`, then Settings → Variables and Secrets → add `ANTHROPIC_API_KEY` as a *Secret* and `ALLOWED_ORIGINS` as a variable.

Then put the Worker URL into `public/config.json` (`"proxyUrl": "https://…workers.dev"`) and push; the page is rebuilt and visitors start straight away. Visitors who prefer their own key can still enter one in Settings.

## Guard rails

Everyone with the page link can spend the key's credit, so the Worker:

- accepts browser requests only from the origins in `ALLOWED_ORIGINS` (`wrangler.toml`, default `https://mrwdnsdy.github.io`);
- caps each visitor (IP address) at 40 requests per minute through a [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/);
- forwards only `POST /v1/messages` and `/v1/messages/count_tokens`, so the key cannot be used for anything else through the proxy;
- optionally requires the `ACCESS_CODE` passphrase (visitors enter it in Settings).

Also set a **monthly spend limit** for the key in the [Anthropic Console](https://console.anthropic.com/settings/limits), ideally with a dedicated workspace and key for this page, and rotate the key from the dashboard if usage looks wrong.

The free Cloudflare plan is enough: the Worker only streams bytes through, so a study-guide generation uses a few milliseconds of CPU time.
