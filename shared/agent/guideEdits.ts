/**
 * Pure helpers for editing a Markdown study guide by section. Used by the
 * update_study_guide tool. Headings inside fenced code blocks are ignored.
 */

export type GuideOperation = 'replace_section' | 'append' | 'insert_after_section' | 'replace_all';

export interface HeadingInfo {
  line: number;
  level: number;
  text: string;
}

export interface EditResult {
  ok: boolean;
  markdown: string;
  message: string;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function listHeadings(markdown: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (match) headings.push({ line: i, level: match[1].length, text: match[2].trim() });
  }
  return headings;
}

export function normaliseHeading(text: string): string {
  return text
    .replace(/[*_`~]/g, '')
    .replace(/[\p{Extended_Pictographic}️]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Find the best matching heading: exact, then prefix, then substring match on normalised text. */
export function findHeading(headings: HeadingInfo[], query: string): HeadingInfo | null {
  const q = normaliseHeading(query.replace(/^#+\s*/, ''));
  if (!q) return null;
  const exact = headings.find((h) => normaliseHeading(h.text) === q);
  if (exact) return exact;
  const prefix = headings.find((h) => normaliseHeading(h.text).startsWith(q));
  if (prefix) return prefix;
  const contains = headings.find((h) => normaliseHeading(h.text).includes(q));
  if (contains) return contains;
  const reverse = headings.find((h) => q.includes(normaliseHeading(h.text)) && normaliseHeading(h.text).length > 6);
  return reverse ?? null;
}

/** End line (exclusive) of the section that starts at `heading`. */
function sectionEnd(headings: HeadingInfo[], heading: HeadingInfo, totalLines: number): number {
  const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
  return next ? next.line : totalLines;
}

function ensureHeading(content: string, heading: HeadingInfo): string {
  const trimmed = content.replace(/^\s*\n+/, '').replace(/\s+$/, '');
  const first = trimmed.split('\n')[0] ?? '';
  if (HEADING_RE.test(first)) return trimmed;
  return `${'#'.repeat(heading.level)} ${heading.text}\n\n${trimmed}`;
}

function joinBlocks(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\n+/, '').replace(/\s+$/, ''))
    .filter((p) => p.length > 0)
    .join('\n\n')
    .concat('\n');
}

export function applyGuideEdit(
  markdown: string,
  operation: GuideOperation,
  heading: string,
  content: string,
): EditResult {
  const current = markdown ?? '';
  const trimmedContent = content.trim();
  if (!trimmedContent) return { ok: false, markdown: current, message: 'The markdown content is empty.' };

  if (operation === 'replace_all') {
    return { ok: true, markdown: `${trimmedContent}\n`, message: 'Replaced the whole study guide.' };
  }
  if (operation === 'append') {
    return {
      ok: true,
      markdown: joinBlocks(current, trimmedContent),
      message: 'Appended the new content to the end of the study guide.',
    };
  }

  const lines = current.split('\n');
  const headings = listHeadings(current);
  const target = findHeading(headings, heading);
  if (!target) {
    const available = headings.slice(0, 60).map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n');
    return {
      ok: false,
      markdown: current,
      message: `No section heading matches "${heading}". Available headings:\n${available || '(the guide has no headings)'}`,
    };
  }
  const end = sectionEnd(headings, target, lines.length);
  const before = lines.slice(0, target.line).join('\n');
  const after = lines.slice(end).join('\n');

  if (operation === 'replace_section') {
    const replacement = ensureHeading(trimmedContent, target);
    return {
      ok: true,
      markdown: joinBlocks(before, replacement, after),
      message: `Replaced the section "${target.text}".`,
    };
  }
  // insert_after_section
  const section = lines.slice(target.line, end).join('\n');
  return {
    ok: true,
    markdown: joinBlocks(before, section, trimmedContent, after),
    message: `Inserted new content after the section "${target.text}".`,
  };
}

export function wordCount(markdown: string): number {
  return (markdown.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
