import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { MaterialMeta } from '../../shared/types.js';
import { detectKind, extractMaterial, findSoffice, SUPPORTED_EXTENSIONS } from '../lib/extract.js';
import { deleteFileQuietly, uploadPartToFilesApi } from '../lib/claude.js';
import { filesDir, getMaterials, newId, requireSession, saveMaterials, updateSession } from '../lib/store.js';
import { httpError, nowIso, titleFromFilename } from './helpers.js';
import { DEFAULT_SESSION_TITLE } from '../../shared/session.js';

export const materialsRouter = Router();

let sofficeLookup: Promise<string | null> | null = null;
/** Resolved once per process; `SOFFICE_PATH=off` disables conversion. */
export function sofficePath(): Promise<string | null> {
  const lookup = sofficeLookup ?? (sofficeLookup = findSoffice(config.sofficePath).catch(() => null));
  return lookup;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const dir = filesDir(req.params.id as string);
      fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), (err) => cb(err as Error, dir));
    } catch (err) {
      cb(err as Error, '');
    }
  },
  filename: (_req, file, cb) => cb(null, `${newId()}${path.extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 30 },
});

materialsRouter.post('/:id/materials', upload.array('files', 30), async (req, res) => {
  const id = String(req.params.id);
  await requireSession(id);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw httpError(400, 'No files were received. Attach files under the "files" field.');

  const soffice = await sofficePath();
  const materials = await getMaterials(id);
  const metas: MaterialMeta[] = [];

  for (const file of files) {
    const materialId = path.basename(file.filename, path.extname(file.filename));
    const originalName = file.originalname;
    const kind = detectKind(originalName, file.mimetype);
    const meta: MaterialMeta = {
      id: materialId,
      name: originalName,
      kind: kind ?? 'text',
      sizeBytes: file.size,
      uploadedAt: nowIso(),
      status: 'ready',
      summary: '',
    };
    try {
      if (!kind) {
        throw new Error(`Unsupported file type "${path.extname(originalName) || file.mimetype}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`);
      }
      const extracted = await extractMaterial(
        { id: materialId, originalName, mimeType: file.mimetype, filePath: file.path, sizeBytes: file.size },
        { outDir: filesDir(id), sofficePath: soffice },
      );
      if (config.useFilesApi) {
        for (const part of extracted.parts) {
          if (part.type === 'text') continue;
          const fileId = await uploadPartToFilesApi(part, originalName);
          if (fileId) part.fileId = fileId;
        }
      }
      materials.push(extracted);
      meta.summary = extracted.summary;
      meta.pages = extracted.pages;
      meta.imageCount = extracted.imageCount;
    } catch (err) {
      meta.status = 'error';
      meta.error = (err as Error).message;
      meta.summary = 'Could not process this file';
      await fs.rm(file.path, { force: true }).catch(() => undefined);
    }
    metas.push(meta);
  }

  await saveMaterials(id, materials);
  const session = await updateSession(id, (s) => {
    s.materials.push(...metas);
    if (s.title === DEFAULT_SESSION_TITLE) {
      const first = metas.find((m) => m.status === 'ready');
      if (first) s.title = titleFromFilename(first.name);
    }
  });
  res.status(201).json(session);
});

materialsRouter.delete('/:id/materials/:materialId', async (req, res) => {
  const id = String(req.params.id);
  const materialId = String(req.params.materialId);
  await requireSession(id);
  const materials = await getMaterials(id);
  const target = materials.find((m) => m.id === materialId);
  if (target) {
    for (const part of target.parts) {
      if (part.type === 'text') continue;
      if (part.fileId) await deleteFileQuietly(part.fileId);
      await fs.rm(part.path, { force: true }).catch(() => undefined);
    }
  }
  // Remove any stray files that belong to this material (original upload, derived files).
  const dir = filesDir(id);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.filter((f) => f.startsWith(materialId)).map((f) => fs.rm(path.join(dir, f), { force: true }).catch(() => undefined)),
  );
  await saveMaterials(id, materials.filter((m) => m.id !== materialId));
  const session = await updateSession(id, (s) => void (s.materials = s.materials.filter((m) => m.id !== materialId)));
  res.json(session);
});
