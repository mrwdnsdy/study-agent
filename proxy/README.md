# Study Agent proxy (optional)

The GitHub Pages build of Study Agent runs entirely in the browser, so by default each visitor pastes their **own** Anthropic API key into Settings. If you would rather pay for everyone you share the link with, deploy this Cloudflare Worker: it keeps your key as a Worker secret, adds it to every request and forwards the request to `api.anthropic.com`. An access code stops anyone who merely finds the URL from spending your credits.

```bash
npm i -g wrangler
wrangler login
cd proxy
wrangler secret put ANTHROPIC_API_KEY     # paste your key
wrangler secret put ACCESS_CODE           # any passphrase you will share with your friends
wrangler deploy                           # prints https://study-agent-proxy.<you>.workers.dev
```

Edit `ALLOWED_ORIGINS` in `wrangler.toml` if your page lives somewhere other than `https://mrwdnsdy.github.io`.

Then, on the web page, open **Settings → Use a proxy instead of a key…**, paste the Worker URL and the access code, and save. Everyone you give the URL and code to can use the page without a key of their own.

The free Cloudflare plan is enough: the Worker only streams bytes through, so a study-guide generation uses a few milliseconds of CPU time.
