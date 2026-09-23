import { Router } from 'express';
import { z } from 'zod';
import type { AnswerResponse, ChatMessage, Quiz, QuizAnswer, StreamEvent } from '../../shared/types.js';
import {
  PartialDocumentError,
  buildQuiz,
  continueDocument,
  describeError,
  generateReview,
  gradeChoice,
  gradeShortAnswer,
  longerDraft,
  partialSavedMessage,
  requestQuiz,
  type DocumentResult,
} from '../lib/claude.js';
import { getMaterials, newId, requireSession, updateSession } from '../lib/store.js';
import { httpError, nowIso, startStream } from './helpers.js';
import { config } from '../config.js';

export const quizRouter = Router();

const QuizConfigSchema = z.object({
  numQuestions: z.number().int().min(3).max(25),
  difficulty: z.enum(['easy', 'medium', 'hard', 'mixed']),
  types: z.array(z.enum(['multiple_choice', 'true_false', 'short_answer'])).min(1),
  focus: z.string().trim().max(2000).optional(),
});

const AnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().max(20_000),
  selectedOptionIndex: z.number().int().min(0).optional(),
});

function findQuiz(quizzes: Quiz[], quizId: string): Quiz {
  const quiz = quizzes.find((q) => q.id === quizId);
  if (!quiz) throw httpError(404, 'Quiz not found');
  return quiz;
}

type Send = (event: StreamEvent) => void;

const errorOptions = () => ({ showModels: config.showModels, agentName: config.agentName });

/** Saves a finished review with its announcement in the chat, and sends both. */
async function saveFinishedReview(id: string, quiz: Quiz, result: DocumentResult, send: Send): Promise<void> {
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
    const target = findQuiz(s.quizzes, quiz.id);
    target.review = result.markdown;
    target.reviewGeneratedAt = nowIso();
    target.reviewIncomplete = false;
    if (target.status !== 'completed') {
      target.status = 'completed';
      target.completedAt = nowIso();
    }
    s.messages.push(userMessage, assistantMessage);
  });
  send({ type: 'review', quiz: findQuiz(updated.quizzes, quiz.id) });
  send({ type: 'message', message: assistantMessage });
  send({ type: 'usage', usage: result.usage });
  send({ type: 'done' });
}

/**
 * Saves a review that stopped partway (keeping the longer of it and `previous`) and
 * sends it. Returns the error message for the page, or null after Stop. A failed
 * save keeps `fallback`, the message the page would have had anyway.
 */
async function savePartialReview(
  id: string,
  quizId: string,
  err: PartialDocumentError,
  send: Send,
  fallback: string | null,
  previous?: string,
): Promise<string | null> {
  try {
    const updated = await updateSession(id, (s) => {
      const target = findQuiz(s.quizzes, quizId);
      target.review = longerDraft(previous, err.markdown);
      target.reviewGeneratedAt = nowIso();
      target.reviewIncomplete = true;
      if (target.status !== 'completed') {
        target.status = 'completed';
        target.completedAt = nowIso();
      }
    });
    send({ type: 'review', quiz: findQuiz(updated.quizzes, quizId) });
    send({ type: 'usage', usage: err.usage });
    return err.reason === 'stopped' ? null : partialSavedMessage(config.agentName, err.stoppedReason);
  } catch (saveErr) {
    console.error('[review] could not save the partial review', saveErr);
    return fallback;
  }
}

quizRouter.post('/:id/quizzes', async (req, res) => {
  const id = req.params.id;
  const quizConfig = QuizConfigSchema.parse(req.body);
  const session = await requireSession(id);
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  try {
    sse.send({ type: 'status', text: 'Designing your quiz…' });
    const { input, usage } = await requestQuiz({
      materials,
      guide: session.guide,
      config: quizConfig,
      previousQuizzes: session.quizzes,
      send: (e) => sse.send(e),
      signal,
    });
    const quiz = buildQuiz(input, quizConfig, newId());
    if (quiz.questions.length === 0) throw new Error('No valid questions were produced. Please try again.');
    await updateSession(id, (s) => void s.quizzes.push(quiz));
    sse.send({ type: 'quiz', quiz });
    sse.send({ type: 'usage', usage });
    sse.send({ type: 'done' });
  } catch (err) {
    if (!signal.aborted) sse.send({ type: 'error', message: describeError(err, errorOptions()) });
    console.error('[quiz]', err);
  } finally {
    sse.end();
  }
});

quizRouter.post('/:id/quizzes/:quizId/answers', async (req, res) => {
  const { id, quizId } = req.params;
  const body = AnswerSchema.parse(req.body);
  const session = await requireSession(id);
  const quiz = findQuiz(session.quizzes, quizId);
  const question = quiz.questions.find((q) => q.id === body.questionId);
  if (!question) throw httpError(404, 'Question not found');
  if (quiz.answers.some((a) => a.questionId === question.id)) throw httpError(409, 'This question has already been answered');

  let graded: { correct: boolean; score: number; feedback: string };
  let selectedOptionIndex = body.selectedOptionIndex;
  if (question.type === 'short_answer') {
    graded = await gradeShortAnswer(question, body.answer);
  } else {
    const options = question.options ?? [];
    if (selectedOptionIndex === undefined) {
      const found = options.findIndex((o) => o.trim().toLowerCase() === body.answer.trim().toLowerCase());
      selectedOptionIndex = found >= 0 ? found : undefined;
    }
    graded = gradeChoice(question, selectedOptionIndex);
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
    if (target.answers.some((a) => a.questionId === question.id)) throw httpError(409, 'This question has already been answered');
    target.answers.push(answer);
    if (target.answers.length >= target.questions.length && target.status !== 'completed') {
      target.status = 'completed';
      target.completedAt = nowIso();
    }
  });
  const response: AnswerResponse = { answer, quiz: findQuiz(updated.quizzes, quizId) };
  res.json(response);
});

quizRouter.post('/:id/quizzes/:quizId/complete', async (req, res) => {
  const { id, quizId } = req.params;
  const updated = await updateSession(id, (s) => {
    const target = findQuiz(s.quizzes, quizId);
    if (target.status !== 'completed') {
      target.status = 'completed';
      target.completedAt = nowIso();
    }
  });
  res.json(findQuiz(updated.quizzes, quizId));
});

quizRouter.post('/:id/quizzes/:quizId/review', async (req, res) => {
  const { id, quizId } = req.params;
  const session = await requireSession(id);
  const quiz = findQuiz(session.quizzes, quizId);
  if (quiz.answers.length === 0) throw httpError(400, 'Answer at least one question before asking for a review.');
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  const send: Send = (e) => sse.send(e);
  try {
    sse.send({ type: 'status', text: 'Reviewing your answers…' });
    const result = await generateReview({ materials, guide: session.guide, quiz, send, signal });
    await saveFinishedReview(id, quiz, result, send);
  } catch (err) {
    let message: string | null = signal.aborted ? null : describeError(err, errorOptions());
    if (err instanceof PartialDocumentError) message = await savePartialReview(id, quizId, err, send, message);
    if (message && !signal.aborted) sse.send({ type: 'error', message });
    console.error('[review]', err);
  } finally {
    sse.end();
  }
});

quizRouter.post('/:id/quizzes/:quizId/review/continue', async (req, res) => {
  const { id, quizId } = req.params;
  const session = await requireSession(id);
  const quiz = findQuiz(session.quizzes, quizId);
  const draft = quiz.review;
  if (!quiz.reviewIncomplete || !draft) throw httpError(409, 'This review is already complete.');
  const materials = await getMaterials(id);
  const { sse, signal } = startStream(req, res);
  const send: Send = (e) => sse.send(e);
  try {
    sse.send({ type: 'status', text: `Picking up where ${config.agentName} left off…` });
    sse.send({ type: 'draft', target: 'text', text: draft });
    const result = await continueDocument({ kind: 'review', materials, guide: session.guide, quiz, draft, send, signal });
    await saveFinishedReview(id, quiz, result, send);
  } catch (err) {
    let message: string | null = signal.aborted ? null : describeError(err, errorOptions());
    if (err instanceof PartialDocumentError) message = await savePartialReview(id, quizId, err, send, message, draft);
    if (message && !signal.aborted) sse.send({ type: 'error', message });
    console.error('[review/continue]', err);
  } finally {
    sse.end();
  }
});

quizRouter.delete('/:id/quizzes/:quizId', async (req, res) => {
  const { id, quizId } = req.params;
  const updated = await updateSession(id, (s) => void (s.quizzes = s.quizzes.filter((q) => q.id !== quizId)));
  res.json(updated);
});
