import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Sparkles, Target } from 'lucide-react';
import type { Quiz, Session } from '../../shared/types';
import { percent } from '../lib/format';
import { topicScores, weakTopics, type StreamState, type Toast } from '../state';
import { ExportMenu } from './ExportMenu';
import { IncompleteBanner } from './IncompleteBanner';
import { KiikuBuddy } from './Kiiku';
import { Markdown } from './Markdown';

interface Props {
  session: Session;
  stream: StreamState;
  busy: boolean;
  agentName: string;
  activeQuizId: string | null;
  onSelectQuiz: (quizId: string) => void;
  onReview: (quizId: string) => void;
  /** Finishes a review that stopped partway (quiz.reviewIncomplete). */
  onContinueReview: (quizId: string) => void;
  onQuizWeakAreas: (focus: string) => void;
  onAskChat: (prefill: string) => void;
  onToast: (toast: Toast) => void;
}

function scoreLine(quiz: Quiz): string {
  const correct = quiz.answers.filter((a) => a.correct).length;
  return `${correct}/${quiz.answers.length} correct (${percent(correct, quiz.answers.length)}%)`;
}

export function ReviewPanel({ session, stream, busy, agentName, activeQuizId, onSelectQuiz, onReview, onContinueReview, onQuizWeakAreas, onAskChat, onToast }: Props) {
  const completed = useMemo(
    () => session.quizzes.filter((q) => q.answers.length > 0).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [session.quizzes],
  );
  // The app's active quiz wins when it is finished or already reviewed; otherwise prefer a reviewed quiz.
  const preferred = useMemo(() => {
    const active = completed.find((q) => q.id === activeQuizId);
    if (active && (active.review || active.status === 'completed')) return active;
    return completed.find((q) => q.review) ?? completed.find((q) => q.status === 'completed') ?? active ?? completed[0] ?? null;
  }, [completed, activeQuizId]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  useEffect(() => setPickedId(null), [activeQuizId]);
  const selected = completed.find((q) => q.id === pickedId) ?? preferred;

  if (completed.length === 0 && stream.kind !== 'review') {
    return (
      <div className="review review--empty">
        <div className="hero hero--compact">
          <div className="hero__icon">
            <KiikuBuddy size={44} />
          </div>
          <h2>No review yet</h2>
          <p className="muted">
            Complete a quiz and {agentName} writes a post-quiz review session: a scorecard by topic, a question-by-question breakdown of what went
            wrong and why, the misconceptions behind the mistakes, and a targeted revision plan.
          </p>
        </div>
      </div>
    );
  }

  const streaming = stream.kind === 'review';
  const weak = selected ? weakTopics(selected) : [];
  const scores = selected ? topicScores(selected) : [];

  return (
    <div className="review">
      <div className="review__toolbar">
        <div className="review__pick">
          <label htmlFor="review-quiz">Quiz</label>
          <select id="review-quiz" value={selected?.id ?? ''} onChange={(e) => setPickedId(e.target.value)} disabled={streaming}>
            {completed.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title} — {scoreLine(q)}
              </option>
            ))}
          </select>
        </div>
        {selected?.review && !streaming && (
          <div className="review__actions">
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onQuizWeakAreas(weak.length ? `Focus on my weak topics: ${weak.join(', ')}` : 'Focus on the questions I got wrong last time and closely related ideas')}>
              <Target size={16} /> Quiz me on weak areas
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => onAskChat(`Let's go through the questions I got wrong in the quiz "${selected.title}" one at a time. Start with the first one and check my understanding before moving on.`)}
            >
              <MessageSquare size={16} /> Discuss in chat
            </button>
            <ExportMenu markdown={selected.review} title={`Post-quiz review — ${selected.title}`} subtitle={session.title} onToast={onToast} />
          </div>
        )}
      </div>

      {selected?.reviewIncomplete && selected.review && !streaming && (
        <IncompleteBanner agentName={agentName} busy={busy} onContinue={() => onContinueReview(selected.id)} onRegenerate={() => onReview(selected.id)} />
      )}

      {streaming ? (
        <div className="card review__doc">
          <div className="msg__status">
            <KiikuBuddy size={20} mood="thinking" /> {stream.status || 'Reviewing your answers…'}
          </div>
          {stream.thinking && !stream.text && (
            <details className="thinking thinking--compact" open>
              <summary>Reasoning</summary>
              <pre>{stream.thinking}</pre>
            </details>
          )}
          <Markdown markdown={stream.text} streaming />
        </div>
      ) : selected?.review ? (
        <div className="card review__doc">
          <Markdown markdown={selected.review} />
        </div>
      ) : selected ? (
        <div className="card review__cta">
          <h2>{selected.title}</h2>
          <p className="muted">{scoreLine(selected)}</p>
          {scores.length > 0 && (
            <ul className="topic-pills">
              {scores.map((t) => (
                <li key={t.topic} className={`pill ${t.correct / t.total >= 0.7 ? 'pill--good' : 'pill--bad'}`}>
                  {t.topic} {t.correct}/{t.total}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn--primary btn--lg" disabled={busy} onClick={() => onReview(selected.id)}>
            <Sparkles size={18} /> Generate my review session
          </button>
        </div>
      ) : null}
    </div>
  );
}
