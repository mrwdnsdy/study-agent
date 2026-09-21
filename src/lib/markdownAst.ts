/**
 * Shared Markdown (mdast) helpers used by both the DOCX and HTML exporters, so
 * the two outputs parse, classify and flatten the same constructs identically.
 */
import type { Blockquote, Code, Image, ImageReference, Node, Parent, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** Parse GFM markdown (tables, task lists, strikethrough, footnotes) into an mdast tree. */
export function parseMarkdown(markdown: string): Root {
  const normalised = String(markdown ?? '').replace(/\r\n?/g, '\n');
  return unified().use(remarkParse).use(remarkGfm).parse(normalised) as Root;
}

export type CalloutKind = 'tip' | 'pitfall' | 'exam' | 'key' | 'practice' | 'memory' | 'note';

export interface CalloutInfo {
  kind: CalloutKind;
  /** Human-readable label without emoji or trailing colon, e.g. "Gold-standard tip". */
  label: string;
  /** Accent colour for borders and labels (hex, with leading '#'). */
  color: string;
  /** Background tint (hex, with leading '#'). */
  background: string;
}

export interface CalloutStyle {
  label: string;
  emoji: string;
  color: string;
  background: string;
}

/** Visual identity of each callout kind. Shared by both exporters. */
export const CALLOUT_STYLES: Readonly<Record<CalloutKind, CalloutStyle>> = {
  tip: { label: 'Tip', emoji: '💡', color: '#16a34a', background: '#f0fdf4' },
  pitfall: { label: 'Common pitfall', emoji: '⚠️', color: '#d97706', background: '#fffbeb' },
  exam: { label: 'Exam alert', emoji: '📌', color: '#e11d48', background: '#fff1f2' },
  key: { label: 'Key concept', emoji: '🔑', color: '#4f46e5', background: '#eef2ff' },
  practice: { label: 'Best practice', emoji: '✅', color: '#0d9488', background: '#f0fdfa' },
  memory: { label: 'Memory aid', emoji: '🧠', color: '#9333ea', background: '#faf5ff' },
  note: { label: 'Note', emoji: '📝', color: '#64748b', background: '#f8fafc' },
};

/** Leading emoji that identify a callout kind (checked before any keyword). */
const EMOJI_KINDS: ReadonlyArray<readonly [string, CalloutKind]> = [
  ['💡', 'tip'],
  ['🌟', 'tip'],
  ['⭐', 'tip'],
  ['✨', 'tip'],
  ['⚠', 'pitfall'],
  ['🚫', 'pitfall'],
  ['❗', 'pitfall'],
  ['🛑', 'pitfall'],
  ['❌', 'pitfall'],
  ['📌', 'exam'],
  ['🎯', 'exam'],
  ['🚨', 'exam'],
  ['📢', 'exam'],
  ['🔑', 'key'],
  ['🗝', 'key'],
  ['✅', 'practice'],
  ['☑', 'practice'],
  ['👍', 'practice'],
  ['🧠', 'memory'],
  ['🧩', 'memory'],
  ['📝', 'note'],
  ['ℹ', 'note'],
  ['📖', 'note'],
  ['📚', 'note'],
  ['🔍', 'note'],
];

/** Keywords matched anywhere inside an explicit "Label:" prefix, most specific first. */
const LABEL_RULES: ReadonlyArray<readonly [RegExp, CalloutKind]> = [
  [/\bbest[\s-]*practices?\b/i, 'practice'],
  [/\b(?:pitfalls?|warnings?|caution|gotchas?|beware|danger|mistakes?|anti-?patterns?)\b/i, 'pitfall'],
  [/\b(?:exams?|examination|assessment)\b/i, 'exam'],
  [/\b(?:memory|mnemonic|remember|recall)\b/i, 'memory'],
  [/\b(?:key|core|crucial|essential|definition|takeaways?)\b/i, 'key'],
  [/\b(?:tips?|hint|pro-?tip|trick)\b/i, 'tip'],
  [/\b(?:note|info|important|fyi|nb|reminder|aside)\b/i, 'note'],
];

/** "Starts with" keyword rules used when the text carries no explicit label. */
const PREFIX_RULES: ReadonlyArray<readonly [RegExp, CalloutKind]> = [
  [/^best[\s-]*practices?\b/i, 'practice'],
  [/^(?:common\s+)?pitfalls?\b|^warning\b|^caution\b/i, 'pitfall'],
  [/^exam\b/i, 'exam'],
  [/^key\b/i, 'key'],
  [/^memory\b|^mnemonic\b/i, 'memory'],
  [/^(?:gold[\s-]*standard\s+|pro\s+)?tips?\b/i, 'tip'],
  [/^note\b|^important\b/i, 'note'],
];

/** Leading pictographs, variation selectors, ZWJ sequences, keycaps and skin tones. */
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️⃣]\s*)+/u;
/** Whitespace and markdown emphasis markers at either end of a string. */
const EDGE_MARKERS = /^[\s*_~`]+|[\s*_~`]+$/g;

function matchRules(
  rules: ReadonlyArray<readonly [RegExp, CalloutKind]>,
  text: string,
): { kind: CalloutKind; matched: string } | null {
  for (const [pattern, kind] of rules) {
    const match = pattern.exec(text);
    if (match) return { kind, matched: match[0] };
  }
  return null;
}

function capitalise(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

/**
 * Decide whether a blockquote whose first line is `firstText` is a callout.
 * Accepts the raw markdown (`**💡 Gold-standard tip:** …`) or the plain text
 * (`💡 Gold-standard tip: …`). Returns null for ordinary quotes.
 */
export function classifyCallout(firstText: string): CalloutInfo | null {
  if (typeof firstText !== 'string') return null;
  const line = firstText.replace(/\r\n?/g, '\n').split('\n')[0].replace(EDGE_MARKERS, '');
  if (!line) return null;

  let kind: CalloutKind | null = null;
  for (const [emoji, emojiKind] of EMOJI_KINDS) {
    if (line.startsWith(emoji)) {
      kind = emojiKind;
      break;
    }
  }

  const text = line.replace(LEADING_EMOJI, '').replace(EDGE_MARKERS, '');

  // An explicit "Label:" prefix (short, before the first colon).
  let label: string | null = null;
  const colon = text.search(/[:：]/);
  if (colon > 0 && colon <= 60) {
    const candidate = text.slice(0, colon).replace(EDGE_MARKERS, '').replace(/\s+/g, ' ');
    if (candidate) label = candidate;
  }

  if (!kind && label) kind = matchRules(LABEL_RULES, label)?.kind ?? null;

  let matchedPrefix: string | null = null;
  if (!kind) {
    const prefix = matchRules(PREFIX_RULES, text);
    if (prefix) {
      kind = prefix.kind;
      matchedPrefix = prefix.matched;
    }
  }
  if (!kind) return null;

  const style = CALLOUT_STYLES[kind];
  const finalLabel = label ?? (matchedPrefix ? capitalise(matchedPrefix) : style.label);
  return { kind, label: finalLabel, color: style.color, background: style.background };
}

/** Classify a blockquote node by the plain text of its first paragraph. */
export function classifyBlockquote(node: Blockquote): CalloutInfo | null {
  const first = node.children[0];
  if (!first || first.type !== 'paragraph') return null;
  return classifyCallout(mdastToPlainText(first));
}

const BLOCK_PARENTS = new Set(['root', 'blockquote', 'list', 'listItem', 'footnoteDefinition', 'table']);

/** Flatten any mdast node to plain text (block children joined with newlines). */
export function mdastToPlainText(node: Node): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return String((node as { value?: unknown }).value ?? '');
    case 'html':
      return stripHtmlTags(String((node as { value?: unknown }).value ?? ''));
    case 'image':
    case 'imageReference':
      return String((node as { alt?: unknown }).alt ?? '');
    case 'break':
      return '\n';
    case 'footnoteReference': {
      const ref = node as { label?: string; identifier?: string };
      return `[${ref.label ?? ref.identifier ?? ''}]`;
    }
    default:
      break;
  }
  const children = (node as Partial<Parent>).children;
  if (!Array.isArray(children)) return '';
  const parts = children.map(mdastToPlainText);
  if (node.type === 'tableRow') return parts.join(' | ');
  if (BLOCK_PARENTS.has(node.type)) return parts.join('\n');
  return parts.join('');
}

/** True for fenced code blocks tagged as mermaid diagrams. */
export function isMermaidCode(node: Code): boolean {
  return /^mermaid$/i.test((node.lang ?? '').trim());
}

/** Every mermaid code block in document order (including nested ones). */
export function collectMermaidBlocks(root: Node): Code[] {
  const out: Code[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'code' && isMermaidCode(node as Code)) out.push(node as Code);
    const children = (node as Partial<Parent>).children;
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  visit(root);
  return out;
}

/** Text shown in place of an image: its alt text, else the file name, else "image". */
export function describeImage(node: Image | ImageReference): string {
  const alt = node.alt?.trim();
  if (alt) return alt;
  if (node.type === 'image') {
    const base = node.url.split(/[?#]/)[0].split('/').pop();
    if (base) return base;
  }
  return 'image';
}

/** True for a lone `<br>` tag. */
export function isHtmlLineBreak(html: string): boolean {
  return /^\s*<br\s*\/?>\s*$/i.test(html);
}

/** Remove tags and comments from raw HTML, decoding the common entities. */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
