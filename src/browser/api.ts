/**
 * Browser-mode backend: the operations the Express routes offer, run entirely
 * in the page. Claude is called from the browser with the visitor's own key (or
 * through a proxy that holds one), files are read by the in-browser extractors
 * and everything is stored in IndexedDB. Nothing leaves the browser except the
 * requests to Claude.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_GUIDE_PROMPT,
  type AnswerRequest,
  type AnswerResponse,
  type ChatMessage,
  type MaterialMeta,
  type Quiz,
  type QuizAnswer,
  type QuizConfig,
  type ServerConfigResponse,
  type Session,
  type SessionSummary,
  type StreamEvent,
  type StudyGuide,
} from '../../shared/types';
import * as core from '../../shared/agent/core';
import { applyGuideEdit, wordCount } from '../../shared/agent/guideEdits';
import { DEFAULT_SESSION_TITLE, blankSession, summarizeSession, titleFromFilename } from '../../shared/session';
import type { Api } from '../lib/api';
import { localDb, partFileIds } from './db';
import { detectKind, extractFile } from './extract';
import { effectiveSettings, hasCredentials } from './settings';

/** Inline PDFs count against Claude's 32 MB request limit once base64-encoded. */
const MAX_PDF_MB = 20;
const MAX_UPLOAD_MB = 100;

type Send = (event: StreamEvent) => void;

export function newId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return uuid.replace(/-/g, '').slice(0, 12);
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Claude client from the visitor's settings
// ---------------------------------------------------------------------------

export const MISSING_CREDENTIALS_MESSAGE =
  'Add your Anthropic API key (or a proxy URL) in Settings before using Claude features.';

function context(): core.AgentContext {
  const settings = effectiveSettings();
  if (!hasCredentials(settings)) throw new Error(MISSING_CREDENTIALS_MESSAGE);
  const { apiKey, baseUrl: baseURL, accessCode } = settings;
  const client = new Anthropic({
    // A proxy replaces the key server-side; the SDK still needs a non-empty value.
    apiKey: apiKey || 'proxy',
    baseURL: baseURL || undefined,
    dangerouslyAllowBrowser: true,
    defaultHeaders: accessCode ? { 'x-access-code': accessCode } : undefined,
    // Milliseconds; long guides stream for many minutes.
    timeout: 30 * 60 * 1000,
    maxRetries: 2,
  });
  return { client, models: settings.models, effort: settings.effort, escalationModel: settings.escalationModel, agentName: settings.agentName };
}

/** Runs a streaming operation, turning SDK errors into the same friendly messages the server sends. */
async function streaming(signal: AbortSignal | undefined, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(core.describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Session store (IndexedDB) with the same read-modify-write lock as the server
// ---------------------------------------------------------------------------

async function requireSession(id: string): Promise<Session> {
  const session = await localDb.getSession(id);
  if (!session) throw new Error('Session not found');
  return session;
}

const locks = new Map<string, Promise<unknown>>();

async function updateSession(id: string, mutate: (session: Session) => void | Promise<void>): Promise<Session> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const session = await requireSession(id);
      await mutate(session);
      session.updatedAt = nowIso();
      await localDb.putSession(session);
      return session;
    });
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}

function findQuiz(quizzes: Quiz[], quizId: string): Quiz {
  const quiz = quizzes.find((q) => q.id === quizId);
  if (!quiz) throw new Error('Quiz not found');
  return quiz;
}

// ---------------------------------------------------------------------------
// Materials → Claude content blocks
// ---------------------------------------------------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read a stored file.'));
    reader.readAsDataURL(blob);
  });
}

async function materialsInput(sessionId: string): Promise<core.MaterialsInput> {
  const materials = await localDb.getMaterials(sessionId);
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const [index, material] of materials.entries()) {
    blocks.push(core.materialHeaderBlock(index, materials.length, material));
    for (const part of material.parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: `${part.label ? `[${material.name} — ${part.label}]\n` : ''}${part.text}` });
        continue;
      }
      const blob = await localDb.getFile(part.fileId);
      if (!blob) {
        throw new Error(`The stored copy of "${material.name}" is missing from this browser. Remove it and upload it again.`);
      }
      const data = await blobToBase64(blob);
      if (part.type === 'pdf') {
        blocks.push({ type: 'document', title: material.name, source: { type: 'base64', media_type: 'application/pdf', data } });
      } else {
        if (part.label) blocks.push({ type: 'text', text: `[${material.name} — ${part.label}]` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data } });
      }
    }
  }
  return { info: materials.map((m) => ({ name: m.name, kind: m.kind, summary: m.summary })), blocks };
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export const browserApi: Api = {
  async config(): Promise<ServerConfigResponse> {
    const settings = effectiveSettings();
    return {
      agentName: settings.agentName,
      model: settings.models.guide,
      models: settings.models,
      escalationModel: settings.escalationModel,
      hasApiKey: hasCredentials(settings),
      sofficeAvailable: false,
      maxUploadMb: MAX_UPLOAD_MB,
    };
  },

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await localDb.allSessions();
    return sessions.map(summarizeSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async createSession(title?: string): Promise<Session> {
    const session = blankSession(newId(), title);
    await localDb.putSession(session);
    return session;
  },

  getSession: (id) => requireSession(id),

  renameSession(id, title) {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Enter a title.');
    return updateSession(id, (s) => void (s.title = trimmed.slice(0, 200)));
  },

  async deleteSession(id) {
    const materials = await localDb.getMaterials(id);
    for (const material of materials) {
      for (const fileId of partFileIds(material)) await localDb.deleteFile(fileId).catch(() => undefined);
    }
    await localDb.deleteMaterials(id);
    await localDb.deleteSession(id);
  },

  clearMessages: (id) => updateSession(id, (s) => void (s.messages = [])),

  async uploadMaterials(id, files) {
    await requireSession(id);
    if (files.length === 0) throw new Error('No files were selected.');
    const materials = await localDb.getMaterials(id);
    const metas: MaterialMeta[] = [];

    for (const file of files) {
      const materialId = newId();
      const meta: MaterialMeta = {
        id: materialId,
        name: file.name,
        kind: detectKind(file.name, file.type) ?? 'text',
        sizeBytes: file.size,
        uploadedAt: nowIso(),
        status: 'ready',
        summary: '',
      };
      const stored: string[] = [];
      try {
        if (file.size > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`Files larger than ${MAX_UPLOAD_MB} MB are not supported.`);
        if (meta.kind === 'pdf' && file.size > MAX_PDF_MB * 1024 * 1024) {
          throw new Error(`PDFs larger than ${MAX_PDF_MB} MB cannot be sent to Claude from the browser. Split or compress the file.`);
        }
        const { material, files: blobs } = await extractFile(file, materialId);
        for (const [fileId, blob] of blobs) {
          await localDb.putFile(fileId, blob);
          stored.push(fileId);
        }
        materials.push(material);
        meta.summary = material.summary;
        meta.pages = material.pages;
        meta.imageCount = material.imageCount;
      } catch (err) {
        meta.status = 'error';
        meta.error = (err as Error).message;
        meta.summary = 'Could not process this file';
        for (const fileId of stored) await localDb.deleteFile(fileId).catch(() => undefined);
      }
      metas.push(meta);
    }

    await localDb.putMaterials(id, materials);
    return updateSession(id, (s) => {
      s.materials.push(...metas);
      if (s.title === DEFAULT_SESSION_TITLE) {
        const first = metas.find((m) => m.status === 'ready');
        if (first) s.title = titleFromFilename(first.name);
      }
    });
  },

  async deleteMaterial(id, materialId) {
    await requireSession(id);
    const materials = await localDb.getMaterials(id);
    const target = materials.find((m) => m.id === materialId);
    if (target) {
      for (const fileId of partFileIds(target)) await localDb.deleteFile(fileId).catch(() => undefined);
    }
    await localDb.putMaterials(id, materials.filter((m) => m.id !== materialId));
    return updateSession(id, (s) => void (s.materials = s.materials.filter((m) => m.id !== materialId)));
  },

  generateGuide: (id, prompt, onEvent, signal, quality) =>
    streaming(signal, async () => {
      const text = prompt.trim();
      if (!text) throw new Error('Describe the study guide you want first.');
      const session = await requireSession(id);
      const ctx = context();
      const materials = await materialsInput(id);
      const version = (session.guide?.version ?? 0) + 1;
      const model = quality === 'max' ? ctx.escalationModel : undefined;
      onEvent({ type: 'status', text: materials.info.length ? 'Reading your materials…' : 'Starting…' });
      onEvent({ type: 'guide_start', version });
      const result = await core.generateGuide(ctx, { materials, prompt: text, send: onEvent, signal, model });
      const guide: StudyGuide = { markdown: result.markdown, version, updatedAt: nowIso(), prompt: text, model: result.model };
      const userMessage: ChatMessage = { id: newId(), role: 'user', content: text, createdAt: nowIso(), kind: 'guide' };
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        kind: 'guide',
        content: `📘 Study guide v${version} is ready (about ${wordCount(guide.markdown).toLocaleString()} words, written by ${result.model}). Open the **Study Guide** tab to read it, or tell me what to change, expand or explain.`,
        thinking: result.thinking || undefined,
        createdAt: nowIso(),
      };
      await updateSession(id, (s) => {
        s.guide = guide;
        s.messages.push(userMessage, assistantMessage);
      });
      onEvent({ type: 'guide', guide });
      onEvent({ type: 'message', message: assistantMessage });
      onEvent({ type: 'usage', usage: result.usage });
      onEvent({ type: 'done' });
    }),

  chat: (id, message, onEvent, signal) =>
    streaming(signal, async () => {
      const text = message.trim();
      if (!text) throw new Error('Type a message first.');
      const session = await requireSession(id);
      const ctx = context();
      const materials = await materialsInput(id);
      const send: Send = onEvent;

      const userMessage: ChatMessage = { id: newId(), role: 'user', content: text, createdAt: nowIso(), kind: 'chat' };
      await updateSession(id, (s) => void s.messages.push(userMessage));

      const hooks: core.ChatHooks = {
        applyGuideEdit: async (input) => {
          let outcome: { ok: boolean; message: string } = { ok: false, message: 'Unknown error' };
          const updated = await updateSession(id, (s) => {
            const current = s.guide?.markdown ?? '';
            if (!current.trim() && input.operation !== 'replace_all' && input.operation !== 'append') {
              outcome = { ok: false, message: 'There is no study guide yet. Use regenerate_study_guide, or replace_all/append to create one.' };
              return;
            }
            const result = applyGuideEdit(current, input.operation, input.heading, input.markdown);
            outcome = { ok: result.ok, message: result.message };
            if (result.ok) {
              s.guide = {
                markdown: result.markdown,
                version: (s.guide?.version ?? 0) + 1,
                updatedAt: nowIso(),
                prompt: s.guide?.prompt ?? DEFAULT_GUIDE_PROMPT,
              };
            }
          });
          return { ...outcome, guide: outcome.ok && updated.guide ? updated.guide : undefined };
        },
        regenerateGuide: async (instructions) => {
          const current = await requireSession(id);
          const prompt = `${core.basePrompt(current.guide?.prompt, DEFAULT_GUIDE_PROMPT)}\n\nRevision instructions: ${instructions.trim()}`;
          const version = (current.guide?.version ?? 0) + 1;
          // A guide written at maximum quality stays on the escalation model when rewritten.
          const model = current.guide?.model && current.guide.model === ctx.escalationModel ? ctx.escalationModel : undefined;
          send({ type: 'guide_start', version });
          const result = await core.generateGuide(ctx, { materials, prompt, send, signal, model });
          const guide: StudyGuide = { markdown: result.markdown, version, updatedAt: nowIso(), prompt, model: result.model };
          await updateSession(id, (s) => void (s.guide = guide));
          send({ type: 'guide', guide });
          return guide;
        },
        createQuiz: async (input) => {
          const quiz = core.buildQuiz(input, { numQuestions: input.questions.length, difficulty: 'mixed', types: [] }, newId());
          if (quiz.questions.length > 0) await updateSession(id, (s) => void s.quizzes.push(quiz));
          return quiz;
        },
      };

      const result = await core.runChat(ctx, {
        materials,
        guide: session.guide,
        history: session.messages,
        userMessage: text,
        hooks,
        send,
        signal,
      });
      const fallback = result.toolEvents.length
        ? result.toolEvents.map((e) => `✅ ${e.summary}`).join('\n')
        : '(No response text was produced. Please try again.)';
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        kind: 'chat',
        content: result.text || fallback,
        thinking: result.thinking || undefined,
        toolEvents: result.toolEvents.length ? result.toolEvents : undefined,
        createdAt: nowIso(),
      };
      await updateSession(id, (s) => void s.messages.push(assistantMessage));
      send({ type: 'message', message: assistantMessage });
      send({ type: 'usage', usage: result.usage });
      send({ type: 'done' });
    }),

  createQuiz: (id, config, onEvent, signal) =>
    streaming(signal, async () => {
      const quizConfig: QuizConfig = {
        numQuestions: Math.max(3, Math.min(25, Math.round(config.numQuestions) || 8)),
        difficulty: config.difficulty,
        types: config.types.length ? config.types : ['multiple_choice', 'true_false', 'short_answer'],
        focus: config.focus?.trim() ? config.focus.trim().slice(0, 2000) : undefined,
      };
      const session = await requireSession(id);
      const ctx = context();
      const materials = await materialsInput(id);
      onEvent({ type: 'status', text: 'Designing your quiz…' });
      const { input, usage } = await core.requestQuiz(ctx, {
        materials,
        guide: session.guide,
        config: quizConfig,
        previousQuizzes: session.quizzes,
        send: onEvent,
        signal,
      });
      const quiz = core.buildQuiz(input, quizConfig, newId());
      if (quiz.questions.length === 0) throw new Error('No valid questions were produced. Please try again.');
      await updateSession(id, (s) => void s.quizzes.push(quiz));
      onEvent({ type: 'quiz', quiz });
      onEvent({ type: 'usage', usage });
      onEvent({ type: 'done' });
    }),

  async answerQuestion(id, quizId, body: AnswerRequest): Promise<AnswerResponse> {
    const session = await requireSession(id);
    const quiz = findQuiz(session.quizzes, quizId);
    const question = quiz.questions.find((q) => q.id === body.questionId);
    if (!question) throw new Error('Question not found');
    if (quiz.answers.some((a) => a.questionId === question.id)) throw new Error('This question has already been answered');

    let graded: { correct: boolean; score: number; feedback: string };
    let selectedOptionIndex = body.selectedOptionIndex;
    if (question.type === 'short_answer') {
      try {
        graded = await core.gradeShortAnswer(context(), question, body.answer);
      } catch (err) {
        throw new Error(core.describeError(err));
      }
    } else {
      const options = question.options ?? [];
      if (selectedOptionIndex === undefined) {
        const found = options.findIndex((o) => o.trim().toLowerCase() === body.answer.trim().toLowerCase());
        selectedOptionIndex = found >= 0 ? found : undefined;
      }
      graded = core.gradeChoice(question, selectedOptionIndex);
    }

    const answer: QuizAnswer = {
      questionId: question.id,
      answer: body.answer,
      selectedOptionIndex,
      correct: graded.correct,
      score: graded.score,
      feedback: graded.feedback,
      answeredAt: nowIso(),
    };
    const updated = await updateSession(id, (s) => {
      const target = findQuiz(s.quizzes, quizId);
      if (target.answers.some((a) => a.questionId === question.id)) throw new Error('This question has already been answered');
      target.answers.push(answer);
      if (target.answers.length >= target.questions.length && target.status !== 'completed') {
        target.status = 'completed';
        target.completedAt = nowIso();
      }
    });
    return { answer, quiz: findQuiz(updated.quizzes, quizId) };
  },

  async completeQuiz(id, quizId) {
    const updated = await updateSession(id, (s) => {
      const target = findQuiz(s.quizzes, quizId);
      if (target.status !== 'completed') {
        target.status = 'completed';
        target.completedAt = nowIso();
      }
    });
    return findQuiz(updated.quizzes, quizId);
  },

  reviewQuiz: (id, quizId, onEvent, signal) =>
    streaming(signal, async () => {
      const session = await requireSession(id);
      const quiz = findQuiz(session.quizzes, quizId);
      if (quiz.answers.length === 0) throw new Error('Answer at least one question before asking for a review.');
      const ctx = context();
      const materials = await materialsInput(id);
      onEvent({ type: 'status', text: 'Reviewing your answers…' });
      const result = await core.generateReview(ctx, { materials, guide: session.guide, quiz, send: onEvent, signal });
      const correct = quiz.answers.filter((a) => a.correct).length;
      const userMessage: ChatMessage = {
        id: newId(),
        role: 'user',
        kind: 'quiz-review',
        content: `I completed the quiz "${quiz.title}" and scored ${correct}/${quiz.answers.length}. Please review my performance.`,
        createdAt: nowIso(),
      };
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        kind: 'quiz-review',
        content: result.markdown,
        thinking: result.thinking || undefined,
        createdAt: nowIso(),
      };
      const updated = await updateSession(id, (s) => {
        const target = findQuiz(s.quizzes, quizId);
        target.review = result.markdown;
        target.reviewGeneratedAt = nowIso();
        if (target.status !== 'completed') {
          target.status = 'completed';
          target.completedAt = nowIso();
        }
        s.messages.push(userMessage, assistantMessage);
      });
      onEvent({ type: 'review', quiz: findQuiz(updated.quizzes, quizId) });
      onEvent({ type: 'message', message: assistantMessage });
      onEvent({ type: 'usage', usage: result.usage });
      onEvent({ type: 'done' });
    }),

  deleteQuiz: (id, quizId) => updateSession(id, (s) => void (s.quizzes = s.quizzes.filter((q) => q.id !== quizId))),
};
