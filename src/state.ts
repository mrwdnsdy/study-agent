import type {
  ChatMessage,
  Quiz,
  ServerConfigResponse,
  Session,
  SessionSummary,
  StreamEvent,
  ToolEvent,
  UsageInfo,
} from '../shared/types';

export type Tab = 'guide' | 'quiz' | 'review' | 'chat' | 'materials';
export type StreamKind = 'generate' | 'chat' | 'quiz' | 'review';

export interface StreamState {
  kind: StreamKind | null;
  status: string;
  thinking: string;
  text: string;
  guideDraft: string | null;
  guideVersion: number | null;
  toolEvents: ToolEvent[];
}

export interface Toast {
  kind: 'error' | 'success' | 'info';
  message: string;
  link?: { href: string; label: string };
}

export interface AppState {
  config: ServerConfigResponse | null;
  sessions: SessionSummary[];
  session: Session | null;
  sessionLoading: boolean;
  stream: StreamState;
  tab: Tab;
  activeQuizId: string | null;
  toast: Toast | null;
  uploading: boolean;
  lastUsage: UsageInfo | null;
}

export const initialStream: StreamState = {
  kind: null,
  status: '',
  thinking: '',
  text: '',
  guideDraft: null,
  guideVersion: null,
  toolEvents: [],
};

export const initialState: AppState = {
  config: null,
  sessions: [],
  session: null,
  sessionLoading: false,
  stream: initialStream,
  tab: 'guide',
  activeQuizId: null,
  toast: null,
  uploading: false,
  lastUsage: null,
};

export type Action =
  | { type: 'config'; config: ServerConfigResponse }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'session/loading' }
  | { type: 'session/set'; session: Session | null }
  | { type: 'session/patch'; session: Session }
  | { type: 'quiz/patch'; quiz: Quiz }
  | { type: 'tab'; tab: Tab }
  | { type: 'quiz/select'; quizId: string | null }
  | { type: 'toast'; toast: Toast | null }
  | { type: 'uploading'; uploading: boolean }
  | { type: 'message/add'; message: ChatMessage }
  | { type: 'stream/start'; kind: StreamKind }
  | { type: 'stream/deltas'; text: string; thinking: string; guide: string }
  | { type: 'stream/event'; event: StreamEvent }
  | { type: 'stream/end' };

function upsertQuiz(quizzes: Quiz[], quiz: Quiz): Quiz[] {
  const index = quizzes.findIndex((q) => q.id === quiz.id);
  if (index === -1) return [...quizzes, quiz];
  return quizzes.map((q) => (q.id === quiz.id ? quiz : q));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'config':
      return { ...state, config: action.config };
    case 'sessions':
      return { ...state, sessions: action.sessions };
    case 'session/loading':
      return { ...state, sessionLoading: true };
    case 'session/set':
      return {
        ...state,
        session: action.session,
        sessionLoading: false,
        activeQuizId:
          action.session && state.session?.id === action.session.id
            ? state.activeQuizId
            : (action.session?.quizzes.find((q) => q.status === 'in_progress')?.id ?? null),
        tab: action.session && state.session?.id === action.session.id ? state.tab : 'guide',
      };
    case 'session/patch':
      if (!state.session || state.session.id !== action.session.id) return state;
      return { ...state, session: action.session };
    case 'quiz/patch':
      if (!state.session) return state;
      return { ...state, session: { ...state.session, quizzes: upsertQuiz(state.session.quizzes, action.quiz) } };
    case 'tab':
      return { ...state, tab: action.tab };
    case 'quiz/select':
      return { ...state, activeQuizId: action.quizId };
    case 'toast':
      return { ...state, toast: action.toast };
    case 'uploading':
      return { ...state, uploading: action.uploading };
    case 'message/add':
      if (!state.session) return state;
      if (state.session.messages.some((m) => m.id === action.message.id)) return state;
      return { ...state, session: { ...state.session, messages: [...state.session.messages, action.message] } };
    case 'stream/start':
      return { ...state, stream: { ...initialStream, kind: action.kind }, toast: null };
    case 'stream/deltas': {
      const stream = state.stream;
      const guideDraft =
        action.guide.length === 0 ? stream.guideDraft : (stream.guideDraft ?? '') + action.guide;
      return {
        ...state,
        stream: {
          ...stream,
          text: stream.text + action.text,
          thinking: stream.thinking + action.thinking,
          guideDraft,
        },
      };
    }
    case 'stream/event':
      return applyEvent(state, action.event);
    case 'stream/end':
      return { ...state, stream: initialStream };
    default:
      return state;
  }
}

function applyEvent(state: AppState, event: StreamEvent): AppState {
  const { stream, session } = state;
  switch (event.type) {
    case 'status':
      return { ...state, stream: { ...stream, status: event.text } };
    case 'guide_start':
      return {
        ...state,
        tab: state.tab === 'chat' || state.tab === 'materials' ? state.tab : 'guide',
        stream: { ...stream, guideDraft: '', guideVersion: event.version, status: 'Writing your study guide…' },
      };
    case 'draft':
      // The saved draft a continuation starts from, or the draft cut back to a safe point before a resume.
      return event.target === 'guide'
        ? { ...state, stream: { ...stream, guideDraft: event.text } }
        : { ...state, stream: { ...stream, text: event.text } };
    case 'guide':
      return {
        ...state,
        session: session ? { ...session, guide: event.guide } : session,
        stream: { ...stream, guideDraft: null, status: '' },
      };
    case 'tool':
      return { ...state, stream: { ...stream, toolEvents: [...stream.toolEvents, { name: event.name, summary: event.summary }] } };
    case 'quiz':
      return {
        ...state,
        session: session ? { ...session, quizzes: upsertQuiz(session.quizzes, event.quiz) } : session,
        activeQuizId: event.quiz.id,
        tab: 'quiz',
      };
    case 'review':
      return {
        ...state,
        session: session ? { ...session, quizzes: upsertQuiz(session.quizzes, event.quiz) } : session,
        activeQuizId: event.quiz.id,
        tab: 'review',
      };
    case 'message':
      if (!session || session.messages.some((m) => m.id === event.message.id)) return state;
      return { ...state, session: { ...session, messages: [...session.messages, event.message] } };
    case 'usage':
      return { ...state, lastUsage: event.usage };
    default:
      return state;
  }
}

/** Per-topic score summary for a quiz. */
export interface TopicScore {
  topic: string;
  total: number;
  correct: number;
}

export function topicScores(quiz: Quiz): TopicScore[] {
  const map = new Map<string, TopicScore>();
  for (const question of quiz.questions) {
    const answer = quiz.answers.find((a) => a.questionId === question.id);
    if (!answer) continue;
    const entry = map.get(question.topic) ?? { topic: question.topic, total: 0, correct: 0 };
    entry.total += 1;
    if (answer.correct) entry.correct += 1;
    map.set(question.topic, entry);
  }
  return [...map.values()].sort((a, b) => a.correct / a.total - b.correct / b.total);
}

export function weakTopics(quiz: Quiz): string[] {
  return topicScores(quiz)
    .filter((t) => t.correct / t.total < 0.7)
    .map((t) => t.topic);
}
