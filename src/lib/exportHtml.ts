/**
 * Markdown → standalone HTML exporter. Produces a single self-contained page
 * (inline CSS, system fonts, no external requests) with mermaid diagrams
 * inlined as SVG and print styles so "Print → Save as PDF" looks good.
 */
import type * as Md from 'mdast';
import {
  CALLOUT_STYLES,
  classifyBlockquote,
  collectMermaidBlocks,
  describeImage,
  isHtmlLineBreak,
  isMermaidCode,
  mdastToPlainText,
  parseMarkdown,
  stripHtmlTags,
  type CalloutKind,
} from './markdownAst';

export interface HtmlExportOptions {
  title: string;
  subtitle?: string;
  /**
   * Renders a mermaid diagram to an SVG string. Defaults to `renderMermaidSvg`
   * from ./mermaid (lazy-imported). Return null to show the source instead.
   */
  renderSvg?: (code: string) => Promise<string | null>;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use inside an element or a double-quoted attribute. */
function esc(text: string): string {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Allow http(s), mailto, in-page anchors and relative paths; drop script-ish schemes. */
function safeHref(url: string): string | null {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // javascript:, data:, vbscript:, …
  return trimmed; // '#anchor', 'relative/path'
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/[\s-]+/g, '-')
      .slice(0, 80) || 'section'
  );
}

function looksLikeSvg(svg: unknown): svg is string {
  return typeof svg === 'string' && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg);
}

interface RenderOptions {
  /** Colour the leading "Label:" of a callout's first paragraph. */
  label?: boolean;
}

class HtmlRenderer {
  private readonly slugCounts = new Map<string, number>();

  constructor(private readonly diagrams: ReadonlyMap<Md.Code, string | null>) {}

  blocks(nodes: readonly Md.RootContent[], options: RenderOptions = {}): string {
    return nodes
      .map((node, index) => this.block(node, index === 0 ? options : {}))
      .filter((html) => html.length > 0)
      .join('\n');
  }

  private block(node: Md.RootContent, options: RenderOptions = {}): string {
    try {
      switch (node.type) {
        case 'heading':
          return this.heading(node);
        case 'paragraph':
          return this.paragraph(node, options);
        case 'list':
          return this.list(node);
        case 'code':
          return isMermaidCode(node) ? this.diagram(node) : this.codeBlock(node.value, node.lang ?? undefined);
        case 'blockquote':
          return this.blockquote(node);
        case 'table':
          return this.table(node);
        case 'thematicBreak':
          return '<hr>';
        case 'html': {
          const text = stripHtmlTags(node.value).replace(/\s+/g, ' ').trim();
          return text ? `<p>${esc(text)}</p>` : '';
        }
        case 'footnoteDefinition':
          return `<div class="footnote" id="fn-${esc(slugify(node.identifier))}"><sup>[${esc(node.label ?? node.identifier)}]</sup> ${this.blocks(node.children)}</div>`;
        default:
          return '';
      }
    } catch (error) {
      console.warn(`[exportHtml] skipped ${node.type} node`, error);
      return '';
    }
  }

  private uniqueSlug(text: string): string {
    const base = slugify(text);
    const count = this.slugCounts.get(base) ?? 0;
    this.slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }

  private inline(nodes: readonly Md.PhrasingContent[]): string {
    return nodes.map((node) => this.phrasing(node)).join('');
  }

  private phrasing(node: Md.PhrasingContent): string {
    switch (node.type) {
      case 'text':
        return esc(node.value);
      case 'strong':
        return `<strong>${this.inline(node.children)}</strong>`;
      case 'emphasis':
        return `<em>${this.inline(node.children)}</em>`;
      case 'delete':
        return `<del>${this.inline(node.children)}</del>`;
      case 'inlineCode':
        return `<code>${esc(node.value)}</code>`;
      case 'break':
        return '<br>\n';
      case 'link': {
        const href = safeHref(node.url);
        const inner = this.inline(node.children);
        if (!href) return inner;
        const external = /^(?:https?:|mailto:|tel:)/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        const title = node.title ? ` title="${esc(node.title)}"` : '';
        return `<a href="${esc(href)}"${external}${title}>${inner}</a>`;
      }
      case 'linkReference':
        return this.inline(node.children);
      case 'image':
      case 'imageReference':
        return `<em class="image-alt">${esc(describeImage(node))}</em>`;
      case 'footnoteReference':
        return `<sup class="footnote-ref"><a href="#fn-${esc(slugify(node.identifier))}">[${esc(node.label ?? node.identifier)}]</a></sup>`;
      case 'html':
        return isHtmlLineBreak(node.value) ? '<br>\n' : '';
      default:
        return '';
    }
  }

  /** Inline content where the leading "Label:" (bold or plain) is wrapped as the callout label. */
  private inlineWithLabel(nodes: readonly Md.PhrasingContent[]): string {
    const first = nodes[0];
    if (first?.type === 'strong') {
      return `<strong class="callout-label">${this.inline(first.children)}</strong>${this.inline(nodes.slice(1))}`;
    }
    if (first?.type === 'text') {
      const match = /^(\s*[^:\n]{1,60}:)([\s\S]*)$/.exec(first.value);
      if (match) {
        const rest: Md.Text = { type: 'text', value: match[2] };
        return `<strong class="callout-label">${esc(match[1].trimStart())}</strong>${this.inline([rest, ...nodes.slice(1)])}`;
      }
    }
    return this.inline(nodes);
  }

  private heading(node: Md.Heading): string {
    const depth = Math.min(Math.max(node.depth, 1), 6);
    const id = this.uniqueSlug(mdastToPlainText(node));
    return `<h${depth} id="${esc(id)}">${this.inline(node.children)}</h${depth}>`;
  }

  private paragraph(node: Md.Paragraph, options: RenderOptions): string {
    const inner = options.label ? this.inlineWithLabel(node.children) : this.inline(node.children);
    if (!inner.trim()) return '';
    const imageOnly = node.children.every(
      (child) =>
        child.type === 'image' || child.type === 'imageReference' || (child.type === 'text' && child.value.trim() === ''),
    );
    return imageOnly ? `<p class="figure-alt">${inner}</p>` : `<p>${inner}</p>`;
  }

  private list(node: Md.List): string {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : '';
    const items = node.children
      .filter((item): item is Md.ListItem => item.type === 'listItem')
      .map((item) => this.listItem(item, !node.spread && !item.spread))
      .join('\n');
    return `<${tag}${start}>\n${items}\n</${tag}>`;
  }

  private listItem(item: Md.ListItem, tight: boolean): string {
    const parts = item.children
      .map((child) => (tight && child.type === 'paragraph' ? this.inline(child.children) : this.block(child)))
      .filter((html) => html.length > 0);
    if (typeof item.checked !== 'boolean') return `<li>${parts.join('\n')}</li>`;
    const box = `<input type="checkbox" disabled${item.checked ? ' checked' : ''}>`;
    // Keep the checkbox on the same line as the item's first paragraph.
    if (parts.length && parts[0].startsWith('<p>')) parts[0] = `<p>${box} ${parts[0].slice(3)}`;
    else parts.unshift(box);
    return `<li class="task">${parts.join(' ')}</li>`;
  }

  private codeBlock(source: string, lang?: string): string {
    const language = (lang ?? '').trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '');
    const attrs = language ? ` data-lang="${esc(language)}"` : '';
    const cls = language ? ` class="language-${esc(language)}"` : '';
    return `<pre class="code"${attrs}><code${cls}>${esc(source)}</code></pre>`;
  }

  private diagram(node: Md.Code): string {
    const svg = this.diagrams.get(node);
    if (svg) return `<figure class="diagram">${svg}</figure>`;
    return `<p class="diagram-fallback"><em>Diagram (mermaid source):</em></p>\n${this.codeBlock(node.value, 'mermaid')}`;
  }

  private blockquote(node: Md.Blockquote): string {
    const callout = classifyBlockquote(node);
    if (!callout) return `<blockquote>\n${this.blocks(node.children)}\n</blockquote>`;
    const body = this.blocks(node.children, { label: true });
    return `<aside class="callout callout-${callout.kind}" role="note" aria-label="${esc(callout.label)}">\n<div class="callout-body">\n${body}\n</div>\n</aside>`;
  }

  private table(node: Md.Table): string {
    const rows = node.children.filter((row): row is Md.TableRow => row.type === 'tableRow');
    if (rows.length === 0) return '';
    const columns = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
    const aligns = node.align ?? [];
    const cell = (row: Md.TableRow, c: number, tag: 'th' | 'td'): string => {
      const align = aligns[c];
      const style = align === 'center' || align === 'right' ? ` style="text-align:${align}"` : '';
      const content = row.children[c] ? this.inline(row.children[c].children) : '';
      return `<${tag}${style}>${content}</${tag}>`;
    };
    const renderRow = (row: Md.TableRow, tag: 'th' | 'td'): string =>
      `<tr>${Array.from({ length: columns }, (_, c) => cell(row, c, tag)).join('')}</tr>`;
    const head = `<thead>\n${renderRow(rows[0], 'th')}\n</thead>`;
    const bodyRows = rows.slice(1).map((row) => renderRow(row, 'td'));
    const body = bodyRows.length ? `\n<tbody>\n${bodyRows.join('\n')}\n</tbody>` : '';
    return `<div class="table-wrap">\n<table>\n${head}${body}\n</table>\n</div>`;
  }
}

// ---------------------------------------------------------------------------
// Page template
// ---------------------------------------------------------------------------
function calloutCss(): string {
  return (Object.keys(CALLOUT_STYLES) as CalloutKind[])
    .map((kind) => {
      const style = CALLOUT_STYLES[kind];
      return `.callout-${kind} { --callout: ${style.color}; --callout-bg: ${style.background}; }`;
    })
    .join('\n');
}

const BASE_CSS = `
:root { color-scheme: light; --ink: #1f2937; --muted: #64748b; --indigo-900: #3730a3; --indigo-700: #4338ca; --slate-800: #1e293b; --rule: #e2e8f0; --code-bg: #f1f5f9; --table-head: #e0e7ff; --link: #2563eb; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f1f5f9; color: var(--ink); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"; overflow-wrap: break-word; }
.doc { max-width: 54rem; margin: 0 auto; padding: 2.5rem 16px 4rem; background: #fff; }
@media (min-width: 60rem) {
  body { padding: 2rem 0; }
  .doc { padding: 3.5rem 4rem 5rem; border-radius: 12px; box-shadow: 0 1px 3px rgba(15, 23, 42, .08), 0 12px 32px -12px rgba(15, 23, 42, .15); }
}
.doc-header { border-bottom: 3px solid var(--indigo-900); margin-bottom: 2rem; padding-bottom: 1.25rem; }
.doc-title { font-size: 2.25rem; line-height: 1.15; margin: 0 0 .5rem; color: var(--indigo-900); letter-spacing: -.01em; border: 0; padding: 0; }
.doc-subtitle { font-size: 1.15rem; color: var(--muted); margin: 0 0 .5rem; }
.doc-meta { font-size: .9rem; color: var(--muted); margin: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2.2em 0 .6em; font-weight: 700; scroll-margin-top: 1rem; }
h1 { font-size: 1.9rem; color: var(--indigo-900); border-bottom: 2px solid #c7d2fe; padding-bottom: .3em; }
h2 { font-size: 1.45rem; color: var(--indigo-700); }
h3 { font-size: 1.15rem; color: var(--slate-800); }
h4 { font-size: 1.02rem; color: #334155; font-style: italic; }
h5, h6 { font-size: 1rem; color: #334155; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
p { margin: 0 0 1em; }
a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
strong { font-weight: 700; color: #111827; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
code { font-size: .875em; background: #eef2ff; color: #3730a3; padding: .12em .35em; border-radius: 4px; }
pre.code { position: relative; background: var(--code-bg); border: 1px solid var(--rule); border-radius: 8px; padding: .9rem 1rem; margin: 0 0 1.25em; overflow-x: auto; font-size: .85rem; line-height: 1.55; white-space: pre; }
pre.code code { background: none; color: #0f172a; padding: 0; font-size: inherit; }
pre.code[data-lang]::before { content: attr(data-lang); position: absolute; top: .35rem; right: .6rem; font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
ul, ol { margin: 0 0 1em; padding-left: 1.6em; }
li { margin: .25em 0; }
li > ul, li > ol { margin: .25em 0 0; }
li.task { list-style: none; margin-left: -1.4em; }
li.task input { margin: 0 .4em 0 0; vertical-align: middle; }
hr { border: 0; border-top: 1px solid #cbd5e1; margin: 2rem 0; }
blockquote { margin: 0 0 1.25em; padding: .25em 1.1em; border-left: 4px solid #cbd5e1; color: #475569; font-style: italic; }
blockquote > :last-child { margin-bottom: 0; }
.callout { margin: 0 0 1.25em; padding: .85rem 1.1rem; border-left: 4px solid var(--callout, #64748b); background: var(--callout-bg, #f8fafc); border-radius: 0 8px 8px 0; }
.callout-body > :last-child { margin-bottom: 0; }
.callout-label { color: var(--callout, inherit); }
.table-wrap { overflow-x: auto; margin: 0 0 1.25em; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { border: 1px solid #cbd5e1; padding: .5em .75em; vertical-align: top; text-align: left; }
th { background: var(--table-head); color: #1e1b4b; font-weight: 700; }
tbody tr:nth-child(even) { background: #f8fafc; }
figure.diagram { margin: 1.5em 0; text-align: center; }
figure.diagram svg { max-width: 100%; height: auto; }
.figure-alt { text-align: center; }
.image-alt { color: var(--muted); }
.diagram-fallback { margin-bottom: .4em; color: var(--muted); }
.footnote { font-size: .9rem; color: #475569; margin: .5em 0; }
.footnote > p { display: inline; }
sup { line-height: 0; }
.doc-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: .85rem; color: var(--muted); }
@page { margin: 18mm 16mm; }
@media print {
  body { background: #fff; padding: 0; font-size: 11pt; }
  .doc { max-width: none; padding: 0; box-shadow: none; border-radius: 0; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid-page; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }
  p, li { orphans: 3; widows: 3; }
  pre.code, table, figure.diagram, .callout, blockquote, tr, li { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  pre.code { white-space: pre-wrap; word-break: break-word; overflow: visible; }
  .table-wrap { overflow: visible; }
  a { color: inherit; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: .8em; color: var(--muted); }
  figure.diagram svg { max-height: 230mm; }
  .doc-footer { display: none; }
}
`;

function formatDate(date: Date): string {
  try {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

async function defaultRenderSvg(code: string): Promise<string | null> {
  try {
    const { renderMermaidSvg } = await import('./mermaid');
    return await renderMermaidSvg(code);
  } catch {
    return null;
  }
}

function normaliseTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Drop a leading H1 that merely repeats the document title (it already sits in the header). */
function bodyNodes(tree: Md.Root, title: string): Md.RootContent[] {
  const first = tree.children[0];
  if (first?.type === 'heading' && first.depth === 1 && normaliseTitle(mdastToPlainText(first)) === normaliseTitle(title)) {
    return tree.children.slice(1);
  }
  return tree.children;
}

/** Convert markdown to a single self-contained HTML document. */
export async function markdownToStandaloneHtml(markdown: string, options: HtmlExportOptions): Promise<string> {
  const title = (options.title ?? '').trim() || 'Study guide';
  const subtitle = options.subtitle?.trim();
  const tree = parseMarkdown(markdown);
  const renderSvg = options.renderSvg ?? defaultRenderSvg;

  const diagrams = new Map<Md.Code, string | null>();
  for (const block of collectMermaidBlocks(tree)) {
    let svg: string | null = null;
    try {
      const rendered = await renderSvg(block.value);
      svg = looksLikeSvg(rendered) ? rendered : null;
    } catch {
      svg = null;
    }
    diagrams.set(block, svg);
  }

  const renderer = new HtmlRenderer(diagrams);
  const body = renderer.blocks(bodyNodes(tree, title));
  const generated = formatDate(new Date());

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Study Agent">',
    `<title>${esc(title)}</title>`,
    `<style>${BASE_CSS}${calloutCss()}\n</style>`,
    '</head>',
    '<body>',
    '<article class="doc">',
    '<header class="doc-header">',
    `<h1 class="doc-title">${esc(title)}</h1>`,
    subtitle ? `<p class="doc-subtitle">${esc(subtitle)}</p>` : '',
    `<p class="doc-meta">Generated ${esc(generated)}</p>`,
    '</header>',
    '<main class="doc-body">',
    body,
    '</main>',
    `<footer class="doc-footer">${esc(title)}${subtitle ? ` · ${esc(subtitle)}` : ''}</footer>`,
    '</article>',
    '</body>',
    '</html>',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}
