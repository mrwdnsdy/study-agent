import { Router } from 'express';
import { z } from 'zod';
import { createSession, deleteSession, getMaterials, listSessions, requireSession, updateSession } from '../lib/store.js';
import { deleteFileQuietly } from '../lib/claude.js';

export const sessionsRouter = Router();

const TitleSchema = z.object({ title: z.string().trim().min(1).max(200) });

sessionsRouter.get('/', async (_req, res) => {
  res.json(await listSessions());
});

sessionsRouter.post('/', async (req, res) => {
  const body = z.object({ title: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  res.status(201).json(await createSession(body.title));
});

sessionsRouter.get('/:id', async (req, res) => {
  res.json(await requireSession(req.params.id));
});

sessionsRouter.patch('/:id', async (req, res) => {
  const { title } = TitleSchema.parse(req.body);
  res.json(await updateSession(req.params.id, (s) => void (s.title = title)));
});

sessionsRouter.delete('/:id', async (req, res) => {
  const id = req.params.id;
  await requireSession(id);
  const materials = await getMaterials(id);
  for (const material of materials) {
    for (const part of material.parts) {
      if (part.type !== 'text' && part.fileId) await deleteFileQuietly(part.fileId);
    }
  }
  await deleteSession(id);
  res.status(204).end();
});

/** Clears the chat transcript (the guide, materials and quizzes are kept). */
sessionsRouter.delete('/:id/messages', async (req, res) => {
  res.json(await updateSession(req.params.id, (s) => void (s.messages = [])));
});
