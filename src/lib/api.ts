import type {
  AnswerRequest,
  AnswerResponse,
  Quiz,
  QuizConfig,
  ServerConfigResponse,
  Session,
  SessionSummary,
  StreamEvent,
} from '../../shared/types';
import { streamSse } from './sse';

type OnEvent = (event: StreamEvent) => void;

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

export const api = {
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

  generateGuide: (id: string, prompt: string, onEvent: OnEvent, signal?: AbortSignal) =>
    streamSse(`/api/sessions/${id}/generate`, { prompt }, onEvent, signal),
  chat: (id: string, message: string, onEvent: OnEvent, signal?: AbortSignal) =>
    streamSse(`/api/sessions/${id}/chat`, { message }, onEvent, signal),

  createQuiz: (id: string, config: QuizConfig, onEvent: OnEvent, signal?: AbortSignal) =>
    streamSse(`/api/sessions/${id}/quizzes`, config, onEvent, signal),
  answerQuestion: (id: string, quizId: string, body: AnswerRequest) =>
    request<AnswerResponse>(`/api/sessions/${id}/quizzes/${quizId}/answers`, jsonInit('POST', body)),
  completeQuiz: (id: string, quizId: string) =>
    request<Quiz>(`/api/sessions/${id}/quizzes/${quizId}/complete`, { method: 'POST' }),
  reviewQuiz: (id: string, quizId: string, onEvent: OnEvent, signal?: AbortSignal) =>
    streamSse(`/api/sessions/${id}/quizzes/${quizId}/review`, {}, onEvent, signal),
  deleteQuiz: (id: string, quizId: string) => request<Session>(`/api/sessions/${id}/quizzes/${quizId}`, { method: 'DELETE' }),
};
