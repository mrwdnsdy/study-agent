import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_GUIDE_PROMPT, type ChatMessage, type StudyGuide } from '../../shared/types.js';
import { basePrompt, buildQuiz, describeError, generateGuide, runChat, type ChatHooks } from '../lib/claude.js';
import { displayModel } from '../../shared/agent/constants.js';
import { applyGuideEdit, wordCount } from '../../shared/agent/guideEdits.js';
import { getMaterials, newId, requireSession, updateSession } from '../lib/store.js';
import { nowIso, startStream } from './helpers.js';
import { config } from '../config.js';

export const studyRouter = Router();

const GenerateSchema = z.object({ prompt: z.string().trim().min(1).max(20_000), quality: z.enum(['standard', 'max']).optional() });
const ChatSchema = z.object({ message: z.string().trim().min(1).max(50_000) });

studyRouter.post('/:id/generate', async (req, res) => {
  const id = req.params.id;
  const { prompt, quality } = GenerateSchema.parse(req.body);
  const session = await requireSession(id);
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  try {
    const version = (session.guide?.version ?? 0) + 1;
    const model = quality === 'max' ? config.escalationModel : undefined;
    sse.send({ type: 'status', text: materials.length ? 'Reading your materials…' : 'Starting…' });
    sse.send({ type: 'guide_start', version });
    const result = await generateGuide({ materials, prompt, send: (e) => sse.send(e), signal, model });
    const guide: StudyGuide = { markdown: result.markdown, version, updatedAt: nowIso(), prompt, model: result.model };
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: prompt, createdAt: nowIso(), kind: 'guide' };
    const assistantMessage: ChatMessage = {
      id: newId(),
      role: 'assistant',
      kind: 'guide',
      content: `📘 Study guide v${version} is ready (about ${wordCount(guide.markdown).toLocaleString()} words, written by ${displayModel(result.model)}). Open the **Study Guide** tab to read it, or tell me what to change, expand or explain.`,
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
    if (!signal.aborted) sse.send({ type: 'error', message: describeError(err) });
    console.error('[generate]', err);
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
  const send = (e: Parameters<typeof sse.send>[0]) => sse.send(e);

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
      const result = await generateGuide({ materials, prompt, send, signal, model });
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
    sse.send({ type: 'message', message: assistantMessage });
    sse.send({ type: 'usage', usage: result.usage });
    sse.send({ type: 'done' });
  } catch (err) {
    if (!signal.aborted) sse.send({ type: 'error', message: describeError(err) });
    console.error('[chat]', err);
  } finally {
    sse.end();
  }
});
