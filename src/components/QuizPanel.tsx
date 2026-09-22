import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Lightbulb, Loader2, Play, Sparkles, Trash2, Trophy, XCircle } from 'lucide-react';
import {
  QUESTION_TYPE_LABELS,
  type AnswerRequest,
  type AnswerResponse,
  type Difficulty,
  type QuestionType,
  type Quiz,
  type QuizAnswer,
  type QuizConfig,
  type Session,
} from '../../shared/types';
import { percent, relativeTime } from '../lib/format';
import { topicScores, type StreamState, type Toast } from '../state';
import { Markdown } from './Markdown';
import { confirmAction } from '../lib/confirm';

const ALL_TYPES: QuestionType[] = ['multiple_choice', 'true_false', 'short_answer'];
const LETTERS = 'ABCDEF';

interface Props {
  session: Session;
  stream: StreamState;
  busy: boolean;
  activeQuizId: string | null;
  onSelectQuiz: (quizId: string | null) => void;
  onCreate: (config: QuizConfig) => void;
  onAnswer: (quizId: string, body: AnswerRequest) => Promise<AnswerResponse>;
  onComplete: (quizId: string) => Promise<void>;
  onReview: (quizId: string) => void;
  onOpenReview: (quizId: string) => void;
  onDelete: (quizId: string) => void;
  onToast: (toast: Toast) => void;
}

function QuizSetup({ onCreate, busy, hasMaterials }: { onCreate: (config: QuizConfig) => void; busy: boolean; hasMaterials: boolean }) {
  const [numQuestions, setNumQuestions] = useState(10);
  const [difficulty, setDifficulty] = useState<Difficulty>('mixed');
  const [types, setTypes] = useState<QuestionType[]>(ALL_TYPES);
  const [focus, setFocus] = useState('');

  const toggleType = (type: QuestionType) =>
    setTypes((current) => (current.includes(type) ? (current.length > 1 ? current.filter((t) => t !== type) : current) : [...current, type]));

  return (
    <form
      className="card quiz-setup"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ numQuestions, difficulty, types, focus: focus.trim() || undefined });
      }}
    >
      <h2>
        <Sparkles size={18} /> New quiz
      </h2>
      <p className="muted small">The agent writes fresh questions from your materials, grades every answer and explains why.</p>
      <div className="field-row">
        <label>
          Questions: <strong>{numQuestions}</strong>
          <input type="range" min={3} max={25} value={numQuestions} onChange={(e) => setNumQuestions(Number(e.target.value))} />
        </label>
        <label>
          Difficulty
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
            <option value="mixed">Mixed</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
      </div>
      <fieldset className="field-row field-row--types">
        <legend>Question types</legend>
        {ALL_TYPES.map((type) => (
          <label key={type} className="checkbox">
            <input type="checkbox" checked={types.includes(type)} onChange={() => toggleType(type)} /> {QUESTION_TYPE_LABELS[type]}
          </label>
        ))}
      </fieldset>
      <label>
        Focus (optional)
        <input
          type="text"
          value={focus}
          placeholder="e.g. slides 10–20, or “the topics I got wrong last time”"
          onChange={(e) => setFocus(e.target.value)}
        />
      </label>
      {!hasMaterials && <p className="notice notice--warn">Upload materials first so the questions come from your module.</p>}
      <button type="submit" className="btn btn--primary btn--lg" disabled={busy}>
        <Play size={18} /> Start quiz
      </button>
    </form>
  );
}

function ScoreBadge({ quiz }: { quiz: Quiz }) {
  const correct = quiz.answers.filter((a) => a.correct).length;
  if (quiz.answers.length === 0) return <span className="pill pill--muted">not started</span>;
  const pct = percent(correct, quiz.answers.length);
  return <span className={`pill ${pct >= 70 ? 'pill--good' : pct >= 40 ? 'pill--warn' : 'pill--bad'}`}>{pct}%</span>;
}

function QuizList({ quizzes, onOpen, onDelete, busy }: { quizzes: Quiz[]; onOpen: (id: string) => void; onDelete: (id: string) => void; busy: boolean }) {
  if (quizzes.length === 0) return null;
  const sorted = [...quizzes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section className="quiz-list">
      <h3>Your quizzes</h3>
      <ul>
        {sorted.map((quiz) => (
          <li key={quiz.id} className="quiz-row">
            <button type="button" className="quiz-row__main" onClick={() => onOpen(quiz.id)}>
              <span className="quiz-row__title">{quiz.title}</span>
              <span className="muted small">
                {quiz.questions.length} questions · {quiz.answers.length} answered · {relativeTime(quiz.createdAt)}
                {quiz.review ? ' · review ready' : ''}
              </span>
            </button>
            <ScoreBadge quiz={quiz} />
            <span className="pill pill--muted">{quiz.status === 'completed' ? 'done' : 'in progress'}</span>
            <button type="button" className="icon-btn icon-btn--danger" title="Delete quiz" disabled={busy} onClick={() => onDelete(quiz.id)}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QuizSession({
  quiz,
  busy,
  onAnswer,
  onComplete,
  onReview,
  onOpenReview,
  onBack,
  onToast,
}: {
  quiz: Quiz;
  busy: boolean;
  onAnswer: (quizId: string, body: AnswerRequest) => Promise<AnswerResponse>;
  onComplete: (quizId: string) => Promise<void>;
  onReview: (quizId: string) => void;
  onOpenReview: (quizId: string) => void;
  onBack: () => void;
  onToast: (toast: Toast) => void;
}) {
  const [feedback, setFeedback] = useState<QuizAnswer | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showResults, setShowResults] = useState(quiz.status === 'completed');

  useEffect(() => {
    setFeedback(null);
    setSelected(null);
    setText('');
    setShowHint(false);
    setShowResults(quiz.status === 'completed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quiz.id]);

  const total = quiz.questions.length;
  const answered = quiz.answers.length;
  const correct = quiz.answers.filter((a) => a.correct).length;

  const reset = () => {
    setFeedback(null);
    setSelected(null);
    setText('');
    setShowHint(false);
  };

  if (showResults || (answered >= total && !feedback)) {
    const scores = topicScores(quiz);
    const pct = percent(correct, Math.max(answered, 1));
    return (
      <div className="quiz-results">
        <div className="card quiz-results__summary">
          <div className="quiz-results__score">
            <Trophy size={28} />
            <div>
              <div className="quiz-results__pct">{pct}%</div>
              <div className="muted small">
                {correct} of {answered} correct · {quiz.title}
              </div>
            </div>
          </div>
          <div className="quiz-results__actions">
            {quiz.review ? (
              <button type="button" className="btn btn--primary" onClick={() => onOpenReview(quiz.id)}>
                Open review session
              </button>
            ) : (
              <button type="button" className="btn btn--primary" disabled={busy || answered === 0} onClick={() => onReview(quiz.id)}>
                <Sparkles size={16} /> Get my review session
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={onBack}>
              <ArrowLeft size={16} /> All quizzes
            </button>
          </div>
        </div>
        {scores.length > 0 && (
          <div className="card">
            <h3>By topic</h3>
            <table className="topic-table">
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Correct</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((t) => (
                  <tr key={t.topic}>
                    <td>{t.topic}</td>
                    <td>
                      {t.correct}/{t.total}
                    </td>
                    <td>
                      <div className="bar">
                        <div className={`bar__fill ${t.correct / t.total >= 0.7 ? 'is-good' : 'is-bad'}`} style={{ width: `${percent(t.correct, t.total)}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card">
          <h3>Questions</h3>
          <ol className="answer-list">
            {quiz.questions.map((q, i) => {
              const a = quiz.answers.find((x) => x.questionId === q.id);
              return (
                <li key={q.id} className={`answer-item ${a ? (a.correct ? 'is-correct' : 'is-wrong') : 'is-skipped'}`}>
                  <details>
                    <summary>
                      {a ? a.correct ? <CheckCircle2 size={16} /> : <XCircle size={16} /> : <span className="dot" />}
                      <span className="answer-item__q">
                        {i + 1}. {q.question.split('\n')[0]}
                      </span>
                      <span className="pill pill--muted">{q.topic}</span>
                    </summary>
                    <div className="answer-item__detail">
                      <Markdown markdown={q.question} />
                      {a ? (
                        <>
                          <p>
                            <strong>Your answer:</strong> {a.answer || '(skipped)'}
                            {q.type === 'short_answer' && ` — score ${a.score}/100`}
                          </p>
                          <Markdown markdown={a.feedback} />
                        </>
                      ) : (
                        <p className="muted">Not answered.</p>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    );
  }

  if (feedback) {
    const q = quiz.questions.find((x) => x.id === feedback.questionId)!;
    const isLast = answered >= total;
    return (
      <div className="quiz-run">
        <QuizProgress quiz={quiz} index={answered - 1} />
        <div className={`card feedback ${feedback.correct ? 'feedback--correct' : 'feedback--wrong'}`}>
          <div className="feedback__header">
            {feedback.correct ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
            <strong>{feedback.correct ? 'Correct!' : feedback.score > 0 ? `Partially right (${feedback.score}/100)` : 'Not quite'}</strong>
            {q.sourceRef && <span className="pill pill--muted">{q.sourceRef}</span>}
          </div>
          <div className="feedback__question">
            <Markdown markdown={q.question} />
          </div>
          <p className="feedback__yours">
            <strong>Your answer:</strong> {feedback.answer || '(skipped)'}
          </p>
          <Markdown markdown={feedback.feedback} />
          {q.type === 'short_answer' && (
            <div className="feedback__model">
              <strong>Model answer</strong>
              <Markdown markdown={q.modelAnswer} />
            </div>
          )}
          <div className="quiz-run__actions">
            <button
              type="button"
              className="btn btn--primary btn--lg"
              onClick={() => {
                reset();
                if (isLast) setShowResults(true);
              }}
            >
              {isLast ? (
                <>
                  See results <Trophy size={18} />
                </>
              ) : (
                <>
                  Next question <ArrowRight size={18} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const question = quiz.questions[answered];
  if (!question) return null;
  const isChoice = question.type !== 'short_answer';

  const submit = async (skip = false) => {
    if (submitting) return;
    const body: AnswerRequest = isChoice
      ? {
          questionId: question.id,
          answer: skip || selected === null ? '' : (question.options?.[selected] ?? ''),
          selectedOptionIndex: skip || selected === null ? undefined : selected,
        }
      : { questionId: question.id, answer: skip ? '' : text.trim() };
    setSubmitting(true);
    try {
      const result = await onAnswer(quiz.id, body);
      setFeedback(result.answer);
    } catch (err) {
      onToast({ kind: 'error', message: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = isChoice ? selected !== null : text.trim().length > 0;

  return (
    <div className="quiz-run">
      <QuizProgress quiz={quiz} index={answered} />
      <div className="card question">
        <div className="question__chips">
          <span className="pill">{question.topic}</span>
          <span className={`pill pill--${question.difficulty}`}>{question.difficulty}</span>
          <span className="pill pill--muted">{QUESTION_TYPE_LABELS[question.type]}</span>
          {question.sourceRef && <span className="pill pill--muted">{question.sourceRef}</span>}
        </div>
        <div className="question__text">
          <Markdown markdown={question.question} />
        </div>
        {isChoice ? (
          <div className="options">
            {question.options?.map((option, index) => (
              <button
                key={index}
                type="button"
                className={`option${selected === index ? ' is-selected' : ''}`}
                onClick={() => setSelected(index)}
                disabled={submitting}
              >
                <span className="option__letter">{LETTERS[index] ?? index + 1}</span>
                <span className="option__text">{option}</span>
              </button>
            ))}
          </div>
        ) : (
          <textarea
            className="answer-input"
            value={text}
            rows={4}
            placeholder="Type your answer. Explain your reasoning — the agent grades understanding, not wording."
            onChange={(e) => setText(e.target.value)}
            disabled={submitting}
          />
        )}
        {showHint && question.hint && (
          <p className="hint">
            <Lightbulb size={16} /> {question.hint}
          </p>
        )}
        <div className="quiz-run__actions">
          <button type="button" className="btn btn--primary btn--lg" disabled={!canSubmit || submitting} onClick={() => submit(false)}>
            {submitting ? (
              <>
                <Loader2 size={18} className="spin" /> {isChoice ? 'Checking…' : 'Grading…'}
              </>
            ) : (
              <>Check answer</>
            )}
          </button>
          {question.hint && !showHint && (
            <button type="button" className="btn btn--ghost" onClick={() => setShowHint(true)} disabled={submitting}>
              <Lightbulb size={16} /> Hint
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => submit(true)} disabled={submitting}>
            I don’t know
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={submitting || busy}
            onClick={async () => {
              if (await confirmAction('End the quiz now? Unanswered questions will count as skipped.')) {
                await onComplete(quiz.id);
                setShowResults(true);
              }
            }}
          >
            End quiz
          </button>
        </div>
      </div>
    </div>
  );
}

function QuizProgress({ quiz, index }: { quiz: Quiz; index: number }) {
  const total = quiz.questions.length;
  const correct = quiz.answers.filter((a) => a.correct).length;
  return (
    <div className="progress">
      <div className="progress__text">
        <strong>{quiz.title}</strong>
        <span className="muted small">
          Question {Math.min(index + 1, total)} of {total} · {correct} correct so far
        </span>
      </div>
      <div className="bar">
        <div className="bar__fill" style={{ width: `${percent(index, total)}%` }} />
      </div>
    </div>
  );
}

export function QuizPanel({
  session,
  stream,
  busy,
  activeQuizId,
  onSelectQuiz,
  onCreate,
  onAnswer,
  onComplete,
  onReview,
  onOpenReview,
  onDelete,
  onToast,
}: Props) {
  const activeQuiz = session.quizzes.find((q) => q.id === activeQuizId) ?? null;
  const hasMaterials = session.materials.some((m) => m.status === 'ready');

  if (stream.kind === 'quiz') {
    return (
      <div className="quiz">
        <div className="card quiz-building">
          <Loader2 size={22} className="spin" />
          <div>
            <strong>{stream.status || 'Designing your quiz…'}</strong>
            <div className="muted small">The agent is reading your materials and writing questions with explanations.</div>
          </div>
        </div>
        {stream.thinking && (
          <details className="thinking">
            <summary>Reasoning</summary>
            <pre>{stream.thinking}</pre>
          </details>
        )}
      </div>
    );
  }

  if (activeQuiz) {
    return (
      <div className="quiz">
        <QuizSession
          quiz={activeQuiz}
          busy={busy}
          onAnswer={onAnswer}
          onComplete={onComplete}
          onReview={onReview}
          onOpenReview={onOpenReview}
          onBack={() => onSelectQuiz(null)}
          onToast={onToast}
        />
      </div>
    );
  }

  return (
    <div className="quiz">
      <QuizSetup onCreate={onCreate} busy={busy} hasMaterials={hasMaterials} />
      <QuizList
        quizzes={session.quizzes}
        busy={busy}
        onOpen={(id) => onSelectQuiz(id)}
        onDelete={(id) => {
          void confirmAction('Delete this quiz and its results?').then((ok) => {
            if (ok) onDelete(id);
          });
        }}
      />
    </div>
  );
}
