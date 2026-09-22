import type {
  AnswerRequest,
  AnswerResponse,
  GuideQuality,
  Quiz,
  QuizConfig,
  ServerConfigResponse,
  Session,
  SessionSummary,
  StreamEvent,
} from '../../shared/types';
import { getMode } from './mode';
import { streamSse } from './sse';

export type OnEvent = (event: StreamEvent) => void;

/** Everything the UI needs from a backend; implemented by the server (HTTP) and by browser mode (in-page). */
export interface Api {
  config(): Promise<ServerConfigResponse>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(title?: string): Promise<Session>;
  getSession(id: string): Promise<Session>;
  renameSession(id: string, title: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  clearMessages(id: string): Promise<Session>;
  uploadMaterials(id: string, files: File[]): Promise<Session>;
  deleteMaterial(id: string, materialId: string): Promise<Session>;
  generateGuide(id: string, prompt: string, onEvent: OnEvent, signal?: AbortSignal, quality?: GuideQuality): Promise<void>;
  chat(id: string, message: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  createQuiz(id: string, config: QuizConfig, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  answerQuestion(id: string, quizId: string, body: AnswerRequest): Promise<AnswerResponse>;
  completeQuiz(id: string, quizId: string): Promise<Quiz>;
  reviewQuiz(id: string, quizId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void>;
  deleteQuiz(id: string, quizId: string): Promise<Session>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const serverApi: Api = {
  config: () => request<ServerConfigResponse>('/api/config'),

  listSessions: () => request<SessionSummary[]>('/api/sessions'),
  createSession: (title?: string) => request<Session>('/api/sessions', jsonInit('POST', { title })),
  getSession: (id: string) => request<Session>(`/api/sessions/${id}`),
  renameSession: (id: string, title: string) => request<Session>(`/api/sessions/${id}`, jsonInit('PATCH', { title })),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  clearMessages: (id: string) => request<Session>(`/api/sessions/${id}/messages`, { method: 'DELETE' }),

  uploadMaterials: (id: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request<Session>(`/api/sessions/${id}/materials`, { method: 'POST', body: form });
  },
  deleteMaterial: (id: string, materialId: string) =>
    request<Session>(`/api/sessions/${id}/materials/${materialId}`, { method: 'DELETE' }),

  generateGuide: (id, prompt, onEvent, signal, quality) => streamSse(`/api/sessions/${id}/generate`, { prompt, quality }, onEvent, signal),
  chat: (id, message, onEvent, signal) => streamSse(`/api/sessions/${id}/chat`, { message }, onEvent, signal),

  createQuiz: (id, config, onEvent, signal) => streamSse(`/api/sessions/${id}/quizzes`, config, onEvent, signal),
  answerQuestion: (id, quizId, body) =>
    request<AnswerResponse>(`/api/sessions/${id}/quizzes/${quizId}/answers`, jsonInit('POST', body)),
  completeQuiz: (id, quizId) => request<Quiz>(`/api/sessions/${id}/quizzes/${quizId}/complete`, { method: 'POST' }),
  reviewQuiz: (id, quizId, onEvent, signal) => streamSse(`/api/sessions/${id}/quizzes/${quizId}/review`, {}, onEvent, signal),
  deleteQuiz: (id, quizId) => request<Session>(`/api/sessions/${id}/quizzes/${quizId}`, { method: 'DELETE' }),
};

let browserApiPromise: Promise<Api> | null = null;

function implementation(): Promise<Api> {
  if (getMode() === 'browser') {
    browserApiPromise ??= import('../browser/api').then((m) => m.browserApi);
    return browserApiPromise;
  }
  return Promise.resolve(serverApi);
}

/** Delegates each call to the active backend (server HTTP or in-browser). */
export const api: Api = new Proxy({} as Api, {
  get(_target, key: keyof Api) {
    return (...args: unknown[]) => implementation().then((impl) => (impl[key] as (...a: unknown[]) => unknown)(...args));
  },
});
