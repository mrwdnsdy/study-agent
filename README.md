# Study Agent

An AI study companion powered by **Claude Opus**. Upload your lecture slides, notes and readings, and Study Agent will:

- **Write a highly technical study guide** that walks through every slide in order: concepts explained in depth, best practices, gold-standard tips, common pitfalls, exam alerts, comparison tables, a cheat sheet, a glossary and self-check questions. Diagrams are drawn with Mermaid and rendered in colour, so visual learners get flowcharts, mind maps, sequence diagrams and timelines instead of walls of text. The document streams in live as it is written.
- **Chat with a study agent** that has read all of your materials. Ask it to explain slide 12, compare two concepts, or "add a worked example to the TCP section". It edits the study guide in place, rewrites it on request, and can start a quiz straight from the conversation.
- **Run interactive quizzes**: multiple choice, true/false and short-answer questions generated from your materials, one at a time, with a hint, a source reference (e.g. "Slide 14"), and **immediate feedback** on every answer. Short answers are graded on meaning, not wording.
- **Produce a post-quiz review session**: a scorecard by topic, a question-by-question breakdown of what went wrong and why, the misconceptions behind the mistakes, a targeted revision plan, and retry prompts. From there you can quiz yourself on your weak areas or discuss the mistakes in chat.
- **Export** the guide (and reviews) as a **Word document** (diagrams included) that opens in Google Docs, as a printable page (save as PDF) or as a self-contained HTML file. With a Google OAuth client ID configured it uploads straight to your Drive as a Google Doc.

Everything runs against `claude-opus-5` by default (change `ANTHROPIC_MODEL` to use another model).

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

## Configuration

All settings live in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Required. Your Anthropic API key (server-side only, never sent to the browser). |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model for every task: guide, chat, quiz generation, grading, review. |
| `ANTHROPIC_EFFORT` | `high` | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Higher is more thorough and slower. |
| `ANTHROPIC_FILES_API` | `on` | Upload PDFs/images once via the Files API and reference them by id. Set `off` to inline them on every request. |
| `PORT` | `3001` | API port. |
| `DATA_DIR` | `./data` | Sessions, uploads and generated content (JSON files on disk). |
| `MAX_UPLOAD_MB` | `100` | Per-file upload limit. |
| `SOFFICE_PATH` | auto-detect | Path to LibreOffice's `soffice`; `off` disables slide rendering. |
| `VITE_GOOGLE_CLIENT_ID` | – | Enables *Open in Google Docs*. |

## How it works

```
browser (React + Vite)  ──HTTP/SSE──▶  Express API  ──streaming──▶  Claude API (claude-opus-5)
      │                                    │
      │  markdown → DOCX/HTML export       │  ./data/sessions/<id>/{session.json, materials.json, files/}
```

- **Materials** are parsed on upload (`server/lib/extract.ts`): PDFs are passed to Claude as documents (it reads text and images on every page); `.pptx` decks are rendered to PDF with LibreOffice when available, otherwise slide text, speaker notes and embedded images are extracted; `.docx` goes through Mammoth; images are downscaled when large.
- **One cached prompt prefix** (system prompt → materials → current guide) is shared by every call, so the materials are billed at cache-read rates after the first request. Prompt caching uses a 1-hour TTL.
- **The study guide** is the assistant's streamed response to your prompt. The chat agent has three tools: `update_study_guide` (replace/insert/append a section), `regenerate_study_guide` (full rewrite with new instructions, streamed) and `create_quiz` (strict JSON schema). Section edits are applied server-side (`server/lib/guideEdits.ts`).
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
```

Layout: `src/` React client, `server/` Express API, `shared/` types used by both.
