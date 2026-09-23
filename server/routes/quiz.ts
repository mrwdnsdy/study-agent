import { Router } from 'express';
import { z } from 'zod';
import type { AnswerResponse, ChatMessage, Quiz, QuizAnswer } from '../../shared/types.js';
import { buildQuiz, describeError, generateReview, gradeChoice, gradeShortAnswer, requestQuiz } from '../lib/claude.js';
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
    if (!signal.aborted) sse.send({ type: 'error', message: describeError(err, { showModels: config.showModels, agentName: config.agentName }) });
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
  try {
    sse.send({ type: 'status', text: 'Reviewing your answers…' });
    const result = await generateReview({ materials, guide: session.guide, quiz, send: (e) => sse.send(e), signal });
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
    sse.send({ type: 'review', quiz: findQuiz(updated.quizzes, quizId) });
    sse.send({ type: 'message', message: assistantMessage });
    sse.send({ type: 'usage', usage: result.usage });
    sse.send({ type: 'done' });
  } catch (err) {
    if (!signal.aborted) sse.send({ type: 'error', message: describeError(err, { showModels: config.showModels, agentName: config.agentName }) });
    console.error('[review]', err);
  } finally {
    sse.end();
  }
});

quizRouter.delete('/:id/quizzes/:quizId', async (req, res) => {
  const { id, quizId } = req.params;
  const updated = await updateSession(id, (s) => void (s.quizzes = s.quizzes.filter((q) => q.id !== quizId)));
  res.json(updated);
});
