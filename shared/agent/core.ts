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

import { scrubModelNames } from './branding.js';
import { DEFAULT_AGENT_NAME, displayModel, type Effort } from './constants.js';
import {
  LlmError,
  abortableSleep,
  contentText,
  extractJsonObject,
  isNetworkTypeError,
  isTransient,
  toolUseBlocks,
  type LlmClient,
  type LlmHandlers,
  type LlmMessage,
  type LlmRequest,
} from './llm.js';
import { chainFrom } from './providers/chain.js';
import {
  ContinuationJoiner,
  PartialDocumentError,
  PartialReplyError,
  TAIL_CHARS,
  continuationReason,
  continuePrompt,
  resumeDelay,
  trimToSafeBoundary,
  type ContinueReason,
  type PartialReason,
} from './resume.js';

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
export { LlmError, isTransient } from './llm.js';
export {
  PartialDocumentError,
  PartialReplyError,
  guidePartialMessage,
  joinContinuation,
  longerDraft,
  partialGuide,
  partialSavedMessage,
  replyCutOffMessage,
  stoppedReasonPhrase,
  trimToSafeBoundary,
  type PartialReason,
} from './resume.js';

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
  /** False on white-label deployments: status lines and errors never name a provider or model. */
  showModels?: boolean;
  /** Waits before resuming after a dropped connection (default: setTimeout, abort-aware). Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function namesModels(ctx: AgentContext): boolean {
  return ctx.showModels !== false;
}

function agentNameOf(ctx: AgentContext): string {
  return ctx.agentName?.trim() || DEFAULT_AGENT_NAME;
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

export interface DescribeErrorOptions {
  /** False on white-label deployments: no provider or model names in the text. */
  showModels?: boolean;
  agentName?: string;
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof LlmError) return err.status;
  if (err instanceof Anthropic.APIError) return err.status;
  return undefined;
}

function dailyQuotaMessage(agentName: string): string {
  return `${agentName} has reached today's free limit. It resets overnight — you can also use ${agentName} with your own account.`;
}

function connectionLostMessage(agentName: string): string {
  return `Lost the connection to ${agentName}. Check your internet connection and try again.`;
}

function isConnectionLoss(err: unknown): boolean {
  return (err instanceof LlmError && (err.kind === 'network' || err.kind === 'stalled')) || isNetworkTypeError(err);
}

/** "Kiiku stopped partway (connection problem)" for the partial-result errors. */
function partialMessage(err: PartialDocumentError | PartialReplyError, agentName: string): string {
  return err instanceof PartialDocumentError
    ? `${agentName} stopped partway (${err.stoppedReason}).`
    : `${agentName}'s reply was cut off (${err.stoppedReason}).`;
}

/** Error text for white-label deployments: by kind and status where possible, otherwise the message with names scrubbed. */
function neutralErrorMessage(err: unknown, agentName: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PartialDocumentError || err instanceof PartialReplyError) return partialMessage(err, agentName);
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the model service. Check the connection and try again.';
  if (/Could not resolve authentication method/i.test(message)) return 'Model access is not configured on this site.';
  if (/credit balance/i.test(message)) return 'The model service account has run out of credit. Please try again later.';
  if (err instanceof LlmError && err.kind === 'daily_quota') return dailyQuotaMessage(agentName);
  if (isConnectionLoss(err)) return connectionLostMessage(agentName);
  const status = statusOf(err);
  if (status === 401 || status === 403) return 'Model access on this site is not set up correctly. Please try again later.';
  if (status === 402) return 'The model service declined the request (billing). Please try again later.';
  if (status === 413) return 'This request is too large. Remove some materials or shorten the conversation.';
  if (status === 429) return `${agentName} is busy right now. Wait a moment and try again.`;
  if (status !== undefined && status >= 500) return 'The model service is having problems. Please try again in a moment.';
  return scrubModelNames(message);
}

export function describeError(err: unknown, options: DescribeErrorOptions = {}): string {
  const agentName = options.agentName?.trim() || DEFAULT_AGENT_NAME;
  if (options.showModels === false) return neutralErrorMessage(err, agentName);
  if (err instanceof PartialDocumentError || err instanceof PartialReplyError) {
    const cause = err.cause instanceof Error ? ` ${err.cause.message}` : '';
    return `${partialMessage(err, agentName)}${cause}`;
  }
  if (err instanceof LlmError) {
    if (err.kind === 'daily_quota') return `${err.message} — today's free quota is used up; it resets overnight.`;
    if (err.kind === 'network' || err.kind === 'stalled') return `Lost the connection to the model: ${err.message}. Check your internet connection and try again.`;
    return err.message;
  }
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
// Tools. Chat and quiz calls send this exact list every time, byte-identical, so
// they share one cached prefix. Guide and review documents go out without tools
// (their prefix is cached on its own): a function call in the middle of a
// document would end the stream and leave the document cut short.
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

function baseRequest(
  ctx: AgentContext,
  model: ModelChain,
  messages: Anthropic.MessageParam[],
  maxTokens: number,
  opts: { tools?: boolean } = {},
): LlmRequest {
  return {
    model,
    system: systemPrompt(ctx.agentName ?? DEFAULT_AGENT_NAME),
    tools: opts.tools === false ? undefined : TOOLS,
    maxTokens,
    effort: ctx.effort,
    // Thinking summaries are the model's own words and may name its maker, so white-label deployments do without them.
    showThinking: namesModels(ctx),
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
  /** The chain moved on to model `to` (so text streamed after this comes from it). */
  onModelSwitch?: (to: string) => void;
  /** The chain is about to start over from its first model. */
  onWait?: () => void;
}

/** An error or failure reason on one line, short enough for a status line. */
function shortReason(reason: string): string {
  const line = reason.replace(/\s+/g, ' ').trim();
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function switchStatus(info: { from: string; to: string; reason: string }, showModels: boolean): string {
  if (!showModels) return 'Trying another model…';
  return `${displayModel(info.from)} unavailable (${shortReason(info.reason)}); trying ${displayModel(info.to)}…`;
}

/** Every model was busy: the chain waits and tries again. */
function waitStatus(ctx: AgentContext, info: { ms: number; reason: string }): string {
  const retry = `trying again in ${seconds(info.ms)} s…`;
  if (!namesModels(ctx)) return `${agentNameOf(ctx)} is busy right now — ${retry}`;
  return `All models are busy (${shortReason(info.reason)}) — ${retry}`;
}

/** The connection dropped after text was written: the core waits, then resumes. */
function hiccupStatus(ctx: AgentContext, ms: number, err: unknown): string {
  const wait = `${agentNameOf(ctx)} will pick up where it left off in ${seconds(ms)} s…`;
  if (!namesModels(ctx)) return `Connection hiccup — ${wait}`;
  return `Connection hiccup (${shortReason(describeError(err))}) — ${wait}`;
}

function resumingStatus(ctx: AgentContext): string {
  return `Picking up where ${agentNameOf(ctx)} left off…`;
}

async function streamTurn(
  ctx: AgentContext,
  request: LlmRequest,
  handlers: TurnHandlers,
  send: Send | undefined,
  signal?: AbortSignal,
): Promise<LlmMessage> {
  const { onModelSwitch, onWait, ...rest } = handlers;
  const llmHandlers: LlmHandlers = {
    ...rest,
    onModelSwitch: (info) => {
      onModelSwitch?.(info.to);
      send?.({ type: 'status', text: switchStatus(info, namesModels(ctx)) });
    },
    onWait: (info) => {
      onWait?.();
      send?.({ type: 'status', text: waitStatus(ctx, info) });
    },
  };
  return ctx.llm.stream(request, llmHandlers, signal);
}

/** ctx.sleep, turning an abort during the wait into `onAbort()`'s error. */
async function waitOrStop(ctx: AgentContext, ms: number, signal: AbortSignal | undefined, onAbort: (err: unknown) => Error): Promise<void> {
  try {
    await (ctx.sleep ?? abortableSleep)(ms, signal);
  } catch (err) {
    if (signal?.aborted) throw onAbort(err);
    throw err;
  }
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

function refusalError(message: LlmMessage, what: string, showModels: boolean): Error {
  const detail = message.stop_reason === 'refusal' ? message.stop_details?.explanation : undefined;
  const who = (showModels && displayModel(message.ref)) || 'The model';
  return new Error(`${who} declined to ${what}${detail ? `: ${showModels ? detail : scrubModelNames(detail)}` : '.'}`);
}

/** The chat note posted when a study guide has been written. */
export function guideReadyMessage(version: number, words: number, model: string | undefined, showModels: boolean): string {
  const by = showModels && model ? `, written by ${displayModel(model)}` : '';
  return `📘 Study guide v${version} is ready (about ${words.toLocaleString()} words${by}). Open the **Study Guide** tab to read it, or tell me what to change, expand or explain.`;
}

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

/** Requests per document: the first answer plus its continuations and resumes. */
const MAX_SEGMENTS = 6;
/** Automatic resumes per document after a transient failure once text exists. */
const MAX_RESUMES = 3;

export interface StreamDocumentOptions {
  /** Text written earlier (a saved partial document): the first request continues it instead of starting over. */
  initialDraft?: string;
}

/**
 * Streams a long document and sees it through to the end. The document grows
 * over up to MAX_SEGMENTS requests: past the length limit, past answers the
 * provider cut short (pause_turn) and, up to MAX_RESUMES times, past transient
 * failures after text exists (a dropped connection, a stalled stream, a busy
 * service). Each continuation restarts from a clean line outside any code fence
 * and holds back its opening so a repeated tail or a preamble never reaches the
 * page. If the model declines or returns nothing before any text exists, the
 * escalation model gets one attempt from scratch. When the document cannot be
 * finished but some of it exists, PartialDocumentError carries what the student
 * saw so the caller can save it.
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
  options: StreamDocumentOptions = {},
): Promise<DocumentResult> {
  const usage = emptyUsage();
  const showModels = namesModels(ctx);
  const target = deltaEvent === 'guide_delta' ? 'guide' : 'text';
  let chain: ModelChain = model;
  let used = primaryOf(model);
  /** Exactly the text the student has been shown so far. */
  let draft = options.initialDraft ?? '';
  let thinking = '';
  /** Why the next request continues the draft; null while the document has not been started. */
  let pending: ContinueReason | null = draft ? 'interrupted' : null;
  let resumes = 0;
  let escalated = false;

  const partial = (reason: PartialReason, cause?: unknown) => new PartialDocumentError(reason, { markdown: draft, thinking, usage, model: used }, cause);
  const finished = (): DocumentResult => ({ markdown: `${draft.trim()}\n`, thinking, usage, model: used });
  const emptyError = () => new Error(`${(showModels && displayModel(used)) || 'The model'} returned an empty response while trying to ${what}. Please try again.`);
  /** Nothing has reached the page yet, so the escalation model can start over (once). */
  const escalate = (why: string): boolean => {
    const fallback = escalated ? undefined : escalationFor(ctx, chain);
    if (!fallback) return false;
    send({ type: 'status', text: showModels ? `${displayModel(used)} ${why}; trying ${displayModel(fallback)}…` : 'Trying a stronger model…' });
    chain = fallback;
    used = fallback;
    escalated = true;
    pending = null;
    return true;
  };

  if (draft) send({ type: 'status', text: resumingStatus(ctx) });

  for (let segment = 0; segment < MAX_SEGMENTS; segment++) {
    let messages = initialMessages;
    let continuing = false;
    if (pending) {
      // Resume from a clean line break outside any code fence, so a diagram is never continued halfway.
      const trimmed = trimToSafeBoundary(draft);
      if (trimmed !== draft) {
        draft = trimmed;
        send({ type: 'draft', target, text: draft });
      }
      if (draft.trim()) {
        continuing = true;
        messages = [
          ...initialMessages,
          { role: 'assistant', content: draft },
          { role: 'user', content: continuePrompt(pending, draft.slice(-TAIL_CHARS)) },
        ];
      }
    }
    // Later requests stay on the model that wrote the text, falling back only to the models after it.
    const segmentModel: ModelChain = segment === 0 && !options.initialDraft ? chain : chainFrom(used, chain);
    let attempting = primaryOf(segmentModel);
    let wroteText = false;
    const joiner = new ContinuationJoiner(
      draft,
      (text) => {
        wroteText = true;
        draft += text;
        send({ type: deltaEvent, text });
      },
      continuing,
    );

    let message: LlmMessage;
    try {
      message = await streamTurn(
        ctx,
        baseRequest(ctx, segmentModel, messages, maxTokens, { tools: false }),
        {
          onText: (t) => joiner.push(t),
          onThinking: (t) => {
            thinking += t;
            send({ type: 'thinking', text: t });
          },
          onModelSwitch: (to) => (attempting = to),
          onWait: () => (attempting = primaryOf(segmentModel)),
        },
        send,
        signal,
      );
    } catch (err) {
      joiner.release();
      if (wroteText) used = attempting;
      if (signal?.aborted) {
        if (draft.trim()) throw partial('stopped', err);
        throw err;
      }
      // Nothing written anywhere yet: the chain has already retried, so fail as before.
      if (!draft.trim()) throw err;
      if (!isTransient(err)) throw partial('failed', err);
      if (resumes >= MAX_RESUMES || segment + 1 >= MAX_SEGMENTS) throw partial('interrupted', err);
      const ms = resumeDelay(resumes, err);
      resumes += 1;
      send({ type: 'status', text: hiccupStatus(ctx, ms, err) });
      await waitOrStop(ctx, ms, signal, (abort) => partial('stopped', abort));
      send({ type: 'status', text: resumingStatus(ctx) });
      pending = 'interrupted';
      continue;
    }
    joiner.release();
    used = message.ref;
    addUsage(usage, message);

    if (message.stop_reason === 'refusal') {
      if (draft.trim()) throw partial('refused', refusalError(message, `finish the response while trying to ${what}`, showModels));
      if (escalate('declined')) continue;
      throw refusalError(message, what, showModels);
    }
    const reason = continuationReason(message);
    if (!reason) {
      if (draft.trim()) return finished();
      if (escalate('returned nothing')) continue;
      throw emptyError();
    }
    pending = reason;
    send({ type: 'status', text: 'Continuing…' });
  }

  if (!draft.trim()) throw emptyError();
  // Out of requests. A document cut only by the length limit is kept as it stands (as before); anything else is unfinished.
  if (pending === 'length') return finished();
  throw partial('interrupted');
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

/**
 * Finishes a saved partial study guide or review: the same request that wrote it,
 * continued from `draft`. The result's markdown is the whole document (the draft,
 * cut back to a safe point, plus the continuation).
 */
export async function continueDocument(
  ctx: AgentContext,
  opts: {
    kind: 'guide' | 'review';
    materials: MaterialsInput;
    guide: StudyGuide | null;
    quiz?: Quiz;
    draft: string;
    send: Send;
    signal?: AbortSignal;
  },
): Promise<DocumentResult> {
  const continued = { initialDraft: opts.draft };
  if (opts.kind === 'guide') {
    if (!opts.guide) throw new Error('There is no study guide to continue.');
    const messages = [...buildPrefix(opts.materials, null), { role: 'user' as const, content: guideInstruction(opts.guide.prompt) }];
    // A guide written at maximum quality is finished by the same model (as when it is rewritten).
    const escalation = ctx.escalationModel?.trim();
    const model: ModelChain = escalation && opts.guide.model === escalation ? escalation : ctx.models.guide;
    return streamDocument(ctx, model, messages, 64_000, 'guide_delta', 'write the study guide', opts.send, opts.signal, continued);
  }
  if (!opts.quiz) throw new Error('There is no quiz review to continue.');
  const messages = [...buildPrefix(opts.materials, opts.guide), { role: 'user' as const, content: reviewInstruction(opts.quiz) }];
  return streamDocument(ctx, ctx.models.review, messages, 32_000, 'text', 'write the review', opts.send, opts.signal, continued);
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

/** Extra requests for one chat turn that hit the length limit or was cut short. */
const MAX_CHAT_CONTINUATIONS = 2;

/**
 * One chat turn with tools. An answer cut by the length limit or cut short by the
 * provider is continued (up to MAX_CHAT_CONTINUATIONS times), and one dropped
 * connection after text is resumed automatically. When the reply cannot be
 * finished but text or tool results exist, PartialReplyError carries them so the
 * caller can save the reply as incomplete.
 */
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
  const chain: ModelChain = ctx.models.chat;
  /** Exactly the reply text the student has been shown so far. */
  let text = '';
  let thinking = '';
  const toolEvents: ToolEvent[] = [];
  const usage = emptyUsage();
  let model: ModelChain = chain;
  let continuations = 0;
  let resumed = false;
  /** The next request continues a cut-off answer: hold back its opening and join it to the text. */
  let continuing = false;

  const partial = (reason: PartialReason, cause?: unknown) =>
    new PartialReplyError(reason, { text: text.trim(), thinking, toolEvents, usage }, cause);
  /** Cuts this turn's text back to a safe point and asks the model (on `ref`, then the rest of the chain) for the rest. */
  const continueTurn = (reason: ContinueReason, turnText: string, ref: string) => {
    const kept = trimToSafeBoundary(turnText);
    if (kept.length < turnText.length) {
      text = text.slice(0, text.length - (turnText.length - kept.length));
      opts.send({ type: 'draft', target: 'text', text });
    }
    // With nothing kept, the same request is simply sent again.
    if (kept.trim()) messages.push({ role: 'assistant', content: kept }, { role: 'user', content: continuePrompt(reason, kept.slice(-TAIL_CHARS)) });
    model = chainFrom(ref, chain);
    continuing = kept.trim().length > 0;
  };

  for (let iteration = 0; iteration < 8; iteration++) {
    let turnText = '';
    let attempting = primaryOf(model);
    const joiner = new ContinuationJoiner(
      text,
      (t) => {
        turnText += t;
        text += t;
        opts.send({ type: 'text', text: t });
      },
      continuing,
    );
    continuing = false;
    const turnModel = model;

    let message: LlmMessage;
    try {
      message = await streamTurn(
        ctx,
        baseRequest(ctx, turnModel, messages, 32_000),
        {
          onText: (t) => joiner.push(t),
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
          onModelSwitch: (to) => (attempting = to),
          onWait: () => (attempting = primaryOf(turnModel)),
        },
        opts.send,
        opts.signal,
      );
    } catch (err) {
      joiner.release();
      const saw = text.trim().length > 0 || toolEvents.length > 0;
      if (opts.signal?.aborted) {
        if (saw) throw partial('stopped', err);
        throw err;
      }
      if (!resumed && turnText.trim() && isTransient(err)) {
        resumed = true;
        const ms = resumeDelay(0, err);
        opts.send({ type: 'status', text: hiccupStatus(ctx, ms, err) });
        await waitOrStop(ctx, ms, opts.signal, (abort) => partial('stopped', abort));
        opts.send({ type: 'status', text: resumingStatus(ctx) });
        continueTurn('interrupted', turnText, attempting);
        continue;
      }
      if (saw) throw partial(isTransient(err) ? 'interrupted' : 'failed', err);
      throw err;
    }
    joiner.release();
    addUsage(usage, message);
    // Later iterations of this turn stay on the model that answered (tool loops mix badly across providers).
    model = message.ref;

    if (message.stop_reason === 'refusal') {
      const fallback = escalationFor(ctx, model);
      if (fallback && !text.trim()) {
        opts.send({ type: 'status', text: namesModels(ctx) ? `${displayModel(model)} declined; trying ${displayModel(fallback)}…` : 'Trying a stronger model…' });
        model = fallback;
        continue;
      }
      const declined = refusalError(message, 'answer this', namesModels(ctx));
      if (text.trim() || toolEvents.length) throw partial('refused', declined);
      throw declined;
    }
    const toolUses = toolUseBlocks(message.content);
    if (toolUses.length === 0) {
      const reason = continuationReason(message);
      if (!reason) break;
      if (continuations >= MAX_CHAT_CONTINUATIONS) {
        // An answer cut only by the length limit is kept as it stands; one cut short by the provider is unfinished.
        if (reason === 'length' || !text.trim()) break;
        throw partial('interrupted');
      }
      continuations += 1;
      opts.send({ type: 'status', text: 'Continuing…' });
      continueTurn(reason, turnText, message.ref);
      continue;
    }
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
      opts.send({ type: 'status', text: namesModels(ctx) ? `Trying ${displayModel(fallback)}…` : 'Trying a stronger model…' });
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
        opts.send({ type: 'status', text: namesModels(ctx) ? `${displayModel(model)} declined; trying ${displayModel(fallback)}…` : 'Trying a stronger model…' });
        model = fallback;
        continue;
      }
      throw refusalError(message, 'create the quiz', namesModels(ctx));
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
  throw new Error('No quiz was produced after several attempts. Please try again.');
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
      // Thinking tokens count against maxTokens on Gemini, so leave room for the JSON after them.
      { model, system: GRADER_SYSTEM, messages, maxTokens: 8000, effort: 'medium', outputSchema: { name: 'grade', schema } },
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
    if (!fallback) throw refusalError(response, 'grade this answer', namesModels(ctx));
    response = await grade(fallback);
    if (response.stop_reason === 'refusal') throw refusalError(response, 'grade this answer', namesModels(ctx));
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
