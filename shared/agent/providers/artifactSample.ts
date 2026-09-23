/**
 * Adapter for the claude.ai artifact runtime's `sample` capability: Claude on the
 * viewer's own claude.ai account, called from a published artifact. The runtime
 * has no system role, no thinking stream, a 64 KiB text budget per call, images
 * only as Blobs on the last turn and page-side tools that run inside the call.
 * This adapter maps the Anthropic-shaped requests the core builds onto that:
 * the system prompt becomes a leading user turn, PDFs travel as extracted text,
 * the transcript is trimmed to the budget, tools run through the runtime when
 * the view offers them (or through a JSON call protocol when it does not) and
 * JSON output goes through `sample.json`.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { isArtifactTier, type ArtifactTier } from '../constants.js';
import { LlmError, emptyLlmUsage, toolResultText, type LlmClient, type LlmHandlers, type LlmMessage, type LlmRequest, type StopReason } from '../llm.js';
import { getPdfText } from './pdfText.js';

// ---------------------------------------------------------------------------
// The runtime's contract (the subset used here; see the artifact runtime's sample.d.ts)
// ---------------------------------------------------------------------------

export interface SampleMessage {
  role: 'user' | 'assistant';
  content: string;
}
export type SampleInput = string | SampleMessage[];
export interface SampleTextUpdate {
  /** The whole answer so far. */
  text: string;
  delta: string;
}
export interface SampleTool {
  name: string;
  description: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [keyword: string]: unknown };
  execute(input: Record<string, unknown>, context: { signal: AbortSignal }): unknown;
}
export interface SampleOptions {
  onText?: (update: SampleTextUpdate) => void;
  signal?: AbortSignal;
  images?: Blob[];
  modelTier?: ArtifactTier;
  cache?: boolean | { gcTime?: number; refresh?: boolean };
  tools?: SampleTool[];
}
export interface SampleResult {
  text: string;
  truncated: boolean;
  modelTierApplied: ArtifactTier;
}
export interface SampleLimits {
  maxPromptBytes: number;
  images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] };
  tools?: { maxCount: number };
}
/** What a failed call rejects with (a plain object, not an Error). */
export interface SampleError {
  code: string;
  message: string;
  text?: string;
}
export interface SampleFunction {
  (input: SampleInput, options?: SampleOptions): Promise<SampleResult>;
  json<T = unknown>(input: SampleInput, options?: SampleOptions): Promise<T>;
  limits(): Promise<SampleLimits>;
}

export interface ArtifactSampleOptions {
  /** Resolves the runtime's sample function, normally `() => window.claude.use('sample')`; null when this view cannot use it. */
  resolve: () => Promise<SampleFunction | null>;
}

/** True when the page runs inside the claude.ai artifact viewer (window.claude.use exists before any page script). */
export function isArtifactHost(): boolean {
  const w = globalThis as { claude?: { use?: unknown } };
  return typeof w.claude?.use === 'function';
}

/** Resolver for the real runtime: `window.claude.use('sample')`, or null outside the viewer. */
export async function resolveRuntimeSample(): Promise<SampleFunction | null> {
  if (!isArtifactHost()) return null;
  const w = globalThis as unknown as { claude: { use(name: string): Promise<unknown> } };
  const sample = await w.claude.use('sample');
  return typeof sample === 'function' ? (sample as SampleFunction) : null;
}

// ---------------------------------------------------------------------------
// Prompt assembly within the byte budget
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PROMPT_BYTES = 65_536;
/** Kept free for the runtime's own framing and counting differences. */
const BUDGET_MARGIN = 1_536;
/** A material's text is never cut below this many characters. */
const MATERIAL_MIN_CHARS = 1_500;
/** Long assistant turns (a guide being continued, an earlier guide) keep at least this much of their tail. */
const DOCUMENT_MIN_CHARS = 4_000;
const DOCUMENT_THRESHOLD_CHARS = 6_000;
const MATERIAL_CUT_NOTE = '\n[… the rest of this material was left out to fit the 64 KB request limit of this artifact …]';
const DOCUMENT_CUT_NOTE = '[… earlier part of this document omitted; it continues below …]\n';
const RECORDED_RESULT =
  'Received. The app runs this tool after your reply. Do not call any other tool now; finish with one short sentence for the student.';
const MAX_TOOL_DESCRIPTION = 1_000;
const MAX_TOOL_SCHEMA = 4_096;
const MAX_EMULATED_ROUNDS = 6;

interface Part {
  text: string;
  /** How this part may be shortened: keep the head (materials) or keep the tail (long documents). */
  shrink?: 'keep-head' | 'keep-tail';
  min?: number;
}

interface Turn {
  role: 'user' | 'assistant';
  parts: Part[];
  /** Plain conversation turns can be dropped, oldest first, when the budget is tight. */
  droppable: boolean;
}

interface Assembled {
  turns: Turn[];
  images: Blob[];
}

const encoder = new TextEncoder();
function bytes(text: string): number {
  return encoder.encode(text).length;
}

function toolNameForId(messages: Anthropic.MessageParam[], toolUseId: string): string {
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const block of message.content) if (block.type === 'tool_use' && block.id === toolUseId) return block.name;
  }
  return 'tool';
}

function base64ToBlob(data: string, mediaType: string): Blob | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
  } catch {
    return null;
  }
}

/** The JSON form of a tool call used in transcripts (and as the call protocol when the view has no tools). */
export function toolCallJson(name: string, input: unknown): string {
  return JSON.stringify({ tool: name, input: input ?? {} });
}

/** Parses a reply that is (only) a tool call in the JSON protocol; null for anything else. */
export function parseToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; input?: unknown };
    if (typeof parsed.tool !== 'string' || !parsed.tool) return null;
    const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>) : {};
    return { name: parsed.tool, input };
  } catch {
    return null;
  }
}

/** While a reply could still turn out to be a tool call, it is held back from the UI. */
function mayBeToolCall(text: string): boolean {
  const head = text.trimStart();
  return head === '' || head.startsWith('{') || head.startsWith('```') || '```'.startsWith(head);
}

function toolProtocol(tools: Anthropic.Tool[]): string {
  const list = tools
    .map((tool) => `### ${tool.name}\n${tool.description ?? ''}\nInput JSON schema: ${JSON.stringify(tool.input_schema)}`)
    .join('\n\n');
  return (
    '\n\n## Tools\n' +
    'You can use the tools below. To call one, reply with ONLY a JSON object of the form {"tool": "<name>", "input": {…}} — no other text and no code fence. ' +
    'The app runs the tool and sends you its result as the next message; then write your reply to the student. Call at most one tool per reply. ' +
    'When no tool is needed, reply normally.\n\n' +
    list
  );
}

function jsonInstruction(request: LlmRequest): string {
  if (!request.outputSchema) return '';
  return `\n\nReply with only one JSON object (no prose, no code fence) that matches this JSON schema:\n${JSON.stringify(request.outputSchema.schema)}`;
}

function userParts(
  message: Anthropic.MessageParam,
  all: Anthropic.MessageParam[],
  images: Blob[],
  limits: SampleLimits,
): { parts: Part[]; hasMaterials: boolean } {
  if (typeof message.content === 'string') return { parts: [{ text: message.content }], hasMaterials: false };
  const parts: Part[] = [];
  let hasMaterials = false;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text });
        break;
      case 'image': {
        hasMaterials = true;
        const allowed = limits.images;
        const source = block.source;
        const blob = allowed && source.type === 'base64' && allowed.mediaTypes.includes(source.media_type) ? base64ToBlob(source.data, source.media_type) : null;
        if (blob && allowed && images.length < allowed.maxCount) {
          images.push(blob);
          parts.push({ text: `[Image ${images.length}: attached to this request]` });
        } else {
          parts.push({ text: allowed ? '[Image: not attached (image limit reached)]' : '[Image: cannot be shown in this view]' });
        }
        break;
      }
      case 'document': {
        hasMaterials = true;
        const source = block.source;
        const title = block.title ?? 'Document';
        const text = source.type === 'text' ? source.data : getPdfText(block);
        parts.push(
          text
            ? { text: `[${title}]\n${text}`, shrink: 'keep-head', min: MATERIAL_MIN_CHARS }
            : { text: `[Document "${title}" could not be attached: no text could be extracted from it]` },
        );
        break;
      }
      case 'tool_result': {
        const name = toolNameForId(all, block.tool_use_id);
        const text = toolResultText(block.content) || (block.is_error ? 'Error' : 'Done');
        parts.push({ text: `Tool result (${name})${block.is_error ? ' — error' : ''}: ${text}` });
        break;
      }
      default:
        break;
    }
  }
  return { parts, hasMaterials };
}

function assistantParts(message: Anthropic.MessageParam): Part[] {
  if (typeof message.content === 'string') return message.content ? [{ text: message.content }] : [];
  const pieces: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && block.text) pieces.push(block.text);
    else if (block.type === 'tool_use') pieces.push(toolCallJson(block.name, block.input));
  }
  const text = pieces.join('\n\n');
  if (!text) return [];
  return text.length > DOCUMENT_THRESHOLD_CHARS ? [{ text, shrink: 'keep-tail', min: DOCUMENT_MIN_CHARS }] : [{ text }];
}

function turnText(turn: Turn): string {
  return turn.parts
    .map((p) => p.text)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

function totalBytes(turns: Turn[]): number {
  return turns.reduce((sum, turn) => sum + bytes(turnText(turn)), 0);
}

/** Drops old conversation turns and shortens materials and long documents until the transcript fits. */
function fitToBudget(turns: Turn[], budget: number, model: string): SampleMessage[] {
  let total = totalBytes(turns);
  while (total > budget) {
    const droppable = turns.filter((t) => t.droppable);
    if (droppable.length > 2) {
      turns.splice(turns.indexOf(droppable[0]), 1);
      total = totalBytes(turns);
      continue;
    }
    const candidates = turns.flatMap((t) => t.parts).filter((p) => p.shrink && p.text.length > (p.min ?? 0));
    if (candidates.length === 0) break;
    const largest = candidates.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const over = total - budget;
    const cut = Math.min(largest.text.length - (largest.min ?? 0), Math.max(over + 256, 1_024));
    if (largest.shrink === 'keep-head') {
      const body = largest.text.endsWith(MATERIAL_CUT_NOTE) ? largest.text.slice(0, -MATERIAL_CUT_NOTE.length) : largest.text;
      largest.text = body.slice(0, Math.max(largest.min ?? 0, body.length - cut)) + MATERIAL_CUT_NOTE;
    } else {
      const body = largest.text.startsWith(DOCUMENT_CUT_NOTE) ? largest.text.slice(DOCUMENT_CUT_NOTE.length) : largest.text;
      largest.text = DOCUMENT_CUT_NOTE + body.slice(Math.min(cut, body.length - (largest.min ?? 0)));
    }
    total = totalBytes(turns);
  }
  if (total > budget) {
    throw new LlmError(
      'This request is too large for the artifact runtime (64 KB of text per call). Remove some materials, shorten the conversation or split the task.',
      { provider: 'artifact', model, status: 413 },
    );
  }
  return turns.map((turn) => ({ role: turn.role, content: turnText(turn) })).filter((turn) => turn.content.length > 0);
}

/** Builds the turn list (instructions first, ending on a user turn) and collects the images to attach. */
export function assembleInput(
  request: LlmRequest,
  limits: SampleLimits,
  mode: { emulateTools: boolean },
  model: string,
): { input: SampleMessage[]; images: Blob[] } {
  const images: Blob[] = [];
  const tools = request.tools ?? [];
  const instructions = request.system + (mode.emulateTools && tools.length ? toolProtocol(tools) : '') + jsonInstruction(request);
  const turns: Turn[] = [{ role: 'user', parts: [{ text: instructions }], droppable: false }];
  request.messages.forEach((message, index) => {
    const last = index === request.messages.length - 1;
    if (message.role === 'user') {
      const { parts, hasMaterials } = userParts(message, request.messages, images, limits);
      if (parts.length) turns.push({ role: 'user', parts, droppable: !hasMaterials && !last });
    } else {
      const parts = assistantParts(message);
      if (parts.length) turns.push({ role: 'assistant', parts, droppable: !parts.some((p) => p.shrink) && !last });
    }
  });
  if (turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', parts: [{ text: 'Continue.' }], droppable: false });
  if (images.length) {
    const final = turns[turns.length - 1];
    final.parts.unshift({ text: `(The ${images.length} attached image${images.length === 1 ? ' is' : 's are'} the one${images.length === 1 ? '' : 's'} marked [Image 1${images.length === 1 ? '' : `…${images.length}`}] in the materials, in order.)` });
  }
  const budget = Math.max(8_192, (limits.maxPromptBytes || DEFAULT_MAX_PROMPT_BYTES) - BUDGET_MARGIN);
  return { input: fitToBudget(turns, budget, model), images };
}

// ---------------------------------------------------------------------------
// Tools offered to the runtime
// ---------------------------------------------------------------------------

function stripDescriptions(value: unknown, keepTopLevel: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => stripDescriptions(v, false));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'description' && !keepTopLevel) continue;
    if (key === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(v as Record<string, unknown>)) props[name] = stripDescriptions(schema, keepTopLevel);
      out[key] = props;
    } else out[key] = stripDescriptions(v, false);
  }
  return out;
}

/** Keeps a tool schema within the runtime's 4 KB, dropping nested descriptions first and then all of them. */
export function fitToolSchema(schema: Anthropic.Tool['input_schema']): SampleTool['inputSchema'] {
  const candidates = [schema, stripDescriptions(schema, true), stripDescriptions(schema, false)];
  for (const candidate of candidates) {
    if (JSON.stringify(candidate).length <= MAX_TOOL_SCHEMA) return candidate as SampleTool['inputSchema'];
  }
  return candidates[2] as SampleTool['inputSchema'];
}

let toolCounter = 0;
function newToolUseId(): string {
  toolCounter += 1;
  return `toolu_artifact_${Date.now().toString(36)}_${toolCounter}`;
}

function toolUseBlock(name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id: newToolUseId(), name, input, caller: { type: 'direct' } } as Anthropic.ToolUseBlock;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function isSampleError(err: unknown): err is SampleError {
  return Boolean(err) && typeof err === 'object' && typeof (err as SampleError).code === 'string';
}

function describeSampleError(err: SampleError, model: string): LlmError {
  const make = (message: string, status?: number) => new LlmError(message, { provider: 'artifact', model, status, cause: err });
  switch (err.code) {
    case 'not_granted':
      return make('Model access was not allowed for this page. Reload the artifact and allow it when asked.', 403);
    case 'sampling_disabled':
      return make('Model access is not available for this account or organization.', 403);
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
      return make('This artifact cannot reach the model in this view. Open it from its artifact link and try again.', 403);
    case 'session_expired':
      return make('Your session expired. Sign in again and retry.', 401);
    case 'rate_limited':
      return make('Your usage limit was reached, or too many requests are running at once. Wait a little and try again.', 429);
    case 'prompt_too_large':
      return make('This request is too large for the artifact runtime (64 KB of text per call). Remove some materials or shorten the conversation.', 413);
    case 'cancelled':
      return make('The request was stopped.');
    case 'upstream_error':
      return make('The answer was interrupted by a connection or service problem. Please try again.', 502);
    default:
      return make(`The artifact runtime rejected the request (${err.code}): ${err.message}`, 400);
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ArtifactSampleClient implements LlmClient {
  private sample: Promise<SampleFunction | null> | null = null;
  private limits: Promise<SampleLimits> | null = null;

  constructor(private readonly options: ArtifactSampleOptions) {}

  private async runtime(model: string): Promise<{ sample: SampleFunction; limits: SampleLimits }> {
    this.sample ??= this.options.resolve().catch(() => null);
    const sample = await this.sample;
    if (!sample) {
      throw new LlmError('Model access is not available in this view. Open this page as an artifact and allow it when asked.', {
        provider: 'artifact',
        model,
      });
    }
    this.limits ??= sample.limits().catch(() => ({ maxPromptBytes: DEFAULT_MAX_PROMPT_BYTES }));
    return { sample, limits: await this.limits };
  }

  async stream(request: LlmRequest, handlers: LlmHandlers, signal?: AbortSignal): Promise<LlmMessage> {
    const requested = Array.isArray(request.model) ? (request.model[0] ?? '') : request.model;
    const tier: ArtifactTier = isArtifactTier(requested) ? requested : 'default';
    const model = tier;
    const { sample, limits } = await this.runtime(model);
    const tools = request.outputSchema ? [] : (request.tools ?? []);
    const nativeTools = tools.length > 0 && Boolean(limits.tools);
    const emulateTools = tools.length > 0 && !limits.tools;
    const base = (): LlmMessage => ({ provider: 'artifact', model, ref: `artifact/${model}`, content: [], stop_reason: 'end_turn', usage: emptyLlmUsage() });
    const message = (content: Anthropic.ContentBlock[], stop: StopReason | null, details?: LlmMessage['stop_details']): LlmMessage => ({
      ...base(),
      content,
      stop_reason: stop,
      stop_details: details,
    });
    const text = (value: string): Anthropic.TextBlock => ({ type: 'text', text: value, citations: null });

    // JSON output: the runtime parses the reply; the core validates it.
    if (request.outputSchema) {
      const { input, images } = assembleInput(request, limits, { emulateTools: false }, model);
      try {
        const value = await sample.json(input, { signal, modelTier: tier, cache: false, images: images.length ? images : undefined });
        return message([text(JSON.stringify(value))], 'end_turn');
      } catch (err) {
        if (isSampleError(err) && err.code === 'invalid_json') return message(err.text ? [text(err.text)] : [], 'end_turn');
        throw this.failure(err, model, signal);
      }
    }

    const { input, images } = assembleInput(request, limits, { emulateTools }, model);
    const turns = [...input];
    const recorded: Anthropic.ToolUseBlock[] = [];
    let forwarded = 0;
    let visible = '';
    /** Streams the part of `whole` not yet shown; in the emulated protocol, holds text that may still become a tool call. */
    const forward = (whole: string, final: boolean) => {
      if (emulateTools && !final && mayBeToolCall(whole)) return;
      if (emulateTools && final && parseToolCall(whole)) return;
      if (whole.length > forwarded) {
        const delta = whole.slice(forwarded);
        forwarded = whole.length;
        visible += delta;
        handlers.onText?.(delta);
      }
    };

    const runtimeTools: SampleTool[] | undefined = nativeTools
      ? tools.map((tool) => ({
          name: tool.name,
          description: (tool.description ?? '').slice(0, MAX_TOOL_DESCRIPTION),
          inputSchema: fitToolSchema(tool.input_schema),
          execute: async (rawInput) => {
            const inputObject = rawInput && typeof rawInput === 'object' ? rawInput : {};
            const block = toolUseBlock(tool.name, inputObject);
            handlers.onToolStart?.(tool.name);
            if (!handlers.executeTool) {
              recorded.push(block);
              return RECORDED_RESULT;
            }
            const result = await handlers.executeTool(block);
            const summary = toolResultText(result.content) || (result.is_error ? 'Error' : 'Done');
            if (result.is_error) throw new Error(summary);
            return summary;
          },
        }))
      : undefined;

    let truncated = false;
    for (let round = 0; round < MAX_EMULATED_ROUNDS; round++) {
      let result: SampleResult;
      forwarded = 0;
      try {
        result = await sample(turns, {
          signal,
          modelTier: tier,
          cache: false,
          images: images.length && round === 0 ? images : undefined,
          tools: runtimeTools,
          onText: (update) => forward(update.text, false),
        });
      } catch (err) {
        if (isSampleError(err)) {
          if (err.code === 'refused') return message(visible ? [text(visible)] : [], 'refusal', { explanation: err.message });
          if (err.code === 'empty_completion') return message([], 'end_turn');
        }
        throw this.failure(err, model, signal);
      }
      truncated = result.truncated;
      const call = emulateTools ? parseToolCall(result.text) : null;
      if (!call) {
        forward(result.text, true);
        break;
      }
      // The reply was a tool call in the JSON protocol.
      const block = toolUseBlock(call.name, call.input);
      handlers.onToolStart?.(call.name);
      if (!handlers.executeTool) {
        recorded.push(block);
        break;
      }
      const outcome = await handlers.executeTool(block);
      const summary = toolResultText(outcome.content) || (outcome.is_error ? 'Error' : 'Done');
      turns.push(
        { role: 'assistant', content: result.text.trim() },
        { role: 'user', content: `Tool result (${call.name})${outcome.is_error ? ' — error' : ''}: ${summary}` },
      );
      if (visible.trim() && !visible.endsWith('\n\n')) {
        visible += '\n\n';
        handlers.onText?.('\n\n');
      }
    }

    const content: Anthropic.ContentBlock[] = [];
    if (visible.trim()) content.push(text(visible));
    content.push(...recorded);
    const stop: StopReason = recorded.length ? 'tool_use' : truncated ? 'max_tokens' : 'end_turn';
    return message(content, stop);
  }

  private failure(err: unknown, model: string, signal?: AbortSignal): Error {
    if (signal?.aborted) return err instanceof Error ? err : new LlmError('The request was stopped.', { provider: 'artifact', model, cause: err });
    if (isSampleError(err)) return describeSampleError(err, model);
    if (err instanceof Error) return err;
    return new LlmError(String(err), { provider: 'artifact', model });
  }
}
