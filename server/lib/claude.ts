import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';
import type {
  ChatMessage,
  Quiz,
  QuizConfig,
  QuizQuestion,
  QuestionType,
  StreamEvent,
  StudyGuide,
  ToolEvent,
  UsageInfo,
} from '../../shared/types.js';
import type { ExtractedMaterial, MaterialPart } from './extract.js';
import {
  GRADER_SYSTEM,
  MATERIALS_ACK,
  SYSTEM_PROMPT,
  gradePrompt,
  guideInstruction,
  materialsPreamble,
  quizInstruction,
  reviewInstruction,
} from './prompts.js';
import { wordCount } from './guideEdits.js';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let cachedClient: Anthropic | null = null;

/** Lazily construct the client so the server can start (and explain itself) without a key. */
export function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  try {
    // Timeout is in milliseconds for the TypeScript SDK; long guides stream for many minutes.
    cachedClient = new Anthropic({ timeout: 30 * 60 * 1000, maxRetries: 2 });
  } catch (err) {
    throw Object.assign(
      new Error(`The Claude client could not be created: ${(err as Error).message}. Set ANTHROPIC_API_KEY in .env and restart.`),
      { status: 503 },
    );
  }
  return cachedClient;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check ANTHROPIC_API_KEY in .env and restart the server.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Claude denied the request: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting requests right now. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'The request to Claude timed out. Please try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check the network connection and try again.';
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  if (err instanceof Error && /Could not resolve authentication method/i.test(err.message)) {
    return 'No Claude credentials are configured on the server. Add ANTHROPIC_API_KEY to .env and restart.';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Tools (kept byte-identical across calls so the cached prefix is reused)
// ---------------------------------------------------------------------------

const UPDATE_GUIDE_TOOL: Anthropic.Tool = {
  name: 'update_study_guide',
  description:
    "Edit the student's study guide document in place. Use replace_section to rewrite one existing section (identified by its heading text), insert_after_section to add a new section right after an existing one, append to add content at the end, and replace_all only when you are supplying the complete new document. Write complete, polished Markdown following the formatting rules; the student sees the document, not this call.",
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['replace_section', 'insert_after_section', 'append', 'replace_all'],
        description: 'The kind of edit to apply.',
      },
      heading: {
        type: 'string',
        description:
          'Exact text of the existing section heading to target (without the # marks). Use an empty string for append and replace_all.',
      },
      markdown: {
        type: 'string',
        description:
          'The complete Markdown content. For replace_section start with the heading line; for insert_after_section include the new heading.',
      },
      summary: {
        type: 'string',
        description: 'One sentence describing the change, shown to the student.',
      },
    },
    required: ['operation', 'heading', 'markdown', 'summary'],
    additionalProperties: false,
  },
};

const REGENERATE_GUIDE_TOOL: Anthropic.Tool = {
  name: 'regenerate_study_guide',
  description:
    'Ask the app to rewrite the whole study guide from the materials with revised instructions (different depth, focus, structure or style). The app streams the new document to the student. Use this instead of update_study_guide when most of the document needs to change.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description: 'Precise revision instructions that will be combined with the original request, e.g. "Go deeper on slides 10-20, add a worked example per slide, use more comparison tables".',
      },
      summary: { type: 'string', description: 'One sentence describing the change, shown to the student.' },
    },
    required: ['instructions', 'summary'],
    additionalProperties: false,
  },
};

const CREATE_QUIZ_TOOL: Anthropic.Tool = {
  name: 'create_quiz',
  description:
    'Create an interactive quiz that the student takes inside the app, one question at a time with immediate feedback. Questions must be grounded in the materials, with plausible distractors, teaching explanations, a hint and an exact source reference each.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short quiz title, e.g. "Lecture 3: TCP and UDP".' },
      questions: {
        type: 'array',
        description: 'The questions in the order they should be asked.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer'] },
            topic: { type: 'string', description: 'Short reusable topic label, e.g. "TCP handshake".' },
            difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
            question: { type: 'string', description: 'The question in Markdown.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'multiple_choice: 3-5 options; true_false: exactly ["True", "False"]; short_answer: [].',
            },
            correct_option_index: {
              type: 'integer',
              description: 'Zero-based index of the correct option; -1 for short_answer.',
            },
            model_answer: { type: 'string', description: 'The correct answer, detailed enough to grade a free-text answer against.' },
            explanation: { type: 'string', description: 'Why the answer is right and why each distractor is wrong. Markdown.' },
            source_ref: { type: 'string', description: 'Where this comes from, e.g. "Slide 12" or "Lecture 3, p.4".' },
            hint: { type: 'string', description: 'A short hint that nudges without giving the answer away.' },
          },
          required: ['type', 'topic', 'difficulty', 'question', 'options', 'correct_option_index', 'model_answer', 'explanation', 'source_ref', 'hint'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'questions'],
    additionalProperties: false,
  },
};

const TOOLS: Anthropic.Tool[] = [UPDATE_GUIDE_TOOL, REGENERATE_GUIDE_TOOL, CREATE_QUIZ_TOOL];

const UpdateGuideInput = z.object({
  operation: z.enum(['replace_section', 'insert_after_section', 'append', 'replace_all']),
  heading: z.string(),
  markdown: z.string(),
  summary: z.string(),
});
export type UpdateGuideInput = z.infer<typeof UpdateGuideInput>;

const RegenerateInput = z.object({ instructions: z.string(), summary: z.string() });

const QuizQuestionInput = z.object({
  type: z.enum(['multiple_choice', 'true_false', 'short_answer']),
  topic: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  question: z.string(),
  options: z.array(z.string()),
  correct_option_index: z.number().int(),
  model_answer: z.string(),
  explanation: z.string(),
  source_ref: z.string(),
  hint: z.string(),
});
export const QuizInput = z.object({ title: z.string(), questions: z.array(QuizQuestionInput).min(1) });
export type QuizInput = z.infer<typeof QuizInput>;

// ---------------------------------------------------------------------------
// Prompt prefix: system → materials → (current guide). Cached with 1h TTL.
// ---------------------------------------------------------------------------

async function fileBase64(filePath: string): Promise<string> {
  return (await fs.readFile(filePath)).toString('base64');
}

async function materialBlocks(materials: ExtractedMaterial[]): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const [index, material] of materials.entries()) {
    blocks.push({
      type: 'text',
      text: `=== Material ${index + 1} of ${materials.length}: "${material.name}" (${material.kind.toUpperCase()}, ${material.summary}) ===`,
    });
    for (const part of material.parts) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: `${part.label ? `[${material.name} — ${part.label}]\n` : ''}${part.text}` });
      } else if (part.type === 'pdf') {
        blocks.push({
          type: 'document',
          title: material.name,
          source: part.fileId
            ? { type: 'file', file_id: part.fileId }
            : { type: 'base64', media_type: 'application/pdf', data: await fileBase64(part.path) },
        });
      } else {
        if (part.label) blocks.push({ type: 'text', text: `[${material.name} — ${part.label}]` });
        blocks.push({
          type: 'image',
          source: part.fileId
            ? { type: 'file', file_id: part.fileId }
            : { type: 'base64', media_type: part.mediaType, data: await fileBase64(part.path) },
        });
      }
    }
  }
  return blocks;
}

export async function buildPrefix(materials: ExtractedMaterial[], guide: StudyGuide | null): Promise<Anthropic.MessageParam[]> {
  const blocks = await materialBlocks(materials);
  const prefix: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [...blocks, { type: 'text', text: materialsPreamble(materials), cache_control: { type: 'ephemeral', ttl: '1h' } }],
    },
    { role: 'assistant', content: MATERIALS_ACK },
  ];
  if (guide && guide.markdown.trim()) {
    prefix.push({ role: 'user', content: guideInstruction(guide.prompt) });
    prefix.push({
      role: 'assistant',
      content: [{ type: 'text', text: guide.markdown, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
  }
  return prefix;
}

/** Replays the visible chat transcript (text only). Guide-generation turns are already in the prefix. */
function historyMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  return history
    .filter((m) => m.kind !== 'guide' && m.content.trim().length > 0)
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content }));
}

function baseParams(messages: Anthropic.MessageParam[], maxTokens: number): Anthropic.MessageStreamParams {
  return {
    model: config.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: TOOLS,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: config.effort },
    cache_control: { type: 'ephemeral' },
    messages,
  };
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

interface TurnHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (name: string) => void;
}

async function streamTurn(
  params: Anthropic.MessageStreamParams,
  handlers: TurnHandlers,
  signal?: AbortSignal,
): Promise<Anthropic.Message> {
  const stream = getClient().messages.stream(params, { signal });
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') handlers.onToolStart?.(event.content_block.name);
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') handlers.onText?.(event.delta.text);
      else if (event.delta.type === 'thinking_delta') handlers.onThinking?.(event.delta.thinking);
    }
  }
  return stream.finalMessage();
}

export function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(total: UsageInfo, message: Anthropic.Message): void {
  total.inputTokens += message.usage.input_tokens;
  total.outputTokens += message.usage.output_tokens;
  total.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
}

function refusalError(message: Anthropic.Message, what: string): Error {
  const detail = message.stop_reason === 'refusal' ? message.stop_details?.explanation : undefined;
  return new Error(`Claude declined to ${what}${detail ? `: ${detail}` : '.'}`);
}

const CONTINUE_PROMPT =
  'Your response was cut off by the length limit. Continue exactly where you stopped, without repeating anything already written and without any preamble.';

type Send = (event: StreamEvent) => void;

// ---------------------------------------------------------------------------
// Study guide generation
// ---------------------------------------------------------------------------

export interface DocumentResult {
  markdown: string;
  thinking: string;
  usage: UsageInfo;
}

async function streamDocument(
  messages: Anthropic.MessageParam[],
  maxTokens: number,
  deltaEvent: 'guide_delta' | 'text',
  what: string,
  send: Send,
  signal?: AbortSignal,
): Promise<DocumentResult> {
  let markdown = '';
  let thinking = '';
  const usage = emptyUsage();
  for (let round = 0; round < 4; round++) {
    const message = await streamTurn(
      baseParams(messages, maxTokens),
      {
        onText: (t) => {
          markdown += t;
          send({ type: deltaEvent, text: t });
        },
        onThinking: (t) => {
          thinking += t;
          send({ type: 'thinking', text: t });
        },
      },
      signal,
    );
    addUsage(usage, message);
    if (message.stop_reason === 'refusal') throw refusalError(message, what);
    if (message.stop_reason !== 'max_tokens') break;
    messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: CONTINUE_PROMPT });
    send({ type: 'status', text: 'Continuing…' });
  }
  if (!markdown.trim()) throw new Error(`Claude returned an empty response while trying to ${what}. Please try again.`);
  return { markdown: `${markdown.trim()}\n`, thinking, usage };
}

export async function generateGuide(opts: {
  materials: ExtractedMaterial[];
  prompt: string;
  send: Send;
  signal?: AbortSignal;
}): Promise<DocumentResult> {
  const messages = [...(await buildPrefix(opts.materials, null)), { role: 'user' as const, content: guideInstruction(opts.prompt) }];
  return streamDocument(messages, 64_000, 'guide_delta', 'write the study guide', opts.send, opts.signal);
}

// ---------------------------------------------------------------------------
// Post-quiz review
// ---------------------------------------------------------------------------

export async function generateReview(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  quiz: Quiz;
  send: Send;
  signal?: AbortSignal;
}): Promise<DocumentResult> {
  const messages = [...(await buildPrefix(opts.materials, opts.guide)), { role: 'user' as const, content: reviewInstruction(opts.quiz) }];
  return streamDocument(messages, 32_000, 'text', 'write the review', opts.send, opts.signal);
}

// ---------------------------------------------------------------------------
// Chat with tools
// ---------------------------------------------------------------------------

export interface ChatHooks {
  applyGuideEdit: (input: UpdateGuideInput) => Promise<{ ok: boolean; message: string; guide?: StudyGuide }>;
  regenerateGuide: (instructions: string) => Promise<StudyGuide>;
  createQuiz: (input: QuizInput) => Promise<Quiz>;
}

export interface ChatResult {
  text: string;
  thinking: string;
  toolEvents: ToolEvent[];
  usage: UsageInfo;
}

const TOOL_STATUS: Record<string, string> = {
  update_study_guide: 'Editing the study guide…',
  regenerate_study_guide: 'Rewriting the study guide…',
  create_quiz: 'Writing quiz questions…',
};

async function executeTool(
  block: Anthropic.ToolUseBlock,
  hooks: ChatHooks,
  send: Send,
): Promise<{ result: Anthropic.ToolResultBlockParam; event: ToolEvent }> {
  const failure = (message: string): { result: Anthropic.ToolResultBlockParam; event: ToolEvent } => ({
    result: { type: 'tool_result', tool_use_id: block.id, is_error: true, content: message },
    event: { name: block.name, summary: message },
  });
  try {
    switch (block.name) {
      case 'update_study_guide': {
        const parsed = UpdateGuideInput.safeParse(block.input);
        if (!parsed.success) return failure(`Invalid input: ${parsed.error.message}`);
        const outcome = await hooks.applyGuideEdit(parsed.data);
        if (!outcome.ok) return failure(outcome.message);
        if (outcome.guide) send({ type: 'guide', guide: outcome.guide });
        return {
          result: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `${outcome.message} The student can see the updated document now.`,
          },
          event: { name: block.name, summary: parsed.data.summary || outcome.message },
        };
      }
      case 'regenerate_study_guide': {
        const parsed = RegenerateInput.safeParse(block.input);
        if (!parsed.success) return failure(`Invalid input: ${parsed.error.message}`);
        const guide = await hooks.regenerateGuide(parsed.data.instructions);
        return {
          result: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `The study guide was regenerated (version ${guide.version}, about ${wordCount(guide.markdown)} words) and the student is reading it now. Briefly tell them what changed.`,
          },
          event: { name: block.name, summary: parsed.data.summary || 'Regenerated the study guide' },
        };
      }
      case 'create_quiz': {
        const parsed = QuizInput.safeParse(block.input);
        if (!parsed.success) return failure(`Invalid input: ${parsed.error.message}`);
        const quiz = await hooks.createQuiz(parsed.data);
        if (quiz.questions.length === 0) return failure('No valid questions were produced. Check option counts and correct_option_index values and try again.');
        send({ type: 'quiz', quiz });
        return {
          result: {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Quiz "${quiz.title}" with ${quiz.questions.length} questions is ready and the student will take it in the Quiz tab now. Tell them briefly; do not reveal questions or answers.`,
          },
          event: { name: block.name, summary: `Created quiz "${quiz.title}" (${quiz.questions.length} questions)` },
        };
      }
      default:
        return failure(`Unknown tool: ${block.name}`);
    }
  } catch (err) {
    return failure(describeError(err));
  }
}

export async function runChat(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  history: ChatMessage[];
  userMessage: string;
  hooks: ChatHooks;
  send: Send;
  signal?: AbortSignal;
}): Promise<ChatResult> {
  const messages: Anthropic.MessageParam[] = [
    ...(await buildPrefix(opts.materials, opts.guide)),
    ...historyMessages(opts.history),
    { role: 'user', content: opts.userMessage },
  ];
  let text = '';
  let thinking = '';
  const toolEvents: ToolEvent[] = [];
  const usage = emptyUsage();

  for (let iteration = 0; iteration < 8; iteration++) {
    const message = await streamTurn(
      baseParams(messages, 32_000),
      {
        onText: (t) => {
          text += t;
          opts.send({ type: 'text', text: t });
        },
        onThinking: (t) => {
          thinking += t;
          opts.send({ type: 'thinking', text: t });
        },
        onToolStart: (name) => opts.send({ type: 'status', text: TOOL_STATUS[name] ?? `Using ${name}…` }),
      },
      opts.signal,
    );
    addUsage(usage, message);

    if (message.stop_reason === 'refusal') throw refusalError(message, 'answer this');
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) break;
    if (message.stop_reason === 'max_tokens') {
      throw new Error('The response was cut off while editing the study guide. Please ask for a smaller change.');
    }

    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const { result, event } = await executeTool(toolUse, opts.hooks, opts.send);
      results.push(result);
      toolEvents.push(event);
      opts.send({ type: 'tool', name: event.name, summary: event.summary });
    }
    messages.push({ role: 'user', content: results });
    if (text.trim() && !text.endsWith('\n\n')) {
      text += '\n\n';
      opts.send({ type: 'text', text: '\n\n' });
    }
  }
  return { text: text.trim(), thinking, toolEvents, usage };
}

// ---------------------------------------------------------------------------
// Quiz creation (via the create_quiz tool) and grading
// ---------------------------------------------------------------------------

export async function requestQuiz(opts: {
  materials: ExtractedMaterial[];
  guide: StudyGuide | null;
  config: QuizConfig;
  previousQuizzes: Quiz[];
  send: Send;
  signal?: AbortSignal;
}): Promise<{ input: QuizInput; thinking: string; usage: UsageInfo }> {
  const messages: Anthropic.MessageParam[] = [
    ...(await buildPrefix(opts.materials, opts.guide)),
    { role: 'user', content: quizInstruction(opts.config, opts.previousQuizzes) },
  ];
  let thinking = '';
  const usage = emptyUsage();
  for (let attempt = 0; attempt < 3; attempt++) {
    const message = await streamTurn(
      baseParams(messages, 32_000),
      {
        onThinking: (t) => {
          thinking += t;
          opts.send({ type: 'thinking', text: t });
        },
        onToolStart: () => opts.send({ type: 'status', text: 'Writing quiz questions…' }),
      },
      opts.signal,
    );
    addUsage(usage, message);
    if (message.stop_reason === 'refusal') throw refusalError(message, 'create the quiz');
    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
      throw new Error('The quiz was too long to generate in one go. Try fewer questions.');
    }
    const quizCall = toolUses.find((b) => b.name === 'create_quiz');
    if (quizCall) {
      const parsed = QuizInput.safeParse(quizCall.input);
      if (parsed.success) return { input: parsed.data, thinking, usage };
      messages.push({ role: 'assistant', content: message.content });
      messages.push({
        role: 'user',
        content: toolUses.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id,
          is_error: true,
          content:
            b.id === quizCall.id
              ? `Invalid quiz: ${parsed.error.message}. Call create_quiz again with a valid quiz.`
              : 'Not available right now. Call create_quiz to create the quiz.',
        })),
      });
      continue;
    }
    messages.push({ role: 'assistant', content: message.content });
    messages.push({
      role: 'user',
      content:
        toolUses.length > 0
          ? toolUses.map((b) => ({
              type: 'tool_result' as const,
              tool_use_id: b.id,
              is_error: true,
              content: 'Not available right now. Call create_quiz to create the quiz.',
            }))
          : 'Please call the create_quiz tool now with the complete quiz.',
    });
  }
  throw new Error('Claude did not produce a quiz after several attempts. Please try again.');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Normalises the tool output into the app's Quiz shape, dropping malformed questions. */
export function buildQuiz(input: QuizInput, quizConfig: QuizConfig, id: string): Quiz {
  const questions: QuizQuestion[] = [];
  input.questions.forEach((q, index) => {
    const base: QuizQuestion = {
      id: `${id}-q${index + 1}`,
      type: q.type,
      topic: q.topic.trim() || 'General',
      difficulty: q.difficulty,
      question: q.question.trim(),
      modelAnswer: q.model_answer.trim(),
      explanation: q.explanation.trim(),
      sourceRef: q.source_ref.trim() || undefined,
      hint: q.hint.trim() || undefined,
    };
    if (!base.question) return;
    if (q.type === 'short_answer') {
      questions.push(base);
      return;
    }
    if (q.type === 'true_false') {
      const index = q.correct_option_index === 0 || q.correct_option_index === 1
        ? q.correct_option_index
        : /^\s*(true|yes|correct)\b/i.test(q.model_answer)
          ? 0
          : 1;
      questions.push({ ...base, options: ['True', 'False'], correctOptionIndex: index });
      return;
    }
    const options = q.options.map((o) => o.trim()).filter(Boolean);
    if (options.length < 2 || q.correct_option_index < 0 || q.correct_option_index >= options.length) return;
    questions.push({ ...base, options, correctOptionIndex: q.correct_option_index });
  });
  const types = unique(questions.map((q) => q.type)) as QuestionType[];
  return {
    id,
    title: input.title.trim() || 'Quiz',
    createdAt: new Date().toISOString(),
    config: { ...quizConfig, types: quizConfig.types.length ? quizConfig.types : types },
    questions: questions.slice(0, Math.max(1, quizConfig.numQuestions)),
    answers: [],
    status: 'in_progress',
  };
}

const GradeOutput = z.object({
  correct: z.boolean(),
  score: z.number(),
  feedback: z.string(),
});

export async function gradeShortAnswer(
  question: QuizQuestion,
  studentAnswer: string,
): Promise<{ correct: boolean; score: number; feedback: string }> {
  const response = await getClient().messages.parse({
    model: config.model,
    max_tokens: 4000,
    system: GRADER_SYSTEM,
    output_config: { effort: 'medium', format: zodOutputFormat(GradeOutput) },
    messages: [{ role: 'user', content: gradePrompt(question, studentAnswer) }],
  });
  if (response.stop_reason === 'refusal') throw refusalError(response, 'grade this answer');
  const parsed = response.parsed_output;
  if (!parsed) throw new Error('Could not grade the answer. Please try again.');
  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  return { correct: score >= 70, score, feedback: parsed.feedback.trim() };
}

// ---------------------------------------------------------------------------
// Files API
// ---------------------------------------------------------------------------

/** Upload a PDF/image part once so later requests reference it by id. Returns null on failure (caller inlines instead). */
export async function uploadPartToFilesApi(part: MaterialPart, materialName: string): Promise<string | null> {
  if (part.type === 'text') return null;
  try {
    const data = await fs.readFile(part.path);
    const mime = part.type === 'pdf' ? 'application/pdf' : part.mediaType;
    const uploaded = await getClient().files.upload({
      file: await toFile(data, path.basename(part.path), { type: mime }),
    });
    return uploaded.id;
  } catch (err) {
    console.warn(`[files] Upload failed for ${materialName}; content will be sent inline instead. ${describeError(err)}`);
    return null;
  }
}

export async function deleteFileQuietly(fileId: string): Promise<void> {
  try {
    await getClient().files.delete(fileId);
  } catch (err) {
    console.warn(`[files] Could not delete ${fileId}: ${describeError(err)}`);
  }
}
