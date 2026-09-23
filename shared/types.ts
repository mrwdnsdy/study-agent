/**
 * Shared API contract between the server (server/) and the client (src/).
 * Keep this file free of runtime dependencies so both sides can import it.
 */

export type MaterialKind = 'pdf' | 'pptx' | 'docx' | 'image' | 'text';

/** The kinds of model call the agent makes; each can run on its own model chain. */
export type AgentTask = 'guide' | 'chat' | 'quiz' | 'grading' | 'review';
/**
 * Per task, an ordered fallback chain of model references such as
 * "claude-opus-5", "gemini/gemini-3.8-flash", "openrouter/qwen/qwen3.8-27b:free",
 * "zai/glm-4.7-flash" or "cf/@cf/google/gemma-4-26b-a4b-it". The first model that
 * answers wins; the next is tried when one fails before producing output.
 */
export type TaskModels = Record<AgentTask, string[]>;
/**
 * Model providers the agent can talk to. "artifact" is Claude reached through the
 * claude.ai artifact runtime (the viewer's own account) when the app runs as an artifact.
 */
export type ProviderId = 'anthropic' | 'gemini' | 'openrouter' | 'zai' | 'workers-ai' | 'artifact';
/** A selectable set of models, e.g. "free" (Gemini first) or "claude" (premium). */
export interface LaneInfo {
  id: string;
  label: string;
  /** Display name of the model that writes study guides in this lane. */
  primary: string;
  /** Display name of the escalation model, when the lane has one. */
  escalation?: string;
}
/** "max" writes the study guide with the escalation model (Claude Fable): best quality, about twice the cost. */
export type GuideQuality = 'standard' | 'max';

export interface MaterialMeta {
  id: string;
  /** Original filename as uploaded. */
  name: string;
  kind: MaterialKind;
  sizeBytes: number;
  uploadedAt: string;
  status: 'ready' | 'error';
  error?: string;
  /** Short human summary, e.g. "42 slides · 12 images" or "18 pages". */
  summary: string;
  pages?: number;
  imageCount?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  materialCount: number;
  hasGuide: boolean;
  quizCount: number;
}

export type ChatRole = 'user' | 'assistant';

export interface ToolEvent {
  name: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Markdown. For kind 'guide' this is a short note; the guide itself lives in Session.guide. */
  content: string;
  createdAt: string;
  kind?: 'chat' | 'guide' | 'quiz-review' | 'note';
  /** Summarized model reasoning (assistant messages only). */
  thinking?: string;
  toolEvents?: ToolEvent[];
}

export interface StudyGuide {
  markdown: string;
  version: number;
  updatedAt: string;
  /** The user instructions that produced this guide (kept for regeneration). */
  prompt: string;
  /** Model that wrote this version. */
  model?: string;
}

export type QuestionType = 'multiple_choice' | 'true_false' | 'short_answer';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'mixed';

export interface QuizQuestion {
  id: string;
  type: QuestionType;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  /** Markdown. */
  question: string;
  /** Multiple choice: 3-5 options. True/false: exactly ['True', 'False']. */
  options?: string[];
  correctOptionIndex?: number;
  /** Reference answer (short answer) or the correct option restated. */
  modelAnswer: string;
  /** Why the answer is right and the distractors are wrong. Markdown. */
  explanation: string;
  /** Where in the materials this comes from, e.g. "Slide 12" or "Lecture 3, p.4". */
  sourceRef?: string;
  hint?: string;
}

export interface QuizAnswer {
  questionId: string;
  answer: string;
  selectedOptionIndex?: number;
  correct: boolean;
  /** 0-100. */
  score: number;
  /** Immediate feedback shown after answering. Markdown. */
  feedback: string;
  answeredAt: string;
}

export interface QuizConfig {
  /** 3-25 */
  numQuestions: number;
  difficulty: Difficulty;
  types: QuestionType[];
  /** Optional topic focus or instructions, e.g. "slides 10-20" or "weak areas from last quiz". */
  focus?: string;
}

export interface Quiz {
  id: string;
  title: string;
  createdAt: string;
  config: QuizConfig;
  questions: QuizQuestion[];
  answers: QuizAnswer[];
  status: 'in_progress' | 'completed';
  completedAt?: string;
  /** Post-quiz review. Markdown. */
  review?: string;
  reviewGeneratedAt?: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  materials: MaterialMeta[];
  guide: StudyGuide | null;
  messages: ChatMessage[];
  quizzes: Quiz[];
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Server-sent events streamed by /generate, /chat and /quiz/:id/review. */
export type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'guide_start'; version: number }
  | { type: 'guide_delta'; text: string }
  | { type: 'guide'; guide: StudyGuide }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'quiz'; quiz: Quiz }
  | { type: 'message'; message: ChatMessage }
  | { type: 'review'; quiz: Quiz }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface GenerateRequest {
  prompt: string;
  quality?: GuideQuality;
}

export interface ChatRequest {
  message: string;
}

export interface CreateQuizRequest extends QuizConfig {}

export interface AnswerRequest {
  questionId: string;
  answer: string;
  selectedOptionIndex?: number;
}

export interface AnswerResponse {
  answer: QuizAnswer;
  quiz: Quiz;
}

export interface ServerConfigResponse {
  /** Persona name of the study agent. */
  agentName: string;
  /** Display name of the model that writes the study guide (shown in the header). */
  model: string;
  /** Model chain per task. */
  models: TaskModels;
  /** Model tried when a task's model declines, and used for maximum-quality guides. */
  escalationModel?: string;
  /** Active lane and the lanes the visitor can switch between (browser mode). */
  lane?: string;
  lanes?: LaneInfo[];
  /** Which providers have credentials (from the proxy or the server environment). */
  providers?: Partial<Record<ProviderId, boolean>>;
  hasApiKey: boolean;
  /** False on white-label deployments: the UI never names the providers or models in use. */
  showModels: boolean;
  /** Link to the artifact version of the app (runs on the visitor's own account), shown in the footer and Settings. */
  artifactUrl?: string;
  artifactLabel?: string;
  sofficeAvailable: boolean;
  maxUploadMb: number;
}

export const DEFAULT_GUIDE_PROMPT =
  'Please create a highly technical study guide that goes through each slide and section of my materials in order, ' +
  'explaining every concept in depth, with best practices, gold-standard tips, common pitfalls and exam alerts. ' +
  'I am a visual learner, so include colourful, easy-to-understand diagrams, summary tables, a glossary and self-check questions. ' +
  'Please do not miss anything. I need to ace this module.';

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Multiple choice',
  true_false: 'True / false',
  short_answer: 'Short answer',
};
