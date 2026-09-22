/**
 * Isomorphic Study Agent core: everything that talks to a model, usable from the
 * Node server and from the browser (browser mode). Callers supply an LlmClient
 * (Claude, Gemini, OpenAI-compatible or a fallback chain of them) and the
 * material content blocks; persistence stays with the caller.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  ChatMessage,
  Quiz,
  QuizConfig,
  QuizQuestion,
  QuestionType,
  StreamEvent,
  StudyGuide,
  TaskModels,
  ToolEvent,
  UsageInfo,
} from '../types.js';
import { wordCount } from './guideEdits.js';
import {
  GRADER_SYSTEM,
  MATERIALS_ACK,
  systemPrompt,
  gradePrompt,
  guideInstruction,
  materialsPreamble,
  quizInstruction,
  reviewInstruction,
  type MaterialInfo,
} from './prompts.js';

import { DEFAULT_AGENT_NAME, displayModel, type Effort } from './constants.js';
import { LlmError, contentText, extractJsonObject, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest } from './llm.js';

export {
  AGENT_TASKS,
  DEFAULT_AGENT_NAME,
  DEFAULT_ESCALATION_MODEL,
  DEFAULT_MODEL,
  DEFAULT_TASK_MODELS,
  EFFORTS,
  FREE_CHAIN,
  PROVIDER_LABELS,
  TASK_LABELS,
  displayModel,
  isEffort,
  parseModelRef,
  providersOf,
  resolveTaskModels,
  type Effort,
  type ModelRef,
} from './constants.js';
export type { LlmClient, LlmHandlers, LlmMessage, LlmRequest } from './llm.js';
export { LlmError } from './llm.js';

export interface AgentContext {
  /** Claude, Gemini, an OpenAI-compatible endpoint, or a fallback chain of them. */
  llm: LlmClient;
  /** Model chain per kind of call (guide, chat, quiz, grading, review). */
  models: TaskModels;
  effort: Effort;
  /** Tried when a task's model declines or returns nothing; also used for maximum-quality guides. */
  escalationModel?: string;
  /** Persona name used in the system prompt (default: Kiiku). */
  agentName?: string;
}

type ModelChain = string | string[];

function primaryOf(model: ModelChain): string {
  return Array.isArray(model) ? (model[0] ?? '') : model;
}

/** The escalation model, when one is configured and differs from the chain's first model. */
function escalationFor(ctx: AgentContext, model: ModelChain): string | undefined {
  const candidate = ctx.escalationModel?.trim();
  return candidate && candidate !== primaryOf(model) ? candidate : undefined;
}

/** Content blocks for the materials plus the short descriptions the prompts need. */
export interface MaterialsInput {
  info: MaterialInfo[];
  blocks: Anthropic.ContentBlockParam[];
}

type Send = (event: StreamEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function describeError(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check the key and try again.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Claude denied the request: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting requests right now. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'The request to Claude timed out. Please try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check the network connection (and any proxy URL) and try again.';
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  if (err instanceof Error && /Could not resolve authentication method/i.test(err.message)) {
    return 'No Claude credentials are configured. Add an Anthropic API key and try again.';
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

export function buildPrefix(materials: MaterialsInput, guide: StudyGuide | null): Anthropic.MessageParam[] {
  const prefix: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        ...materials.blocks,
        { type: 'text', text: materialsPreamble(materials.info), cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
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

/** Header block that introduces one material inside the materials message. */
export function materialHeaderBlock(index: number, total: number, info: MaterialInfo): Anthropic.TextBlockParam {
  return {
    type: 'text',
    text: `=== Material ${index + 1} of ${total}: "${info.name}" (${info.kind.toUpperCase()}, ${info.summary}) ===`,
  };
}

/** Replays the visible chat transcript (text only). Guide-generation turns are already in the prefix. */
function historyMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  return history
    .filter((m) => m.kind !== 'guide' && m.content.trim().length > 0)
    .slice(-60)
    .map((m) => ({ role: m.role, content: m.content }));
}

function baseRequest(ctx: AgentContext, model: ModelChain, messages: Anthropic.MessageParam[], maxTokens: number): LlmRequest {
  return {
    model,
    system: systemPrompt(ctx.agentName ?? DEFAULT_AGENT_NAME),
    tools: TOOLS,
    maxTokens,
    effort: ctx.effort,
    showThinking: true,
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
  /** In-call tool execution for providers that support it (see LlmHandlers.executeTool). */
  executeTool?: LlmHandlers['executeTool'];
}

function switchStatus(info: { from: string; to: string; reason: string }): string {
  const reason = info.reason.replace(/\s+/g, ' ').trim();
  const short = reason.length > 90 ? `${reason.slice(0, 87)}…` : reason;
  return `${displayModel(info.from)} unavailable (${short}); trying ${displayModel(info.to)}…`;
}

async function streamTurn(
  ctx: AgentContext,
  request: LlmRequest,
  handlers: TurnHandlers,
  send: Send | undefined,
  signal?: AbortSignal,
): Promise<LlmMessage> {
  const llmHandlers: LlmHandlers = {
    ...handlers,
    onModelSwitch: (info) => send?.({ type: 'status', text: switchStatus(info) }),
  };
  return ctx.llm.stream(request, llmHandlers, signal);
}

export function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(total: UsageInfo, message: LlmMessage): void {
  total.inputTokens += message.usage.input_tokens;
  total.outputTokens += message.usage.output_tokens;
  total.cacheReadTokens += message.usage.cache_read_input_tokens;
  total.cacheWriteTokens += message.usage.cache_creation_input_tokens;
}

function refusalError(message: LlmMessage, what: string): Error {
  const detail = message.stop_reason === 'refusal' ? message.stop_details?.explanation : undefined;
  return new Error(`${displayModel(message.ref) || 'The model'} declined to ${what}${detail ? `: ${detail}` : '.'}`);
}

const CONTINUE_PROMPT =
  'Your response was cut off by the length limit. Continue exactly where you stopped, without repeating anything already written and without any preamble.';

// ---------------------------------------------------------------------------
// Documents: study guide and post-quiz review
// ---------------------------------------------------------------------------

export interface DocumentResult {
  markdown: string;
  thinking: string;
  usage: UsageInfo;
  /** Model that produced the document (the escalation model when the first choice declined). */
  model: string;
}

/**
 * Streams a long document, continuing past max_tokens cut-offs. If the model
 * declines or returns nothing before any text was streamed, the escalation
 * model gets one attempt (nothing has reached the UI yet, so it can start over).
 */
async function streamDocument(
  ctx: AgentContext,
  model: ModelChain,
  initialMessages: Anthropic.MessageParam[],
  maxTokens: number,
  deltaEvent: 'guide_delta' | 'text',
  what: string,
  send: Send,
  signal?: AbortSignal,
): Promise<DocumentResult> {
  const usage = emptyUsage();
  let thinking = '';

  const attempt = async (activeModel: ModelChain): Promise<{ markdown: string; refusal: LlmMessage | null; used: string }> => {
    const messages = [...initialMessages];
    let markdown = '';
    let used = primaryOf(activeModel);
    for (let round = 0; round < 4; round++) {
      const message = await streamTurn(
        ctx,
        baseRequest(ctx, round === 0 ? activeModel : used, messages, maxTokens),
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
        send,
        signal,
      );
      used = message.ref;
      addUsage(usage, message);
      if (message.stop_reason === 'refusal') return { markdown, refusal: message, used };
      if (message.stop_reason !== 'max_tokens') break;
      messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: CONTINUE_PROMPT });
      send({ type: 'status', text: 'Continuing…' });
    }
    return { markdown, refusal: null, used };
  };

  let result = await attempt(model);
  const fallback = escalationFor(ctx, model);
  if (fallback && !result.markdown.trim()) {
    send({ type: 'status', text: `${displayModel(result.used)} ${result.refusal ? 'declined' : 'returned nothing'}; trying ${displayModel(fallback)}…` });
    result = await attempt(fallback);
  }
  if (result.refusal && !result.markdown.trim()) throw refusalError(result.refusal, what);
  if (result.refusal) throw refusalError(result.refusal, `finish the response while trying to ${what}`);
  if (!result.markdown.trim()) throw new Error(`${displayModel(result.used) || 'The model'} returned an empty response while trying to ${what}. Please try again.`);
  return { markdown: `${result.markdown.trim()}\n`, thinking, usage, model: result.used };
}

export async function generateGuide(
  ctx: AgentContext,
  opts: { materials: MaterialsInput; prompt: string; send: Send; signal?: AbortSignal; /** Overrides ctx.models.guide, e.g. the escalation model for maximum quality. */ model?: string },
): Promise<DocumentResult> {
  const messages = [...buildPrefix(opts.materials, null), { role: 'user' as const, content: guideInstruction(opts.prompt) }];
  const model: ModelChain = opts.model?.trim() || ctx.models.guide;
  return streamDocument(ctx, model, messages, 64_000, 'guide_delta', 'write the study guide', opts.send, opts.signal);
}

export async function generateReview(
  ctx: AgentContext,
  opts: { materials: MaterialsInput; guide: StudyGuide | null; quiz: Quiz; send: Send; signal?: AbortSignal },
): Promise<DocumentResult> {
  const messages = [...buildPrefix(opts.materials, opts.guide), { role: 'user' as const, content: reviewInstruction(opts.quiz) }];
  return streamDocument(ctx, ctx.models.review, messages, 32_000, 'text', 'write the review', opts.send, opts.signal);
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

export async function runChat(
  ctx: AgentContext,
  opts: {
    materials: MaterialsInput;
    guide: StudyGuide | null;
    history: ChatMessage[];
    userMessage: string;
    hooks: ChatHooks;
    send: Send;
    signal?: AbortSignal;
  },
): Promise<ChatResult> {
  const messages: Anthropic.MessageParam[] = [
    ...buildPrefix(opts.materials, opts.guide),
    ...historyMessages(opts.history),
    { role: 'user', content: opts.userMessage },
  ];
  let text = '';
  let thinking = '';
  const toolEvents: ToolEvent[] = [];
  const usage = emptyUsage();
  let model: ModelChain = ctx.models.chat;

  for (let iteration = 0; iteration < 8; iteration++) {
    const message = await streamTurn(
      ctx,
      baseRequest(ctx, model, messages, 32_000),
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
        // Providers that run tools inside the call (the artifact runtime) execute them here and return the final text.
        executeTool: async (block) => {
          const { result, event } = await executeTool(block, opts.hooks, opts.send);
          toolEvents.push(event);
          opts.send({ type: 'tool', name: event.name, summary: event.summary });
          return result;
        },
      },
      opts.send,
      opts.signal,
    );
    addUsage(usage, message);
    // Later iterations of this turn stay on the model that answered (tool loops mix badly across providers).
    model = message.ref;

    if (message.stop_reason === 'refusal') {
      const fallback = escalationFor(ctx, model);
      if (fallback && !text.trim()) {
        opts.send({ type: 'status', text: `${displayModel(model)} declined; trying ${displayModel(fallback)}…` });
        model = fallback;
        continue;
      }
      throw refusalError(message, 'answer this');
    }
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

export async function requestQuiz(
  ctx: AgentContext,
  opts: {
    materials: MaterialsInput;
    guide: StudyGuide | null;
    config: QuizConfig;
    previousQuizzes: Quiz[];
    send: Send;
    signal?: AbortSignal;
  },
): Promise<{ input: QuizInput; thinking: string; usage: UsageInfo }> {
  const messages: Anthropic.MessageParam[] = [
    ...buildPrefix(opts.materials, opts.guide),
    { role: 'user', content: quizInstruction(opts.config, opts.previousQuizzes) },
  ];
  let thinking = '';
  const usage = emptyUsage();
  let model: ModelChain = ctx.models.quiz;
  const fallback = escalationFor(ctx, model);
  const maxAttempts = fallback ? 4 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt === 3 && fallback && model !== fallback) {
      opts.send({ type: 'status', text: `Trying ${displayModel(fallback)}…` });
      model = fallback;
    }
    const message = await streamTurn(
      ctx,
      baseRequest(ctx, model, messages, 32_000),
      {
        onThinking: (t) => {
          thinking += t;
          opts.send({ type: 'thinking', text: t });
        },
        onToolStart: () => opts.send({ type: 'status', text: 'Writing quiz questions…' }),
      },
      opts.send,
      opts.signal,
    );
    addUsage(usage, message);
    model = message.ref;
    if (message.stop_reason === 'refusal') {
      if (fallback && model !== fallback) {
        opts.send({ type: 'status', text: `${displayModel(model)} declined; trying ${displayModel(fallback)}…` });
        model = fallback;
        continue;
      }
      throw refusalError(message, 'create the quiz');
    }
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
  ctx: AgentContext,
  question: QuizQuestion,
  studentAnswer: string,
): Promise<{ correct: boolean; score: number; feedback: string }> {
  const schema = z.toJSONSchema(GradeOutput) as Record<string, unknown>;
  delete schema.$schema;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: gradePrompt(question, studentAnswer) }];
  const grade = (model: ModelChain) =>
    ctx.llm.stream(
      { model, system: GRADER_SYSTEM, messages, maxTokens: 4000, effort: 'medium', outputSchema: { name: 'grade', schema } },
      {},
    );
  const parse = (message: LlmMessage) => {
    const json = extractJsonObject(contentText(message.content));
    if (!json) return null;
    try {
      const result = GradeOutput.safeParse(JSON.parse(json));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  };

  let response = await grade(ctx.models.grading);
  if (response.stop_reason === 'refusal') {
    const fallback = escalationFor(ctx, ctx.models.grading);
    if (!fallback) throw refusalError(response, 'grade this answer');
    response = await grade(fallback);
    if (response.stop_reason === 'refusal') throw refusalError(response, 'grade this answer');
  }
  let parsed = parse(response);
  if (!parsed) {
    // One corrective retry on the model that answered, then give up.
    messages.push(
      { role: 'assistant', content: contentText(response.content) || '(empty)' },
      { role: 'user', content: 'That was not a valid JSON object matching the schema. Reply with only the JSON object: {"correct": boolean, "score": number 0-100, "feedback": string}.' },
    );
    response = await grade(response.ref);
    parsed = parse(response);
  }
  if (!parsed) throw new Error('Could not grade the answer. Please try again.');
  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  return { correct: score >= 70, score, feedback: parsed.feedback.trim() };
}

/** Instant grading for multiple-choice and true/false questions. */
export function gradeChoice(question: QuizQuestion, selectedOptionIndex: number | undefined): { correct: boolean; score: number; feedback: string } {
  const options = question.options ?? [];
  const correct = selectedOptionIndex !== undefined && selectedOptionIndex === question.correctOptionIndex;
  const correctText = options[question.correctOptionIndex ?? -1] ?? question.modelAnswer;
  return {
    correct,
    score: correct ? 100 : 0,
    feedback: correct
      ? `✅ **Correct!** ${question.explanation}`
      : `❌ **Not quite.** The correct answer is **${correctText}**.\n\n${question.explanation}`,
  };
}

/** The user prompt without any previous "Revision instructions" suffix. */
export function basePrompt(prompt: string | undefined, fallback: string): string {
  const raw = prompt ?? fallback;
  const index = raw.indexOf('\n\nRevision instructions:');
  return index === -1 ? raw : raw.slice(0, index);
}
