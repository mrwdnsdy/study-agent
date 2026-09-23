/**
 * Finishing what the agent starts. A document or reply that is cut off by the
 * length limit, a stream that ends early or a dropped connection is continued
 * from a safe point without repeating or garbling what the student has already
 * seen. When it cannot be finished, the partial result travels back to the
 * caller inside PartialDocumentError / PartialReplyError so it can be saved.
 */
import type { StudyGuide, ToolEvent, UsageInfo } from '../types.js';
import { LlmError, transientKind, type LlmMessage } from './llm.js';

/** Why a continuation is needed: the length limit, a cut-off answer, or an answer stopped for quoting its source. */
export type ContinueReason = 'length' | 'interrupted' | 'recitation';

/** How much of the draft's end the continue prompt quotes. */
export const TAIL_CHARS = 300;
/** How much of a continuation is held back until a preamble line and repeated text can be removed. */
export const HOLD_CHARS = 600;
const MIN_OVERLAP = 20;
const MAX_OVERLAP = 600;

/** Waits before the first, second and third automatic resume. */
const RESUME_BACKOFF_MS = [2_000, 6_000, 15_000];
const MAX_RESUME_WAIT_MS = 45_000;

/** The user turn that asks the model to carry on from the end of its previous answer. */
export function continuePrompt(reason: ContinueReason, tail: string): string {
  switch (reason) {
    case 'length':
      return 'Your response was cut off by the length limit. Continue exactly where you stopped, without repeating anything already written and without any preamble.';
    case 'recitation':
      return `Your previous response stopped because it was reproducing the source material too closely. It ended with:\n«…${tail}»\nContinue from that point, explaining the remaining material in your own words instead of quoting the slides or notes verbatim. No preamble.`;
    default:
      return `Your previous response was interrupted by a connection problem. It ended with:\n«…${tail}»\nContinue exactly from that point, without repeating anything already written and without any preamble.`;
  }
}

/** Whether an answer that ended without an error still needs a continuation, and why. */
export function continuationReason(message: Pick<LlmMessage, 'stop_reason' | 'stop_details'>): ContinueReason | null {
  if (message.stop_reason === 'max_tokens') return 'length';
  if (message.stop_reason === 'pause_turn') return message.stop_details?.explanation === 'recitation' ? 'recitation' : 'interrupted';
  return null;
}

/** A fence line (``` or ~~~), also indented or inside a blockquote. */
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/;

/** Offset of the line that opens a fenced block still open at the end of `text`, or -1. */
function unclosedFenceStart(text: string): number {
  let open: { char: string; length: number; start: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (match) {
      const marker = match[1];
      if (!open) open = { char: marker[0], length: marker.length, start: offset };
      else if (marker[0] === open.char && marker.length >= open.length && !line.slice(match[0].length).trim()) open = null;
    }
    offset += line.length + 1;
  }
  return open ? open.start : -1;
}

/**
 * Cuts a draft back to a point a continuation can safely start from: the end of
 * the last complete line, and before any code fence (a Mermaid diagram, say) that
 * is still open there, so the model rewrites that block whole instead of resuming
 * in the middle of it.
 */
export function trimToSafeBoundary(draft: string): string {
  const complete = draft.slice(0, draft.lastIndexOf('\n') + 1);
  const fence = unclosedFenceStart(complete);
  return fence === -1 ? complete : complete.slice(0, fence);
}

/** "Sure, continuing:" and the like: one short opening line that is not part of the document. */
const PREAMBLE = /^\s*(?:sure|okay|ok|certainly|continuing|here(?:'s| is)(?: the)? continuation)\b[^\n]{0,120}\n/i;

/**
 * The part of a continuation's opening to append to `draft`: without a leading
 * preamble line, and without the longest stretch (20 to 600 characters) that
 * repeats the end of the draft.
 */
export function joinContinuation(draft: string, head: string): string {
  const text = head.replace(PREAMBLE, '');
  for (let k = Math.min(MAX_OVERLAP, draft.length, text.length); k >= MIN_OVERLAP; k--) {
    if (draft.endsWith(text.slice(0, k))) return text.slice(k);
  }
  return text;
}

/**
 * Passes a segment's text deltas to `forward`. For a continuation it first holds
 * back HOLD_CHARS characters and forwards them joined (see joinContinuation), so
 * what `forward` receives is exactly what belongs after the draft.
 */
export class ContinuationJoiner {
  private held = '';
  private holding: boolean;

  constructor(
    private readonly draft: string,
    private readonly forward: (text: string) => void,
    hold = true,
  ) {
    this.holding = hold;
  }

  push(delta: string): void {
    if (!this.holding) {
      if (delta) this.forward(delta);
      return;
    }
    this.held += delta;
    if (this.held.length >= HOLD_CHARS) this.release();
  }

  /** Forwards whatever is still held back: at the end of the segment, or when it failed. */
  release(): void {
    if (!this.holding) return;
    this.holding = false;
    const text = joinContinuation(this.draft, this.held);
    this.held = '';
    if (text) this.forward(text);
  }
}

/** Wait before resume number `attempt` (0-based): the backoff step, or longer when the provider asked for it. */
export function resumeDelay(attempt: number, err: unknown): number {
  const step = RESUME_BACKOFF_MS[Math.min(attempt, RESUME_BACKOFF_MS.length - 1)];
  const asked = err instanceof LlmError && err.retryAfterMs ? err.retryAfterMs : 0;
  return Math.min(MAX_RESUME_WAIT_MS, Math.max(step, asked));
}

// ---------------------------------------------------------------------------
// Partial results
// ---------------------------------------------------------------------------

/** Why a document or reply ended unfinished. */
export type PartialReason = 'stopped' | 'interrupted' | 'refused' | 'failed';

/** A short neutral phrase for the UI: never names a provider or model. */
export function stoppedReasonPhrase(reason: PartialReason, cause?: unknown): string {
  if (reason === 'stopped') return 'stopped by you';
  if (reason === 'refused') return 'safety filter';
  const kind = cause instanceof LlmError && cause.kind === 'daily_quota' ? 'daily_quota' : transientKind(cause);
  if (kind === 'daily_quota') return 'the free limit was reached';
  if (kind === 'rate_limit' || kind === 'overloaded') return 'the service was busy';
  return reason === 'interrupted' || kind ? 'connection problem' : 'service error';
}

export interface DocumentPart {
  markdown: string;
  thinking: string;
  usage: UsageInfo;
  /** Model that wrote the last of the text. */
  model: string;
}

/** A study guide or review stopped before it was finished; `markdown` is everything the student saw. */
export class PartialDocumentError extends Error {
  readonly markdown: string;
  readonly thinking: string;
  readonly usage: UsageInfo;
  readonly model: string;
  readonly reason: PartialReason;
  /** Neutral phrase for the UI, e.g. "connection problem". */
  readonly stoppedReason: string;

  constructor(reason: PartialReason, part: DocumentPart, cause?: unknown) {
    const stoppedReason = stoppedReasonPhrase(reason, cause);
    super(`The document stopped partway (${stoppedReason}).`, cause === undefined ? undefined : { cause });
    this.name = 'PartialDocumentError';
    this.markdown = part.markdown;
    this.thinking = part.thinking;
    this.usage = part.usage;
    this.model = part.model;
    this.reason = reason;
    this.stoppedReason = stoppedReason;
  }
}

export interface ReplyPart {
  text: string;
  thinking: string;
  toolEvents: ToolEvent[];
  usage: UsageInfo;
}

/** A chat reply stopped before it was finished; its text and tool events are what the student saw. */
export class PartialReplyError extends Error {
  readonly text: string;
  readonly thinking: string;
  readonly toolEvents: ToolEvent[];
  readonly usage: UsageInfo;
  readonly reason: PartialReason;
  readonly stoppedReason: string;

  constructor(reason: PartialReason, part: ReplyPart, cause?: unknown) {
    const stoppedReason = stoppedReasonPhrase(reason, cause);
    super(`The reply was cut off (${stoppedReason}).`, cause === undefined ? undefined : { cause });
    this.name = 'PartialReplyError';
    this.text = part.text;
    this.thinking = part.thinking;
    this.toolEvents = part.toolEvents;
    this.usage = part.usage;
    this.reason = reason;
    this.stoppedReason = stoppedReason;
  }
}

/** The longer of two drafts: a continuation that failed before adding anything must not lose the saved text. */
export function longerDraft(saved: string | undefined, next: string): string {
  return saved && saved.trim().length > next.trim().length ? saved : next;
}

/** The guide to save when writing stopped partway (`previous`: the partial guide a continuation started from). */
export function partialGuide(
  err: PartialDocumentError,
  base: { version: number; prompt: string; updatedAt: string; previous?: StudyGuide | null },
): StudyGuide {
  const markdown = longerDraft(base.previous?.markdown, err.markdown);
  return {
    markdown,
    version: base.version,
    updatedAt: base.updatedAt,
    prompt: base.prompt,
    model: markdown === err.markdown ? err.model : (base.previous?.model ?? err.model),
    incomplete: true,
    stoppedReason: err.stoppedReason,
  };
}

/** The chat note posted when a study guide stopped partway and was saved. */
export function guidePartialMessage(version: number, words: number, agentName: string, reason: string): string {
  return `📘 Study guide v${version} is partly written (about ${words.toLocaleString()} words) — ${agentName} stopped early (${reason}). Press **Continue writing** in the Study Guide tab to finish it.`;
}

/** The error shown once a partly written guide or review has been saved. */
export function partialSavedMessage(agentName: string, reason: string): string {
  return `${agentName} stopped partway (${reason}). What it wrote is saved — press Continue writing to finish it.`;
}

/** The error shown once a cut-off chat reply has been saved. */
export function replyCutOffMessage(agentName: string): string {
  return `${agentName}'s reply was cut off — tap Continue to let it finish.`;
}
