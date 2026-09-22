import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { ServerConfigResponse } from '../shared/types.js';
import { materialsRouter, sofficePath } from './routes/materials.js';
import { quizRouter } from './routes/quiz.js';
import { sessionsRouter } from './routes/sessions.js';
import { studyRouter } from './routes/study.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', async (_req, res) => {
  const body: ServerConfigResponse = {
    model: config.models.guide,
    models: config.models,
    escalationModel: config.escalationModel,
    hasApiKey: config.hasApiKey,
    sofficeAvailable: Boolean(await sofficePath()),
    maxUploadMb: config.maxUploadMb,
  };
  res.json(body);
});

app.use('/api/sessions', sessionsRouter, materialsRouter, studyRouter, quizRouter);

// In production the built client is served from ./dist with an SPA fallback.
const distDir = path.resolve(process.cwd(), 'dist');
const indexHtml = path.join(distDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      res.sendFile(indexHtml);
      return;
    }
    next();
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

interface HttpError extends Error {
  status?: number;
  issues?: unknown;
  type?: string;
}

app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than the ${config.maxUploadMb} MB limit.` : err.message;
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    return;
  }
  if (err?.name === 'ZodError') {
    res.status(400).json({ error: 'Invalid request', issues: err.issues });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  const status = typeof err.status === 'number' ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Study Agent API listening on http://localhost:${config.port} (guide: ${config.models.guide}, chat: ${config.models.chat}, escalation: ${config.escalationModel ?? 'off'}, effort: ${config.effort}, data: ${config.dataDir})`);
  if (!config.hasApiKey) console.warn('ANTHROPIC_API_KEY is not set: Claude features will fail until it is configured in .env');
});
