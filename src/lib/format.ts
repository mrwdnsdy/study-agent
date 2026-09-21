export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function wordCount(markdown: string): number {
  return (markdown.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((100 * numerator) / denominator);
}

export function titleFromMarkdown(markdown: string, fallback: string): string {
  const match = /^#\s+(.+?)\s*$/m.exec(markdown);
  return match ? match[1].replace(/[*_`]/g, '').trim() : fallback;
}
