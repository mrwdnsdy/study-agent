export interface TocEntry {
  level: number;
  text: string;
  id: string;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

/** Headings (levels 1-3) with the same ids the Markdown renderer assigns. */
export function tableOfContents(markdown: string, maxLevel = 3): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING_RE.exec(line);
    if (!match) continue;
    const level = match[1].length;
    if (level > maxLevel) continue;
    const text = match[2].replace(/[*_`]/g, '').trim();
    entries.push({ level, text, id: uniqueSlug(text, seen) });
  }
  return entries;
}

export function uniqueSlug(text: string, seen: Map<string, number>): string {
  const base = slugify(text) || 'section';
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}
