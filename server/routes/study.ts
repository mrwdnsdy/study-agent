import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_GUIDE_PROMPT, type ChatMessage, type StreamEvent, type StudyGuide, type ToolEvent } from '../../shared/types.js';
import {
  PartialDocumentError,
  PartialReplyError,
  basePrompt,
  buildQuiz,
  continueDocument,
  describeError,
  generateGuide,
  guidePartialMessage,
  guideReadyMessage,
  partialGuide,
  partialSavedMessage,
  replyCutOffMessage,
  runChat,
  type ChatHooks,
  type DocumentResult,
} from '../lib/claude.js';
import { applyGuideEdit, wordCount } from '../../shared/agent/guideEdits.js';
import { getMaterials, newId, requireSession, updateSession } from '../lib/store.js';
import { httpError, nowIso, startStream } from './helpers.js';
import { config } from '../config.js';

export const studyRouter = Router();

const GenerateSchema = z.object({ prompt: z.string().trim().min(1).max(20_000), quality: z.enum(['standard', 'max']).optional() });
const ChatSchema = z.object({ message: z.string().trim().min(1).max(50_000) });

type Send = (event: StreamEvent) => void;

const errorOptions = () => ({ showModels: config.showModels, agentName: config.agentName });

/** The saved text of a reply that produced no text of its own. */
function replyFallback(toolEvents: ToolEvent[]): string {
  return toolEvents.length ? toolEvents.map((e) => `✅ ${e.summary}`).join('\n') : '(No response text was produced. Please try again.)';
}

/** Runs `save`; if saving itself fails, logs it and keeps the error message the page would have had anyway. */
async function savedOr(save: () => Promise<string | null>, fallback: string | null, label: string): Promise<string | null> {
  try {
    return await save();
  } catch (err) {
    console.error(`[${label}] could not save the partial result`, err);
    return fallback;
  }
}

/**
 * Saves a study guide that stopped partway, with a chat note that says how to
 * finish it, and sends both. Returns the error message for the page, or null
 * after Stop (the browser has gone and shows no error).
 */
async function savePartialGuide(
  id: string,
  err: PartialDocumentError,
  opts: { version: number; prompt: string; request?: ChatMessage; previous?: StudyGuide },
  send: Send,
): Promise<string | null> {
  const guide = partialGuide(err, { version: opts.version, prompt: opts.prompt, updatedAt: nowIso(), previous: opts.previous });
  const note: ChatMessage = {
    id: newId(),
    role: 'assistant',
    kind: 'guide',
    content: guidePartialMessage(opts.version, wordCount(guide.markdown), config.agentName, err.stoppedReason),
    thinking: err.thinking || undefined,
    createdAt: nowIso(),
  };
  await updateSession(id, (s) => {
    s.guide = guide;
    if (opts.request) s.messages.push(opts.request);
    s.messages.push(note);
  });
  send({ type: 'guide', guide });
  send({ type: 'message', message: note });
  send({ type: 'usage', usage: err.usage });
  return err.reason === 'stopped' ? null : partialSavedMessage(config.agentName, err.stoppedReason);
}

studyRouter.post('/:id/generate', async (req, res) => {
  const id = req.params.id;
  const { prompt, quality } = GenerateSchema.parse(req.body);
  const session = await requireSession(id);
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  const send: Send = (e) => sse.send(e);
  const version = (session.guide?.version ?? 0) + 1;
  try {
    const model = quality === 'max' ? config.escalationModel : undefined;
    sse.send({ type: 'status', text: materials.length ? 'Reading your materials…' : 'Starting…' });
    sse.send({ type: 'guide_start', version });
    const result = await generateGuide({ materials, prompt, send, signal, model });
    const guide: StudyGuide = { markdown: result.markdown, version, updatedAt: nowIso(), prompt, model: result.model };
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: prompt, createdAt: nowIso(), kind: 'guide' };
    const assistantMessage: ChatMessage = {
      id: newId(),
      role: 'assistant',
      kind: 'guide',
      content: guideReadyMessage(version, wordCount(guide.markdown), result.model, config.showModels),
      thinking: result.thinking || undefined,
      createdAt: nowIso(),
    };
    await updateSession(id, (s) => {
      s.guide = guide;
      s.messages.push(userMessage, assistantMessage);
    });
    sse.send({ type: 'guide', guide });
    sse.send({ type: 'message', message: assistantMessage });
    sse.send({ type: 'usage', usage: result.usage });
    sse.send({ type: 'done' });
  } catch (err) {
    let message: string | null = signal.aborted ? null : describeError(err, errorOptions());
    if (err instanceof PartialDocumentError) {
      const request: ChatMessage = { id: newId(), role: 'user', content: prompt, createdAt: nowIso(), kind: 'guide' };
      message = await savedOr(() => savePartialGuide(id, err, { version, prompt, request }, send), message, 'generate');
    }
    if (message && !signal.aborted) sse.send({ type: 'error', message });
    console.error('[generate]', err);
  } finally {
    sse.end();
  }
});

studyRouter.post('/:id/guide/continue', async (req, res) => {
  const id = req.params.id;
  const session = await requireSession(id);
  const guide = session.guide;
  if (!guide?.incomplete) throw httpError(409, 'This study guide is already complete.');
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  const send: Send = (e) => sse.send(e);
  try {
    sse.send({ type: 'status', text: `Picking up where ${config.agentName} left off…` });
    sse.send({ type: 'guide_start', version: guide.version });
    sse.send({ type: 'draft', target: 'guide', text: guide.markdown });
    const result: DocumentResult = await continueDocument({ kind: 'guide', materials, guide, draft: guide.markdown, send, signal });
    const finished: StudyGuide = { markdown: result.markdown, version: guide.version, updatedAt: nowIso(), prompt: guide.prompt, model: result.model, incomplete: false };
    const note: ChatMessage = {
      id: newId(),
      role: 'assistant',
      kind: 'guide',
      content: guideReadyMessage(guide.version, wordCount(finished.markdown), result.model, config.showModels),
      thinking: result.thinking || undefined,
      createdAt: nowIso(),
    };
    await updateSession(id, (s) => {
      s.guide = finished;
      s.messages.push(note);
    });
    sse.send({ type: 'guide', guide: finished });
    sse.send({ type: 'message', message: note });
    sse.send({ type: 'usage', usage: result.usage });
    sse.send({ type: 'done' });
  } catch (err) {
    let message: string | null = signal.aborted ? null : describeError(err, errorOptions());
    if (err instanceof PartialDocumentError) {
      message = await savedOr(() => savePartialGuide(id, err, { version: guide.version, prompt: guide.prompt, previous: guide }, send), message, 'guide/continue');
    }
    if (message && !signal.aborted) sse.send({ type: 'error', message });
    console.error('[guide/continue]', err);
  } finally {
    sse.end();
  }
});

studyRouter.post('/:id/chat', async (req, res) => {
  const id = req.params.id;
  const { message } = ChatSchema.parse(req.body);
  const session = await requireSession(id);
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  const send: Send = (e) => sse.send(e);

  const userMessage: ChatMessage = { id: newId(), role: 'user', content: message, createdAt: nowIso(), kind: 'chat' };
  await updateSession(id, (s) => void s.messages.push(userMessage));

  const hooks: ChatHooks = {
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
      const prompt = `${basePrompt(current.guide?.prompt, DEFAULT_GUIDE_PROMPT)}\n\nRevision instructions: ${instructions.trim()}`;
      const version = (current.guide?.version ?? 0) + 1;
      // A guide written at maximum quality stays on the escalation model when rewritten.
      const model = current.guide?.model && current.guide.model === config.escalationModel ? config.escalationModel : undefined;
      send({ type: 'guide_start', version });
      let result: DocumentResult;
      try {
        result = await generateGuide({ materials, prompt, send, signal, model });
      } catch (err) {
        if (!(err instanceof PartialDocumentError)) throw err;
        // The partial guide is kept; the tool result tells the model (and the student) what happened.
        const failure = await savePartialGuide(id, err, { version, prompt }, send);
        throw failure ? new Error(failure) : err;
      }
      const guide: StudyGuide = { markdown: result.markdown, version, updatedAt: nowIso(), prompt, model: result.model };
      await updateSession(id, (s) => void (s.guide = guide));
      send({ type: 'guide', guide });
      return guide;
    },
    createQuiz: async (input) => {
      const quiz = buildQuiz(input, { numQuestions: input.questions.length, difficulty: 'mixed', types: [] }, newId());
      if (quiz.questions.length > 0) await updateSession(id, (s) => void s.quizzes.push(quiz));
      return quiz;
    },
  };

  try {
    const result = await runChat({
      materials,
      guide: session.guide,
      history: session.messages,
      userMessage: message,
      hooks,
      send,
      signal,
    });
    const assistantMessage: ChatMessage = {
      id: newId(),
      role: 'assistant',
      kind: 'chat',
      content: result.text || replyFallback(result.toolEvents),
      thinking: result.thinking || undefined,
      toolEvents: result.toolEvents.length ? result.toolEvents : undefined,
      createdAt: nowIso(),
    };
    await updateSession(id, (s) => void s.messages.push(assistantMessage));
    sse.send({ type: 'message', message: assistantMessage });
    sse.send({ type: 'usage', usage: result.usage });
    sse.send({ type: 'done' });
  } catch (err) {
    let failure: string | null = signal.aborted ? null : describeError(err, errorOptions());
    if (err instanceof PartialReplyError) {
      // Keep what the student already read; the Continue chip asks for the rest.
      const partialMessage: ChatMessage = {
        id: newId(),
        role: 'assistant',
        kind: 'chat',
        content: err.text || replyFallback(err.toolEvents),
        thinking: err.thinking || undefined,
        toolEvents: err.toolEvents.length ? err.toolEvents : undefined,
        incomplete: true,
        createdAt: nowIso(),
      };
      failure = await savedOr(
        async () => {
          await updateSession(id, (s) => void s.messages.push(partialMessage));
          sse.send({ type: 'message', message: partialMessage });
          sse.send({ type: 'usage', usage: err.usage });
          return err.reason === 'stopped' ? null : replyCutOffMessage(config.agentName);
        },
        failure,
        'chat',
      );
    }
    if (failure && !signal.aborted) sse.send({ type: 'error', message: failure });
    console.error('[chat]', err);
  } finally {
    sse.end();
  }
});
