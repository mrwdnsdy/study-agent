import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square, Trash2, User, Wrench } from 'lucide-react';
import type { ChatMessage, Session } from '../../shared/types';
import type { StreamState, Toast } from '../state';
import { ChatExportButton } from './ChatExportButton';
import { KiikuBuddy } from './Kiiku';
import { Markdown } from './Markdown';
import { confirmAction } from '../lib/confirm';

interface QuickAction {
  label: string;
  message?: string;
  prefill?: string;
  action?: 'guide';
}

/** Sent by the Continue chip under a reply that was cut off. */
const CONTINUE_MESSAGE = 'Please continue your last answer exactly where it stopped.';

const QUICK_ACTIONS: QuickAction[] = [
  { label: '📘 Generate study guide', action: 'guide' },
  {
    label: '🧠 Quiz me',
    message:
      'Quiz me with 8 mixed-difficulty questions across the whole module, using multiple choice, true/false and short answer questions.',
  },
  { label: '🔍 Explain a slide', prefill: 'Explain slide 1 in depth, with a diagram and a worked example.' },
  {
    label: '📊 Formulas & numbers',
    message: 'List every formula, number, threshold and named rule in the materials in a table, with the slide each one comes from.',
  },
  {
    label: '🎯 Likely exam questions',
    message: 'What are the 10 most likely exam questions on this module? For each, give a model-answer outline and the slides to revise.',
  },
];

interface Props {
  session: Session;
  stream: StreamState;
  busy: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (message: string) => void;
  onStop: () => void;
  onClear: () => void;
  onGenerateGuide: () => void;
  onToast: (toast: Toast) => void;
  agentName: string;
}

function ToolChips({ events }: { events: { summary: string }[] | undefined }) {
  if (!events?.length) return null;
  return (
    <div className="tool-chips">
      {events.map((event, index) => (
        <span key={index} className="tool-chip">
          <Wrench size={12} /> {event.summary}
        </span>
      ))}
    </div>
  );
}

/** Memoised: while a reply streams, the saved messages above it do not re-render (their Markdown is costly). */
const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg msg--${message.role}${message.kind && message.kind !== 'chat' ? ` msg--${message.kind}` : ''}`}>
      <div className="msg__avatar">{isUser ? <User size={16} /> : <KiikuBuddy size={30} />}</div>
      <div className="msg__body">
        {message.thinking && (
          <details className="thinking thinking--compact">
            <summary>Reasoning</summary>
            <pre>{message.thinking}</pre>
          </details>
        )}
        <ToolChips events={message.toolEvents} />
        {isUser ? <p className="msg__text">{message.content}</p> : <Markdown markdown={message.content} />}
      </div>
    </div>
  );
});

export function ChatPanel({ session, stream, busy, draft, onDraftChange, onSend, onStop, onClear, onGenerateGuide, onToast, agentName }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [session.messages, stream.text, stream.status, stream.thinking, stream.toolEvents, stick]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    onSend(message);
    onDraftChange('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const runQuickAction = (action: QuickAction) => {
    if (busy) return;
    if (action.action === 'guide') onGenerateGuide();
    else if (action.message) onSend(action.message);
    else if (action.prefill) {
      onDraftChange(action.prefill);
      inputRef.current?.focus();
    }
  };

  const liveKind = stream.kind;
  const last = session.messages[session.messages.length - 1];
  const cutOff = last?.role === 'assistant' && last.incomplete === true;

  return (
    <div className="chat__inner">
      <div className="chat__header">
        <div>
          <strong>{agentName}</strong>
          <div className="muted small">Ask anything about your materials. It can edit the guide and build quizzes.</div>
        </div>
        <div className="chat__header-actions">
          <ChatExportButton session={session} agentName={agentName} onToast={onToast} />
          <button
            type="button"
            className="icon-btn"
            title="Clear chat"
            disabled={busy || session.messages.length === 0}
            onClick={() => {
              void confirmAction('Clear the chat transcript? The study guide, materials and quizzes are kept.').then((ok) => {
                if (ok) onClear();
              });
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div
        className="chat__messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {session.messages.length === 0 && !liveKind && (
          <div className="chat__empty">
            <KiikuBuddy size={64} />
            <p>
              Hi, I&apos;m {agentName}! I have your materials{session.materials.length ? '' : ' (none uploaded yet)'}. Ask me to explain a slide, build the study guide,
              or quiz you. I give feedback on every answer.
            </p>
          </div>
        )}
        {session.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {cutOff && (
          <div className="msg-continue">
            <button type="button" className="chip" disabled={busy} onClick={() => onSend(CONTINUE_MESSAGE)} title="Let the reply finish">
              Continue
            </button>
          </div>
        )}
        {liveKind && (
          <div className="msg msg--assistant msg--live">
            <div className="msg__avatar">
              <KiikuBuddy size={30} mood="thinking" title="Thinking" />
            </div>
            <div className="msg__body">
              {(stream.status || !stream.text) && (
                <div className="msg__status">
                  {stream.status || 'Thinking…'}
                </div>
              )}
              {stream.thinking && (
                <details className="thinking thinking--compact" open={!stream.text}>
                  <summary>Reasoning</summary>
                  <pre>{stream.thinking}</pre>
                </details>
              )}
              <ToolChips events={stream.toolEvents} />
              {liveKind === 'generate' && <p className="muted small">Writing the study guide — watch it appear in the Study Guide tab.</p>}
              {liveKind === 'quiz' && <p className="muted small">Designing your quiz — it opens in the Quiz tab when ready.</p>}
              {stream.text && <Markdown markdown={stream.text} streaming />}
            </div>
          </div>
        )}
      </div>

      <div className="chat__quick">
        {QUICK_ACTIONS.map((action) => (
          <button key={action.label} type="button" className="chip" disabled={busy} onClick={() => runQuickAction(action)}>
            {action.label}
          </button>
        ))}
      </div>

      <div className="chat__input">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder="Ask about a slide, request changes to the guide, or say “quiz me on chapter 3”…"
          rows={1}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button type="button" className="btn btn--ghost" onClick={onStop} title="Stop">
            <Square size={16} /> Stop
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={send} disabled={!draft.trim()} title="Send (Enter)">
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
