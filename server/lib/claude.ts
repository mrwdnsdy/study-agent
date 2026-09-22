/**
 * Server-side glue around the shared agent core: creates the Anthropic client
 * from the environment, turns extracted materials on disk into content blocks
 * (using the Files API where available) and forwards to the core.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { ChatMessage, Quiz, QuizConfig, QuizQuestion, StreamEvent, StudyGuide } from '../../shared/types.js';
import * as core from '../../shared/agent/core.js';
import type { ExtractedMaterial, MaterialPart } from './extract.js';

export { buildQuiz, describeError, gradeChoice, basePrompt } from '../../shared/agent/core.js';
export type { ChatHooks, ChatResult, DocumentResult, QuizInput, UpdateGuideInput } from '../../shared/agent/core.js';

let cachedClient: Anthropic | null = null;

/** Lazily construct the client so the server can start (and explain itself) without a key. */
export function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  try {
    // Timeout is in milliseconds for the TypeScript SDK; long guides stream for many minutes.
    cachedClient = new Anthropic({ timeout: 30 * 60 * 1000, maxRetries: 2 });
  } catch (err) {
    throw Object.assign(
      new Error(`The Claude client could not be created: ${(err as Error).message}. Set ANTHROPIC_API_KEY in .env and restart.`),
      { status: 503 },
    );
  }
  return cachedClient;
}

function context(): core.AgentContext {
  return { client: getClient(), models: config.models, effort: config.effort, escalationModel: config.escalationModel };
}

type Send = (event: StreamEvent) => void;

async function fileBase64(filePath: string): Promise<string> {
  return (await fs.readFile(filePath)).toString('base64');
}

/** Content blocks for every material: PDFs as documents, pictures as images, extracted text as text. */
export async function materialsInput(materials: ExtractedMaterial[]): Promise<core.MaterialsInput> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const [index, material] of materials.entries()) {
    blocks.push(core.materialHeaderBlock(index, materials.length, material));
    for (const part of material.parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: `${part.label ? `[${material.name} — ${part.label}]\n` : ''}${part.text}` });
      } else if (part.type === 'pdf') {
        blocks.push({
          type: 'document',
          title: material.name,
          source: part.fileId
            ? { type: 'file', file_id: part.fileId }
            : { type: 'base64', media_type: 'application/pdf', data: await fileBase64(part.path) },
        });
      } else {
        if (part.label) blocks.push({ type: 'text', text: `[${material.name} — ${part.label}]` });
        blocks.push({
          type: 'image',
          source: part.fileId
            ? { type: 'file', file_id: part.fileId }
            : { type: 'base64', media_type: part.mediaType, data: await fileBase64(part.path) },
        });
      }
    }
  }
  return { info: materials.map((m) => ({ name: m.name, kind: m.kind, summary: m.summary })), blocks };
}

export async function generateGuide(opts: {
  materials: ExtractedMaterial[];
  prompt: string;
  send: Send;
  signal?: AbortSignal;
  model?: string;
}): Promise<core.DocumentResult> {
  return core.generateGuide(context(), { ...opts, materials: await materialsInput(opts.materials) });
}

export async function generateReview(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  quiz: Quiz;
  send: Send;
  signal?: AbortSignal;
}): Promise<core.DocumentResult> {
  return core.generateReview(context(), { ...opts, materials: await materialsInput(opts.materials) });
}

export async function runChat(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  history: ChatMessage[];
  userMessage: string;
  hooks: core.ChatHooks;
  send: Send;
  signal?: AbortSignal;
}): Promise<core.ChatResult> {
  return core.runChat(context(), { ...opts, materials: await materialsInput(opts.materials) });
}

export async function requestQuiz(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  config: QuizConfig;
  previousQuizzes: Quiz[];
  send: Send;
  signal?: AbortSignal;
}): Promise<{ input: core.QuizInput; thinking: string; usage: import('../../shared/types.js').UsageInfo }> {
  return core.requestQuiz(context(), { ...opts, materials: await materialsInput(opts.materials) });
}

export function gradeShortAnswer(question: QuizQuestion, studentAnswer: string) {
  return core.gradeShortAnswer(context(), question, studentAnswer);
}

// ---------------------------------------------------------------------------
// Files API
// ---------------------------------------------------------------------------

/** Upload a PDF/image part once so later requests reference it by id. Returns null on failure (caller inlines instead). */
export async function uploadPartToFilesApi(part: MaterialPart, materialName: string): Promise<string | null> {
  if (part.type === 'text') return null;
  try {
    const data = await fs.readFile(part.path);
    const mime = part.type === 'pdf' ? 'application/pdf' : part.mediaType;
    const uploaded = await getClient().files.upload({
      file: await toFile(data, path.basename(part.path), { type: mime }),
    });
    return uploaded.id;
  } catch (err) {
    console.warn(`[files] Upload failed for ${materialName}; content will be sent inline instead. ${core.describeError(err)}`);
    return null;
  }
}

export async function deleteFileQuietly(fileId: string): Promise<void> {
  try {
    await getClient().files.delete(fileId);
  } catch (err) {
    console.warn(`[files] Could not delete ${fileId}: ${core.describeError(err)}`);
  }
}
