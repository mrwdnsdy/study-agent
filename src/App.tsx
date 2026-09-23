import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, ClipboardList, FolderOpen, GraduationCap, MessageSquare, Settings, X } from 'lucide-react';
import { DEFAULT_GUIDE_PROMPT, type AnswerRequest, type ChatMessage, type GuideQuality, type QuizConfig, type StreamEvent } from '../shared/types';
import { api } from './lib/api';
import { DEFAULT_AGENT_NAME } from '../shared/agent/constants';
import { getMode } from './lib/mode';
import { ChatPanel } from './components/ChatPanel';
import { GuideView } from './components/GuideView';
import { KiikuMark } from './components/Kiiku';
import { QuizPanel } from './components/QuizPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { initialState, reducer, type StreamKind, type Tab, type Toast } from './state';

type StreamStarter = (onEvent: (event: StreamEvent) => void, signal: AbortSignal) => Promise<void>;

const TABS: { id: Tab; label: string; icon: typeof BookOpen; mobileOnly?: boolean }[] = [
  { id: 'materials', label: 'Materials', icon: FolderOpen, mobileOnly: true },
  { id: 'guide', label: 'Guide', icon: BookOpen },
  { id: 'quiz', label: 'Quiz', icon: GraduationCap },
  { id: 'review', label: 'Review', icon: ClipboardList },
  { id: 'chat', label: 'Chat', icon: MessageSquare, mobileOnly: true },
];

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Resolved before the first render (main.tsx awaits detectMode()).
  const browserMode = getMode() === 'browser';
  const streamRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = state.session?.id ?? null;

  const busy = state.stream.kind !== null;

  const toast = useCallback((t: Toast | null) => dispatch({ type: 'toast', toast: t }), []);
  const fail = useCallback((err: unknown) => toast({ kind: 'error', message: (err as Error).message || String(err) }), [toast]);

  const refreshSessions = useCallback(async () => {
    const sessions = await api.listSessions();
    dispatch({ type: 'sessions', sessions });
    return sessions;
  }, []);

  const openSession = useCallback(async (id: string) => {
    dispatch({ type: 'session/loading' });
    try {
      const session = await api.getSession(id);
      dispatch({ type: 'session/set', session });
    } catch (err) {
      dispatch({ type: 'session/set', session: null });
      fail(err);
    }
  }, [fail]);

  const syncSession = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const session = await api.getSession(id);
      if (sessionIdRef.current === id) dispatch({ type: 'session/set', session });
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  }, [fail, refreshSessions]);

  const loadConfig = useCallback(() => api.config().then((config) => dispatch({ type: 'config', config })).catch(() => undefined), []);

  useEffect(() => {
    void loadConfig();
    (async () => {
      try {
        const sessions = await refreshSessions();
        if (sessions.length > 0) await openSession(sessions[0].id);
        else {
          const session = await api.createSession();
          await refreshSessions();
          dispatch({ type: 'session/set', session });
        }
      } catch (err) {
        fail(err);
      }
    })();
  }, [fail, loadConfig, openSession, refreshSessions]);

  useEffect(() => {
    if (!state.toast || state.toast.link) return;
    const timer = window.setTimeout(() => toast(null), state.toast.kind === 'error' ? 12_000 : 7_000);
    return () => window.clearTimeout(timer);
  }, [state.toast, toast]);

  const runStream = useCallback(
    async (kind: StreamKind, start: StreamStarter) => {
      if (streamRef.current) return;
      const controller = new AbortController();
      streamRef.current = controller;
      dispatch({ type: 'stream/start', kind });

      const buffer = { text: '', thinking: '', guide: '' };
      let timer: number | null = null;
      const flush = () => {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        if (buffer.text || buffer.thinking || buffer.guide) {
          dispatch({ type: 'stream/deltas', text: buffer.text, thinking: buffer.thinking, guide: buffer.guide });
          buffer.text = '';
          buffer.thinking = '';
          buffer.guide = '';
        }
      };
      const schedule = () => {
        if (timer === null) timer = window.setTimeout(flush, 100);
      };
      const onEvent = (event: StreamEvent) => {
        switch (event.type) {
          case 'text':
            buffer.text += event.text;
            schedule();
            break;
          case 'thinking':
            buffer.thinking += event.text;
            schedule();
            break;
          case 'guide_delta':
            buffer.guide += event.text;
            schedule();
            break;
          default:
            flush();
            dispatch({ type: 'stream/event', event });
        }
      };

      try {
        await start(onEvent, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) fail(err);
      } finally {
        flush();
        dispatch({ type: 'stream/end' });
        streamRef.current = null;
        await syncSession();
      }
    },
    [fail, syncSession],
  );

  const stopStream = () => streamRef.current?.abort();

  const requireSessionId = (): string | null => {
    if (!state.session) {
      toast({ kind: 'error', message: 'Create or select a session first.' });
      return null;
    }
    return state.session.id;
  };

  const generateGuide = (prompt: string, quality: GuideQuality = 'standard') => {
    const id = requireSessionId();
    if (!id) return;
    dispatch({ type: 'tab', tab: 'guide' });
    void runStream('generate', (onEvent, signal) => api.generateGuide(id, prompt, onEvent, signal, quality));
  };

  const sendChat = (message: string) => {
    const id = requireSessionId();
    if (!id) return;
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: message, createdAt: new Date().toISOString(), kind: 'chat' };
    dispatch({ type: 'message/add', message: optimistic });
    void runStream('chat', (onEvent, signal) => api.chat(id, message, onEvent, signal));
  };

  const createQuiz = (config: QuizConfig) => {
    const id = requireSessionId();
    if (!id) return;
    dispatch({ type: 'tab', tab: 'quiz' });
    void runStream('quiz', (onEvent, signal) => api.createQuiz(id, config, onEvent, signal));
  };

  const reviewQuiz = (quizId: string) => {
    const id = requireSessionId();
    if (!id) return;
    dispatch({ type: 'quiz/select', quizId });
    dispatch({ type: 'tab', tab: 'review' });
    void runStream('review', (onEvent, signal) => api.reviewQuiz(id, quizId, onEvent, signal));
  };

  const answerQuestion = async (quizId: string, body: AnswerRequest) => {
    const id = state.session!.id;
    const result = await api.answerQuestion(id, quizId, body);
    dispatch({ type: 'quiz/patch', quiz: result.quiz });
    return result;
  };

  const completeQuiz = async (quizId: string) => {
    const id = state.session!.id;
    try {
      const quiz = await api.completeQuiz(id, quizId);
      dispatch({ type: 'quiz/patch', quiz });
    } catch (err) {
      fail(err);
    }
  };

  const deleteQuiz = async (quizId: string) => {
    const id = state.session!.id;
    try {
      const session = await api.deleteQuiz(id, quizId);
      dispatch({ type: 'session/patch', session });
      if (state.activeQuizId === quizId) dispatch({ type: 'quiz/select', quizId: null });
    } catch (err) {
      fail(err);
    }
  };

  const upload = async (files: File[]) => {
    const id = requireSessionId();
    if (!id) return;
    dispatch({ type: 'uploading', uploading: true });
    try {
      const session = await api.uploadMaterials(id, files);
      dispatch({ type: 'session/patch', session });
      const failed = session.materials.filter((m) => m.status === 'error' && files.some((f) => f.name === m.name));
      if (failed.length) toast({ kind: 'error', message: `${failed.length} file(s) could not be processed: ${failed.map((m) => `${m.name} (${m.error})`).join('; ')}` });
      else toast({ kind: 'success', message: `${files.length} file${files.length === 1 ? '' : 's'} ready. Generate the study guide or ask a question.` });
      await refreshSessions();
    } catch (err) {
      fail(err);
    } finally {
      dispatch({ type: 'uploading', uploading: false });
    }
  };

  const deleteMaterial = async (materialId: string) => {
    const id = requireSessionId();
    if (!id) return;
    try {
      const session = await api.deleteMaterial(id, materialId);
      dispatch({ type: 'session/patch', session });
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  };

  const createSession = async () => {
    try {
      const session = await api.createSession();
      await refreshSessions();
      dispatch({ type: 'session/set', session });
      dispatch({ type: 'tab', tab: window.innerWidth < 1000 ? 'materials' : 'guide' });
    } catch (err) {
      fail(err);
    }
  };

  const renameSession = async (id: string, title: string) => {
    try {
      const session = await api.renameSession(id, title);
      dispatch({ type: 'session/patch', session });
      await refreshSessions();
    } catch (err) {
      fail(err);
    }
  };

  const deleteSession = async (id: string) => {
    try {
      await api.deleteSession(id);
      const sessions = await refreshSessions();
      if (state.session?.id === id) {
        if (sessions.length > 0) await openSession(sessions[0].id);
        else {
          const session = await api.createSession();
          await refreshSessions();
          dispatch({ type: 'session/set', session });
        }
      }
    } catch (err) {
      fail(err);
    }
  };

  const clearChat = async () => {
    const id = requireSessionId();
    if (!id) return;
    try {
      const session = await api.clearMessages(id);
      dispatch({ type: 'session/patch', session });
    } catch (err) {
      fail(err);
    }
  };

  const askInChat = (prefill: string) => {
    setDraft(prefill);
    if (window.innerWidth < 1000) dispatch({ type: 'tab', tab: 'chat' });
  };

  const { session, stream, tab, config } = state;
  const agentName = config?.agentName ?? DEFAULT_AGENT_NAME;

  return (
    <div className="app">
      {config && !config.hasApiKey && (
        <div className="banner banner--warn">
          <AlertTriangle size={16} />
          {config.showModels === false ? (
            <span>Model access is not configured on this site yet.</span>
          ) : browserMode ? (
            <span>
              Add your Anthropic API key to start. It stays in this browser and is only ever sent to Claude.{' '}
              <button type="button" className="banner__link" onClick={() => setSettingsOpen(true)}>
                Open settings
              </button>
            </span>
          ) : (
            <span>
              The server has no <code>ANTHROPIC_API_KEY</code>. Add it to <code>.env</code> and restart, otherwise Claude features will fail.
            </span>
          )}
        </div>
      )}
      <header className="topbar">
        <div className="brand">
          <KiikuMark size={28} className="brand__mark" />
          <span className="brand__text">
            <span className="brand__name">{agentName}</span>
            <span className="brand__eyebrow">Study Buddy</span>
          </span>
        </div>
        <div className="topbar__title" title={session?.title}>
          {session?.title ?? (state.sessionLoading ? 'Loading…' : '')}
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              data-tab={t.id}
              className={`tab${tab === t.id ? ' is-active' : ''}${t.mobileOnly ? ' tab--mobile' : ''}`}
              onClick={() => dispatch({ type: 'tab', tab: t.id })}
            >
              <t.icon size={16} /> <span>{t.label}</span>
              {t.id === 'guide' && stream.guideDraft !== null && <span className="tab__dot" />}
            </button>
          ))}
        </nav>
        <div className="topbar__meta">
          {config && config.showModels !== false && (
            <span
              className="pill pill--muted"
              title={`Study guide: ${config.models.guide.join(' → ')} · chat, quizzes, grading, reviews: ${config.models.chat.join(' → ')}`}
            >
              {config.model}
            </span>
          )}
          {state.lastUsage && (
            <span className="pill pill--muted" title="Tokens used by the last request (input / output / cache reads)">
              {state.lastUsage.inputTokens.toLocaleString()} in · {state.lastUsage.outputTokens.toLocaleString()} out ·{' '}
              {state.lastUsage.cacheReadTokens.toLocaleString()} cached
            </span>
          )}
        </div>
        {browserMode && (
          <button
            type="button"
            className={`icon-btn topbar__settings${config && !config.hasApiKey ? ' is-attention' : ''}`}
            title="Settings (API key, model)"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={18} />
          </button>
        )}
      </header>

      <div className={`layout layout--${tab}`}>
        <aside className="sidebar">
          <Sidebar
            sessions={state.sessions}
            session={session}
            config={config}
            uploading={state.uploading}
            busy={busy}
            onOpenSession={(id) => {
              if (busy) stopStream();
              void openSession(id);
            }}
            onCreateSession={createSession}
            onRenameSession={renameSession}
            onDeleteSession={deleteSession}
            onUpload={upload}
            onDeleteMaterial={deleteMaterial}
          />
        </aside>

        <main className="main">
          {session ? (
            <>
              {tab === 'guide' && (
                <GuideView
                  session={session}
                  stream={stream}
                  busy={busy}
                  models={config?.models ?? null}
                  escalationModel={config?.escalationModel}
                  showModels={config?.showModels !== false}
                  agentName={agentName}
                  onGenerate={generateGuide}
                  onStop={stopStream}
                  onToast={toast}
                />
              )}
              {tab === 'quiz' && (
                <QuizPanel
                  session={session}
                  stream={stream}
                  busy={busy}
                  agentName={agentName}
                  activeQuizId={state.activeQuizId}
                  onSelectQuiz={(quizId) => dispatch({ type: 'quiz/select', quizId })}
                  onCreate={createQuiz}
                  onAnswer={answerQuestion}
                  onComplete={completeQuiz}
                  onReview={reviewQuiz}
                  onOpenReview={(quizId) => {
                    dispatch({ type: 'quiz/select', quizId });
                    dispatch({ type: 'tab', tab: 'review' });
                  }}
                  onDelete={deleteQuiz}
                  onToast={toast}
                />
              )}
              {tab === 'review' && (
                <ReviewPanel
                  session={session}
                  stream={stream}
                  busy={busy}
                  agentName={agentName}
                  activeQuizId={state.activeQuizId}
                  onSelectQuiz={(quizId) => dispatch({ type: 'quiz/select', quizId })}
                  onReview={reviewQuiz}
                  onQuizWeakAreas={(focus) => createQuiz({ numQuestions: 8, difficulty: 'mixed', types: ['multiple_choice', 'true_false', 'short_answer'], focus })}
                  onAskChat={askInChat}
                  onToast={toast}
                />
              )}
              {(tab === 'materials' || tab === 'chat') && <div className="main__placeholder muted">Use the panel on this screen.</div>}
            </>
          ) : (
            <div className="main__placeholder muted">{state.sessionLoading ? 'Loading session…' : 'Create a session to get started.'}</div>
          )}
        </main>

        <aside className="chat">
          {session && (
            <ChatPanel
              session={session}
              stream={stream}
              busy={busy}
              draft={draft}
              onDraftChange={setDraft}
              onSend={sendChat}
              onStop={stopStream}
              onClear={clearChat}
              onGenerateGuide={() => generateGuide(session.guide ? (session.guide.prompt.split('\n\nRevision instructions:')[0] ?? DEFAULT_GUIDE_PROMPT) : DEFAULT_GUIDE_PROMPT)}
              agentName={agentName}
            />
          )}
        </aside>
      </div>

      {browserMode && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            void loadConfig();
            toast({ kind: 'success', message: 'Settings saved in this browser.' });
          }}
        />
      )}

      {state.toast && (
        <div className={`toast toast--${state.toast.kind}`} role="status">
          <span>{state.toast.message}</span>
          {state.toast.link && (
            <a href={state.toast.link.href} target="_blank" rel="noreferrer">
              {state.toast.link.label}
            </a>
          )}
          <button type="button" className="icon-btn" onClick={() => toast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
