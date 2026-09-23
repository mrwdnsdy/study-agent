# Kiiku Study Buddy

An AI study companion powered by **Claude Opus**. Upload your lecture slides, notes and readings, and Kiiku will:

- **Write a highly technical study guide** that walks through every slide in order: concepts explained in depth, best practices, gold-standard tips, common pitfalls, exam alerts, comparison tables, a cheat sheet, a glossary and self-check questions. Diagrams are drawn with Mermaid and rendered in colour, so visual learners get flowcharts, mind maps, sequence diagrams and timelines instead of walls of text. The document streams in live as it is written.
- **Chat with Kiiku, your study agent**, who has read all of your materials. Ask it to explain slide 12, compare two concepts, or "add a worked example to the TCP section". It edits the study guide in place, rewrites it on request, and can start a quiz straight from the conversation.
- **Run interactive quizzes**: multiple choice, true/false and short-answer questions generated from your materials, one at a time, with a hint, a source reference (e.g. "Slide 14"), and **immediate feedback** on every answer. Short answers are graded on meaning, not wording.
- **Produce a post-quiz review session**: a scorecard by topic, a question-by-question breakdown of what went wrong and why, the misconceptions behind the mistakes, a targeted revision plan, and retry prompts. From there you can quiz yourself on your weak areas or discuss the mistakes in chat.
- **Export** the guide (and reviews) as a **Word document** (diagrams included) that opens in Google Docs, as a printable page (save as PDF) or as a self-contained HTML file. With a Google OAuth client ID configured it uploads straight to your Drive as a Google Doc.

The published web page runs on a **free lane**: Google's Gemini 3.8 Flash writes and tutors first, with free open-weight models (Qwen 3.8 on OpenRouter, GLM Flash on Z.ai, Gemma 4 on Cloudflare Workers AI) as automatic fallbacks, and a **Claude lane** (Opus 5 for guides, Sonnet 5 for the rest, Fable 5.1 for *Maximum quality*) that visitors can switch to in Settings. A self-hosted server can use any mix of the same providers. See [Models and cost](#models-and-cost).

There are two ways to run it:

- **Web page (GitHub Pages)**: nothing to install. Open the published page, paste an Anthropic API key into *Settings* (or use a proxy that holds one), and everything, from reading your slides to storing your sessions, happens inside your browser. See [Share it as a web page](#share-it-as-a-web-page-github-pages).
- **Server mode**: run the Node server yourself (locally or on a host with a persistent disk). The key stays on the server, slides can be rendered with LibreOffice, and sessions are stored on disk.

## Quick start

Requirements: Node.js 20 or newer and an [Anthropic API key](https://console.anthropic.com/).

```bash
cd study-agent
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm run dev                 # opens the API on :3001 and the app on http://localhost:5173
```

Open <http://localhost:5173>, drop your slides into the sidebar, and press **Generate study guide**.

**Optional but recommended: install LibreOffice.** When `soffice` is on the `PATH` (or `SOFFICE_PATH` points to it), PowerPoint decks are rendered to PDF so Claude sees every slide exactly as designed, including diagrams and figures. Without it, slide text, speaker notes and embedded images are extracted instead.

- macOS: `brew install --cask libreoffice`
- Debian/Ubuntu: `sudo apt install libreoffice-impress`
- Windows: install LibreOffice and set `SOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe`

## How to use it

1. **Create a session** per module (the sidebar keeps one session per course/module) and upload the materials: PDF, PowerPoint (`.pptx`), Word (`.docx`), images (photos of the whiteboard work too) and text/markdown.
2. **Generate the study guide.** The default prompt asks for a slide-by-slide technical guide with diagrams; edit it freely, for example:

   > Please create a highly technical study guide going through each slide, explaining concepts, best practice, gold-standard tips to understand. I need to ace this module. Include colourful, easy-to-understand diagrams as I am a visual learner. Do not miss anything!

3. **Talk to the agent** in the chat panel. Quick actions cover the common requests (explain a slide, list every formula, likely exam questions, quiz me). Ask for changes and the guide updates in place.
4. **Quiz yourself** from the Quiz tab (choose length, difficulty, question types and an optional focus) or by asking in chat. You get feedback after every question.
5. **Review** from the Review tab after a quiz. Use *Quiz me on weak areas* and *Discuss in chat* to keep the loop going.
6. **Export** from the toolbar above the guide.

## Exports and Google Docs

- **Word (.docx)**: fully formatted (headings, callouts, tables, code, diagrams as images). Drag the file into Google Drive and open it, and Drive converts it into an editable Google Doc.
- **Open in Google Docs** (direct upload) needs a Google OAuth *Web application* client ID:
  1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create a project, enable the **Google Drive API**, and configure the OAuth consent screen (External, add yourself as a test user while the app is in testing).
  2. Create an **OAuth client ID** of type *Web application* and add your app origin(s) to *Authorised JavaScript origins*, e.g. `http://localhost:5173` and your deployed URL.
  3. Put the client ID in `.env` as `VITE_GOOGLE_CLIENT_ID=...` and restart `npm run dev` (Vite reads it at build time).
  The app only requests the `drive.file` scope, so it can only see files it created.
- **Printable view**: opens the guide as a styled page in a new tab; use the browser's *Print → Save as PDF*.
- **HTML**: a single self-contained file with the diagrams inlined.

## Share it as a web page (GitHub Pages)

The repository publishes itself to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`), so anyone with the link can use Kiiku Study Buddy without installing anything: **https://mrwdnsdy.github.io/study-agent/**

The page is a static build in **browser mode**:

- Files are read in the browser (PDF passthrough, PowerPoint text + notes + pictures, Word via Mammoth, images downscaled when large).
- Claude is called straight from the browser. Sessions, guides, chats and quizzes live in the browser's IndexedDB, so they survive reloads on the same device but are not shared between devices.
- Where the Claude access comes from is decided by `public/config.json` plus the visitor's own Settings (gear icon, top right); see the next two sections.

### Let visitors start immediately (preset proxy)

An API key must never be put into the page itself: the repository and the page are public, so anyone could copy the key from the JavaScript and Anthropic revokes keys it finds in public repositories. Instead the key lives in a tiny Cloudflare Worker ([`proxy/`](proxy/README.md)) that adds it to each request, and the page is preset to use that Worker:

1. Deploy the Worker (`cd proxy && wrangler deploy`, or from the Cloudflare dashboard) and give it the secret `ANTHROPIC_API_KEY` (Workers & Pages → the Worker → Settings → Variables and Secrets → Add → type *Secret*).
2. Put the Worker URL into `public/config.json` as `proxyUrl` and push. The next Pages deploy picks it up; visitors then see no key prompt at all.
3. Because everyone with the link spends that key's credit, keep the guard rails on: the Worker only accepts requests from the page's origin (`ALLOWED_ORIGINS`), caps each visitor at 40 requests per minute, and forwards nothing but the Messages endpoints. Set a **monthly spend limit** for the key in the Anthropic Console (Settings → Limits), ideally on a dedicated workspace, and rotate the key from the Cloudflare dashboard if usage looks wrong. An optional `ACCESS_CODE` secret adds a passphrase, but note that a code written into `config.json` is public too; it only helps when you hand it out separately.

`config.json` fields: `proxyUrl`, `accessCode`, `lanes` (named sets of model chains the visitor can switch between, each with `label`, `model` or per-task `models`, and `escalationModel`), `defaultLane`, `effort` (`low` … `max`), `notice` (a sentence shown in Settings, e.g. who is paying for usage), `agentName` (the persona, default `Kiiku`), `appName` (the product name used for the artifact title, default `Kiiku Study Buddy`), `artifactUrl` and `artifactLabel` (a link to the artifact version, see below, shown in the footer and in Settings) and `showModels` (set to `false` for a white-label page: the header, sidebar, Settings, status lines, chat notes and error messages then never name a provider or model, and the persona never discusses what powers it; on the server the same switch is `SHOW_MODELS=false`). A model reference is `claude-…`, `gemini/…`, `openrouter/…`, `zai/…`, `cf/@cf/…` or `artifact/<tier>` (only inside a claude.ai artifact, see below); a list is a fallback chain. Visitors can still type one model for every task in Settings.

### Or let each visitor bring their own key

Leave `proxyUrl` empty and the page asks each visitor for an Anthropic API key in Settings. The key is kept in that browser's `localStorage` and is sent nowhere except to Claude. Visitors of a preset page can also enter their own key to switch to their own account.

### Publishing your own copy

1. Fork or push this repository to GitHub. GitHub Pages needs a **public** repository on the free plan (Settings → General → Danger zone → *Change visibility*).
2. Push to `main` (or run the *Deploy to GitHub Pages* workflow from the Actions tab). The workflow enables Pages itself; if that step fails, set Settings → Pages → *Source* to **GitHub Actions** and run it again. The site appears at `https://<owner>.github.io/<repository>/`.
3. Optional: add a repository variable `VITE_GOOGLE_CLIENT_ID` to enable *Open in Google Docs* (the OAuth client's authorised JavaScript origin must be `https://<owner>.github.io`).

Browser mode limits: PDFs must be under 20 MB (they are sent inline), PowerPoint decks are not rendered as images (no LibreOffice), and the Files API is not used.

## Run it as a claude.ai artifact (your own Claude subscription)

The same page can be published as a **claude.ai artifact** that asks Claude through the artifact runtime's `sample` capability. Every request then runs on the Claude account the viewer is signed in with (their claude.ai subscription, no API key and no credits), so it is the easiest way to test the agent privately before opening a site to others.

- `npm run build:artifact` builds `dist-artifact/`: browser mode with relative paths, `artifact/config.json` baked in (one lane, `artifact/complex` for the study guide, `artifact/default` for chat, quizzes and reviews, `artifact/quick` for grading), `kiiku.html` (the page fragment to publish) and `manifest.json` (the supporting files with their content types).
- Publish `kiiku.html` with the manifest's files as supporting files and the capabilities `sample` (Claude) and `downloads` (exports). Inside the viewer the page detects the runtime (`window.claude.use`), needs no Settings and shows "Claude (complex tier)" and friends as the model names.
- The adapter (`shared/agent/providers/artifactSample.ts`) maps the agent's requests onto the runtime: the system prompt becomes a leading user turn, PDFs travel as the text extracted at upload, images go along as attachments where the view allows them, the transcript is trimmed to the runtime's 64 KB-per-request limit (oldest chat turns first, then material text, then the tail of long documents is kept), the guide continues automatically when an answer is cut short, tools run inside the call where the view offers them (otherwise a small JSON call protocol is used) and grading uses the runtime's JSON mode.
- Limits: 64 KB of text per request means very long materials are truncated (upload one lecture per session); model tiers replace model names; no thinking summaries and no token counts are shown; the first request asks the viewer to allow the artifact to use Claude.

## Configuration

All settings live in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Required. Your Anthropic API key (server-side only, never sent to the browser). |
| `AGENT_NAME` | `Kiiku` | Persona name of the study agent, shown in the app and used in the prompts. |
| `MODEL_LANE` | – | `free` switches every task to the zero-cost chain (Gemini first, open models as fallbacks). |
| `MODEL` | – | One model reference, or a comma-separated fallback chain, for every task. Leave unset for the per-task defaults below. (`ANTHROPIC_MODEL` still works.) |
| `MODEL_GUIDE` | `claude-opus-5` | Chain that writes the study guide. |
| `MODEL_CHAT` / `_QUIZ` / `_GRADING` / `_REVIEW` | `claude-sonnet-5` | Chains for the tutor chat, quiz creation, short-answer grading and the post-quiz review. |
| `ANTHROPIC_ESCALATION_MODEL` | `claude-fable-5-1` when every model is Claude | Used for *Maximum quality* guides and retried automatically when a task's model declines or returns nothing. `off` disables it. |
| `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`, `WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | – | Credentials for the other providers; each enables the model references with that prefix (`gemini/…`, `openrouter/…`, `zai/…`, `cf/@cf/…`). |
| `ANTHROPIC_EFFORT` | `high` | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Higher is more thorough and slower. |
| `ANTHROPIC_FILES_API` | `on` | Upload PDFs/images once via the Files API and reference them by id. Set `off` to inline them on every request. |
| `PORT` | `3001` | API port. |
| `DATA_DIR` | `./data` | Sessions, uploads and generated content (JSON files on disk). |
| `MAX_UPLOAD_MB` | `100` | Per-file upload limit. |
| `SOFFICE_PATH` | auto-detect | Path to LibreOffice's `soffice`; `off` disables slide rendering. |
| `VITE_GOOGLE_CLIENT_ID` | – | Enables *Open in Google Docs*. |
| `VITE_BROWSER_MODE` | – | Build-time. `true` builds the static browser-mode bundle used for GitHub Pages (no server, key entered in Settings). |
| `VITE_BASE` | `/` | Build-time. Public path of the client bundle, e.g. `/study-agent/` for a GitHub Pages project site. |

## How it works

```
server mode:
browser (React + Vite)  ──HTTP/SSE──▶  Express API  ──streaming──▶  Claude API (claude-opus-5)
      │                                    │
      │  markdown → DOCX/HTML export       │  ./data/sessions/<id>/{session.json, materials.json, files/}

browser mode (GitHub Pages):
browser (React + Vite + shared/agent core)  ──streaming──▶  Claude API (or the proxy/ Worker)
      │
      │  IndexedDB: sessions, extracted materials, files · localStorage: settings
```

Everything that talks to Claude lives in `shared/agent/core.ts` and is used unchanged by the Express routes (`server/`) and by browser mode (`src/browser/`). The client picks the backend at start-up: the static build is forced into browser mode, a full deployment probes `/api/health`.

- **Materials** are parsed on upload (`server/lib/extract.ts`, or `src/browser/extract.ts` in browser mode): PDFs are passed to Claude as documents (it reads text and images on every page); `.pptx` decks are rendered to PDF with LibreOffice when available, otherwise slide text, speaker notes and embedded images are extracted; `.docx` goes through Mammoth; images are downscaled when large.
- **One cached prompt prefix** (system prompt → materials → current guide) is shared by every call, so the materials are billed at cache-read rates after the first request. Prompt caching uses a 1-hour TTL.
- **The study guide** is the assistant's streamed response to your prompt. The chat agent has three tools: `update_study_guide` (replace/insert/append a section), `regenerate_study_guide` (full rewrite with new instructions, streamed) and `create_quiz` (strict JSON schema). Section edits are applied by the app, not the model (`shared/agent/guideEdits.ts`).
- **Quizzes** come from the `create_quiz` tool; multiple choice and true/false are graded instantly, short answers are graded by Claude with structured output (score 0–100 + feedback).
- **Reviews** are streamed documents built from the full quiz record, and they are appended to the chat transcript so follow-up questions have context.
- The server streams Server-Sent Events (`status`, `thinking`, `text`, `guide_delta`, `guide`, `tool`, `quiz`, `review`, `usage`, `done`, `error`); see `shared/types.ts` for the full contract.

## Deploying

The app is a single Node process that serves the built client and the API. It needs a **persistent disk** for `DATA_DIR` and a single instance (sessions are files, not a database).

**Docker**

```bash
docker build -t study-agent .
docker run -p 3001:3001 -e ANTHROPIC_API_KEY=sk-ant-... -v study-agent-data:/data study-agent
```

The image includes LibreOffice for slide rendering; build with `--build-arg WITH_LIBREOFFICE=false` for a smaller image.

**Railway / Render / Fly.io**: deploy from the Dockerfile, attach a volume mounted at `/data`, set `ANTHROPIC_API_KEY` (and `VITE_GOOGLE_CLIENT_ID` as a build-time variable if you want Google Docs upload). Serverless platforms with short request timeouts (Netlify Functions, Vercel Hobby) are not suitable: a full study guide can stream for several minutes.

**Without Docker**

```bash
npm ci && npm run build
NODE_ENV=production ANTHROPIC_API_KEY=sk-ant-... npm start   # serves everything on :3001
```

> There is no login. The app is meant for one person (or a trusted group) and must sit behind your own authentication, a VPN, or a platform-level access control if you expose it on the internet: anyone who can reach it can spend your API credits.

## Models and cost

Every model call goes through a small provider-neutral layer (`shared/agent/llm.ts`) with adapters for Claude, Gemini and OpenAI-compatible endpoints (OpenRouter, Z.ai, Cloudflare Workers AI). Each task has a **chain** of models: the first one that answers wins, and a model that fails before producing output (rate limit, missing key, outage) is skipped with a status line saying so. The page offers two **lanes**:

| Lane | Chain | Why |
| --- | --- | --- |
| Free (default) | `gemini-3.8-flash` → `gemini-3.5-flash-lite` → `qwen/qwen3.8-27b:free` (OpenRouter) → `nex-n2.5-pro:free` (OpenRouter) → `glm-4.6v-flash` (Z.ai) → `gemma-4-26b` (Workers AI) | Gemini's free tier reads PDFs natively, writes up to 64k tokens and enforces JSON schemas; the open models are backups. Costs nothing but the free tiers train on uploads. |
| Claude (premium) | guide `claude-opus-5`, everything else `claude-sonnet-5`, *Maximum quality* `claude-fable-5-1` | Best depth and slide reading; about $1 per full session with prompt caching. |

The free models receive PDFs as text (extracted with pdf.js at upload) except Gemini, which gets the file itself; OpenRouter parses PDFs with its free text engine. Strict JSON for grading is enforced on Claude and Gemini; the other endpoints get an instruction plus a validate-and-retry step. Which providers are live depends on the secrets in the proxy: `GEMINI_API_KEY` is required for the free lane, the others are optional (see [`proxy/README.md`](proxy/README.md)).

Rough cost of one full session on a 50-slide deck (guide, ten chat turns, a quiz and a review): $0 on the free lane, about $1 on the Claude lane, about $2 with a Maximum-quality guide. Each model keeps its own prompt cache of the materials, so the first call on each model pays a cache write; follow-ups on that model read from cache at a tenth of the input price.

## Costs and limits

- A full slide-by-slide guide for a 40–60 slide deck typically produces 15–35k output tokens; chat turns and quizzes are far smaller. Materials are cached, so follow-up requests mostly pay cache-read rates. The token counts of the last request are shown in the header.
- Claude's document limits apply: 600 pages per PDF; images larger than 4.5 MB are downscaled automatically. Very large decks are better split into one session per lecture block.
- The guide is generated with up to 64k output tokens per pass and continues automatically if it is cut off.

## Development

```bash
npm run dev        # API (tsx watch) + Vite dev server
npm run typecheck  # client + server
npm test           # node:test suites (extraction, guide edits, DOCX export)
npm run build      # dist/ (client) + dist-server/ (server)
VITE_BROWSER_MODE=true VITE_BASE=/study-agent/ npx vite build --outDir dist-pages   # the GitHub Pages bundle
```

Layout: `src/` React client (`src/browser/` is browser mode), `server/` Express API, `shared/` types and the Claude agent core used by both, `proxy/` the optional Cloudflare Worker.
