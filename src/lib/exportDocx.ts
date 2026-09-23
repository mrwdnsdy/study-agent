/**
 * Markdown → DOCX exporter. Runs in the browser and in Node (tests).
 *
 * The document is built with `docx` from the mdast tree produced by
 * `parseMarkdown` (shared with the HTML exporter). Mermaid diagrams are
 * rasterised through `options.renderDiagram`, which defaults to the
 * canvas-based `mermaidToPng` from ./mermaid, lazily imported so Node never
 * loads mermaid.
 */
import type * as Md from 'mdast';
import { APP_NAME } from '../../shared/agent/constants';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
  type IBorderOptions,
  type IBordersOptions,
  type ILevelsOptions,
  type INumberingOptions,
  type IParagraphOptions,
  type IRunOptions,
  type IShadingAttributesProperties,
  type IStylesOptions,
  type ParagraphChild,
} from 'docx';
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
  type CalloutInfo,
} from './markdownAst';

export interface DiagramImage {
  /** PNG bytes. */
  data: ArrayBuffer;
  /** Intrinsic size in CSS pixels (96 dpi), used to fit the image on the page. */
  width: number;
  height: number;
}

export interface DocxExportOptions {
  title: string;
  subtitle?: string;
  author?: string;
  /**
   * Renders a mermaid diagram to PNG. Defaults to `mermaidToPng` from ./mermaid
   * (lazy-imported so Node tests can stub it). Return null to fall back to
   * rendering the diagram source as a code block.
   */
  renderDiagram?: (code: string) => Promise<DiagramImage | null>;
  onProgress?: (message: string) => void;
}

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ---------------------------------------------------------------------------
// Page geometry: A4 with 1" margins. Units are DXA (twentieths of a point).
// ---------------------------------------------------------------------------
const PAGE_WIDTH_DXA = 11906;
const PAGE_HEIGHT_DXA = 16838;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = PAGE_WIDTH_DXA - 2 * MARGIN_DXA; // 9026 ≈ 6.27 in
const CONTENT_WIDTH_PX = Math.floor((CONTENT_WIDTH_DXA / 1440) * 96); // ≈ 601 px at 96 dpi
const MAX_IMAGE_HEIGHT_PX = Math.floor(((PAGE_HEIGHT_DXA - 2 * MARGIN_DXA) / 1440) * 96 * 0.8);
/** Indent added per list level, and the hanging indent that holds the bullet. */
const INDENT_STEP = 720;
const HANGING = 360;
const MAX_LIST_LEVEL = 8;

const FONT_BODY = 'Calibri';
const FONT_CODE = 'Consolas';

/** Colours as 6-digit hex without '#', as docx expects. */
const THEME = {
  text: '14343B',
  muted: '56696E',
  quote: '3E5A60',
  h1: '14343B',
  h2: '1F6F78',
  h3: '2A4A50',
  h4: '3E5A60',
  link: '1F6F78',
  /** Marigold: the title-block rule. */
  accent: 'E9A824',
  rule: 'CFC4AE',
  codeBg: 'F3EDE0',
  codeBorder: 'E6DECD',
  codeText: '14343B',
  inlineCodeBg: 'FBEFD0',
  inlineCodeText: '7A4E06',
  tableBorder: 'CFC4AE',
  tableHeader: 'FBEFD0',
  tableHeaderText: '14343B',
  tableStripe: 'F7F2E8',
} as const;

/** Font sizes in half-points. */
const SIZE = {
  body: 22,
  small: 18,
  table: 20,
  code: 19,
  inlineCode: 20,
  footer: 18,
  title: 64,
  subtitle: 28,
  h1: 44,
  h2: 34,
  h3: 27,
  h4: 24,
  h5: 23,
  h6: 22,
} as const;

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ParagraphSpec = Partial<Mutable<IParagraphOptions>>;
type RunSpec = Partial<Mutable<IRunOptions>>;
/** Paragraphs are kept as plain option objects until the end so callouts/lists can patch edges. */
type Block = { paragraph: ParagraphSpec } | { table: Table };

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  color?: string;
  /** Half-points. Omitted → inherits from the paragraph style. */
  size?: number;
  /** Inside a heading: inline code keeps the heading size. */
  inHeading?: boolean;
  /** Character style id (e.g. Hyperlink). */
  styleId?: string;
}

interface ListNumbering {
  reference: string;
  instance?: number;
}

interface BlockContext {
  /** Nesting depth of the enclosing list (0 = not in a list); selects the numbering level. */
  listDepth: number;
  /** Extra left/right indent (DXA) applied to paragraphs. */
  indentLeft: number;
  indentRight: number;
  /** Decorations inherited from an enclosing callout or quote. */
  shading?: IShadingAttributesProperties;
  border?: IBordersOptions;
  run: RunStyle;
  /** Tighter paragraph spacing (lists, callouts). */
  tight: boolean;
  /** Numbering instance of the enclosing ordered list, reused by nested ordered lists. */
  ordered?: ListNumbering;
}

interface InlineHint {
  /** Colour the leading "Label:" of a callout's first paragraph. */
  accent?: string;
}

const ROOT_CONTEXT: BlockContext = { listDepth: 0, indentLeft: 0, indentRight: 0, run: {}, tight: false };

const noop = (): void => {};

/** Strip a leading '#' from a CSS-style hex colour. */
function hex(color: string): string {
  return color.replace(/^#/, '');
}

/** Markdown soft line breaks inside a paragraph render as spaces. */
function collapseSoftBreaks(text: string): string {
  return text.replace(/[ \t]*\n[ \t]*/g, ' ');
}

function isExternalUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url);
}

function runOptions(style: RunStyle): RunSpec {
  const spec: RunSpec = {};
  if (style.bold) spec.bold = true;
  if (style.italics) spec.italics = true;
  if (style.strike) spec.strike = true;
  if (style.underline) spec.underline = { type: UnderlineType.SINGLE };
  if (style.color) spec.color = style.color;
  if (style.size) spec.size = style.size;
  if (style.styleId) spec.style = style.styleId;
  return spec;
}

function isImageOnly(node: Md.Paragraph): boolean {
  return (
    node.children.length > 0 &&
    node.children.every(
      (child) =>
        child.type === 'image' || child.type === 'imageReference' || (child.type === 'text' && child.value.trim() === ''),
    )
  );
}

function fitImage(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 640;
  const h = Number.isFinite(height) && height > 0 ? height : 400;
  const scale = Math.min(1, Math.max(1, maxWidth) / w, Math.max(1, maxHeight) / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function alignmentFor(align: Md.AlignType | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

/** Weight column widths by their longest cell so narrow columns don't waste space. */
function columnWidths(rows: readonly Md.TableRow[], columns: number, available: number): number[] {
  const weights = Array.from({ length: columns }, (_, c) => {
    let longest = 0;
    for (const row of rows) {
      const cell = row.children[c];
      if (cell) longest = Math.max(longest, mdastToPlainText(cell).length);
    }
    return Math.min(48, Math.max(6, longest));
  });
  const total = weights.reduce((sum, w) => sum + w, 0) || 1;
  const widths = weights.map((w) => Math.max(720, Math.floor((available * w) / total)));
  const overflow = widths.reduce((sum, w) => sum + w, 0) - available;
  if (overflow > 0) {
    // Trim the widest columns until the table fits the content width.
    let remaining = overflow;
    while (remaining > 0) {
      const widest = widths.indexOf(Math.max(...widths));
      const trim = Math.min(remaining, widths[widest] - 720);
      if (trim <= 0) break;
      widths[widest] -= trim;
      remaining -= trim;
    }
  } else if (overflow < 0) {
    widths[widths.length - 1] -= overflow;
  }
  return widths;
}

// ---------------------------------------------------------------------------
// Numbering definitions (real Word lists)
// ---------------------------------------------------------------------------
const BULLET_GLYPHS = ['•', '◦', '▪', '–'];
const NUMBER_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN] as const;

function levelIndent(level: number): { left: number; hanging: number } {
  return { left: INDENT_STEP * (level + 1), hanging: HANGING };
}

function bulletLevels(): ILevelsOptions[] {
  return Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: BULLET_GLYPHS[level % BULLET_GLYPHS.length],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: levelIndent(level) } },
  }));
}

function numberLevels(start: number): ILevelsOptions[] {
  return Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => ({
    level,
    format: NUMBER_FORMATS[level % NUMBER_FORMATS.length],
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    start: level === 0 ? start : 1,
    style: { paragraph: { indent: levelIndent(level) } },
  }));
}

class NumberingRegistry {
  private readonly configs = new Map<string, ILevelsOptions[]>();
  private nextInstance = 0;

  bullets(): ListNumbering {
    const reference = 'md-bullets';
    if (!this.configs.has(reference)) this.configs.set(reference, bulletLevels());
    return { reference };
  }

  orderedReference(start: number): string {
    const safeStart = Number.isInteger(start) && start > 0 ? start : 1;
    return safeStart === 1 ? 'md-numbers' : `md-numbers-${safeStart}`;
  }

  /** A fresh instance restarts numbering at the list's start value. */
  ordered(start: number): ListNumbering {
    const safeStart = Number.isInteger(start) && start > 0 ? start : 1;
    const reference = this.orderedReference(safeStart);
    if (!this.configs.has(reference)) this.configs.set(reference, numberLevels(safeStart));
    return { reference, instance: this.nextInstance++ };
  }

  toOptions(): INumberingOptions {
    return { config: [...this.configs].map(([reference, levels]) => ({ reference, levels })) };
  }
}

// ---------------------------------------------------------------------------
// mdast → docx blocks
// ---------------------------------------------------------------------------
class DocxBuilder {
  private readonly blocks: Block[] = [];
  private readonly numbering = new NumberingRegistry();
  private diagramCount = 0;

  constructor(private readonly diagrams: ReadonlyMap<Md.Code, DiagramImage | null>) {}

  numberingOptions(): INumberingOptions {
    return this.numbering.toOptions();
  }

  /** Start the body on a fresh page (after the title block) without an empty leading paragraph. */
  startOnNewPage(): void {
    const first = this.blocks[0];
    if (first && 'paragraph' in first) first.paragraph.pageBreakBefore = true;
    else this.blocks.unshift({ paragraph: { children: [new PageBreak()], spacing: { before: 0, after: 0 } } });
  }

  finalize(): (Paragraph | Table)[] {
    return this.blocks.map((block) => ('table' in block ? block.table : new Paragraph(block.paragraph)));
  }

  renderBlocks(nodes: readonly Md.RootContent[], ctx: BlockContext, hint?: InlineHint): void {
    nodes.forEach((node, index) => this.renderBlock(node, ctx, index === 0 ? hint : undefined));
  }

  private renderBlock(node: Md.RootContent, ctx: BlockContext, hint?: InlineHint): void {
    try {
      switch (node.type) {
        case 'heading':
          this.heading(node, ctx);
          break;
        case 'paragraph':
          this.paragraph(node, ctx, hint);
          break;
        case 'list':
          this.list(node, ctx);
          break;
        case 'code':
          this.code(node, ctx);
          break;
        case 'blockquote':
          this.blockquote(node, ctx);
          break;
        case 'table':
          this.table(node, ctx);
          break;
        case 'thematicBreak':
          this.rule(ctx);
          break;
        case 'html':
          this.html(node, ctx);
          break;
        case 'footnoteDefinition':
          this.footnote(node, ctx);
          break;
        default:
          // definitions, front matter and stray inline nodes: nothing to render
          break;
      }
    } catch (error) {
      // Never let a single malformed node break the whole export.
      console.warn(`[exportDocx] skipped ${node.type} node`, error);
    }
  }

  // -- paragraph helpers ----------------------------------------------------

  private baseProps(ctx: BlockContext): ParagraphSpec {
    const spec: ParagraphSpec = {};
    if (ctx.indentLeft || ctx.indentRight) {
      spec.indent = {
        ...(ctx.indentLeft ? { left: ctx.indentLeft } : {}),
        ...(ctx.indentRight ? { right: ctx.indentRight } : {}),
      };
    }
    if (ctx.shading) spec.shading = ctx.shading;
    if (ctx.border) spec.border = ctx.border;
    if (ctx.tight) spec.spacing = { before: 0, after: 80 };
    return spec;
  }

  private lastParagraph(from = 0): ParagraphSpec | null {
    if (this.blocks.length <= from) return null;
    const last = this.blocks[this.blocks.length - 1];
    return 'paragraph' in last ? last.paragraph : null;
  }

  // -- inline content -------------------------------------------------------

  private inline(nodes: readonly Md.PhrasingContent[], style: RunStyle): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          out.push(new TextRun({ ...runOptions(style), text: collapseSoftBreaks(node.value) }));
          break;
        case 'strong':
          out.push(...this.inline(node.children, { ...style, bold: true }));
          break;
        case 'emphasis':
          out.push(...this.inline(node.children, { ...style, italics: true }));
          break;
        case 'delete':
          out.push(...this.inline(node.children, { ...style, strike: true }));
          break;
        case 'inlineCode': {
          const spec = runOptions(style);
          spec.text = node.value;
          spec.font = FONT_CODE;
          spec.color = THEME.inlineCodeText;
          spec.shading = { type: ShadingType.CLEAR, fill: THEME.inlineCodeBg, color: 'auto' };
          if (!style.inHeading) spec.size = style.size ? Math.max(14, style.size - 2) : SIZE.inlineCode;
          out.push(new TextRun(spec));
          break;
        }
        case 'break':
          out.push(new TextRun({ break: 1 }));
          break;
        case 'link': {
          const url = (node.url ?? '').trim();
          if (isExternalUrl(url)) {
            const children = this.inline(node.children, {
              ...style,
              color: THEME.link,
              underline: true,
              styleId: 'Hyperlink',
            });
            if (children.length) out.push(new ExternalHyperlink({ link: url, children }));
          } else {
            // Anchors and unsupported schemes: keep the text, drop the link.
            out.push(...this.inline(node.children, style));
          }
          break;
        }
        case 'linkReference':
          out.push(...this.inline(node.children, style));
          break;
        case 'image':
        case 'imageReference':
          out.push(new TextRun({ ...runOptions(style), italics: true, color: THEME.muted, text: describeImage(node) }));
          break;
        case 'footnoteReference':
          out.push(new TextRun({ ...runOptions(style), superScript: true, text: `[${node.label ?? node.identifier}]` }));
          break;
        case 'html':
          if (isHtmlLineBreak(node.value)) out.push(new TextRun({ break: 1 }));
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** Inline content where the leading "Label:" (bold or plain) takes the callout accent colour. */
  private inlineWithLabel(nodes: readonly Md.PhrasingContent[], style: RunStyle, accent: string): ParagraphChild[] {
    const first = nodes[0];
    if (first?.type === 'strong') {
      return [...this.inline([first], { ...style, color: accent }), ...this.inline(nodes.slice(1), style)];
    }
    if (first?.type === 'text') {
      const match = /^(\s*[^:\n]{1,60}:)([\s\S]*)$/.exec(first.value);
      if (match) {
        const label = new TextRun({ ...runOptions({ ...style, bold: true, color: accent }), text: match[1].trimStart() });
        const rest: Md.Text = { type: 'text', value: match[2] };
        return [label, ...this.inline([rest, ...nodes.slice(1)], style)];
      }
    }
    return this.inline(nodes, style);
  }

  // -- block nodes ----------------------------------------------------------

  private heading(node: Md.Heading, ctx: BlockContext): void {
    const depth = Math.min(Math.max(node.depth, 1), 6);
    const spec = this.baseProps(ctx);
    delete spec.spacing; // headings keep the spacing of their style
    spec.heading = HEADING_LEVELS[depth - 1];
    spec.keepNext = true;
    spec.keepLines = true;
    spec.children = this.inline(node.children, { ...ctx.run, inHeading: true });
    this.blocks.push({ paragraph: spec });
  }

  private paragraph(node: Md.Paragraph, ctx: BlockContext, hint?: InlineHint): void {
    const children = hint?.accent
      ? this.inlineWithLabel(node.children, ctx.run, hint.accent)
      : this.inline(node.children, ctx.run);
    if (children.length === 0) return;
    const spec = this.baseProps(ctx);
    if (isImageOnly(node)) spec.alignment = AlignmentType.CENTER;
    spec.children = children;
    this.blocks.push({ paragraph: spec });
  }

  private list(node: Md.List, ctx: BlockContext): void {
    const ordered = Boolean(node.ordered);
    const start = node.start ?? 1;
    let numbering: ListNumbering;
    if (ordered) {
      const reference = this.numbering.orderedReference(start);
      numbering = ctx.ordered?.reference === reference ? ctx.ordered : this.numbering.ordered(start);
    } else {
      numbering = this.numbering.bullets();
    }
    const textIndent = ctx.indentLeft + INDENT_STEP;
    const itemCtx: BlockContext = {
      ...ctx,
      listDepth: ctx.listDepth + 1,
      indentLeft: textIndent,
      tight: true,
      ordered: ordered ? numbering : undefined,
    };
    const startIndex = this.blocks.length;

    for (const item of node.children) {
      if (item.type !== 'listItem') continue;
      const children = item.children;
      let leadDone = false;
      if (children.length === 0 || (children[0].type !== 'paragraph' && children[0].type !== 'list')) {
        this.blocks.push({ paragraph: this.listLead([], item, numbering, textIndent, ctx) });
        leadDone = true;
      }
      for (const child of children) {
        if (child.type === 'list') {
          this.list(child, itemCtx);
        } else if (!leadDone && child.type === 'paragraph') {
          leadDone = true;
          this.blocks.push({ paragraph: this.listLead(this.inline(child.children, ctx.run), item, numbering, textIndent, ctx) });
        } else {
          this.renderBlock(child, itemCtx);
        }
      }
    }

    if (ctx.listDepth === 0) {
      const last = this.lastParagraph(startIndex);
      if (last) last.spacing = { ...last.spacing, after: 160 };
    }
  }

  private listLead(
    runs: ParagraphChild[],
    item: Md.ListItem,
    numbering: ListNumbering,
    textIndent: number,
    ctx: BlockContext,
  ): ParagraphSpec {
    const spec = this.baseProps(ctx);
    spec.indent = { left: textIndent, hanging: HANGING, ...(ctx.indentRight ? { right: ctx.indentRight } : {}) };
    spec.spacing = { before: 0, after: 60 };
    spec.contextualSpacing = true;
    if (typeof item.checked === 'boolean') {
      // GFM task list: a checkbox glyph stands in for the bullet.
      const glyph = new TextRun({
        children: [item.checked ? '☑' : '☐', new Tab()],
        color: item.checked ? hex(CALLOUT_STYLES.practice.color) : THEME.muted,
      });
      spec.children = [glyph, ...runs];
    } else {
      spec.numbering = {
        reference: numbering.reference,
        level: Math.min(ctx.listDepth, MAX_LIST_LEVEL),
        ...(numbering.instance !== undefined ? { instance: numbering.instance } : {}),
      };
      spec.children = runs;
    }
    return spec;
  }

  private code(node: Md.Code, ctx: BlockContext): void {
    if (isMermaidCode(node)) {
      this.diagram(node, ctx);
      return;
    }
    this.codeBlock(node.value, ctx);
  }

  private codeBlock(source: string, ctx: BlockContext): void {
    const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const edge: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: THEME.codeBorder, space: 6 };
    const keepTogether = lines.length <= 40;
    lines.forEach((line, index) => {
      const first = index === 0;
      const last = index === lines.length - 1;
      const spec = this.baseProps(ctx);
      spec.style = 'CodeBlock';
      spec.shading = { type: ShadingType.CLEAR, fill: THEME.codeBg, color: 'auto' };
      spec.border = {
        left: { ...edge, space: 10 },
        right: { ...edge, space: 10 },
        ...(first ? { top: edge } : {}),
        ...(last ? { bottom: edge } : {}),
      };
      spec.spacing = { before: first ? 120 : 0, after: last ? 200 : 0, line: 240 };
      spec.keepLines = true;
      if (keepTogether && !last) spec.keepNext = true;
      spec.children = [new TextRun({ text: line, font: FONT_CODE, size: SIZE.code, color: THEME.codeText })];
      this.blocks.push({ paragraph: spec });
    });
  }

  private diagram(node: Md.Code, ctx: BlockContext): void {
    const image = this.diagrams.get(node) ?? null;
    if (!image) {
      const caption = this.baseProps(ctx);
      caption.spacing = { before: 120, after: 40 };
      caption.keepNext = true;
      caption.children = [new TextRun({ text: 'Diagram (mermaid source):', italics: true, color: THEME.muted })];
      this.blocks.push({ paragraph: caption });
      this.codeBlock(node.value, ctx);
      return;
    }
    const maxWidth = CONTENT_WIDTH_PX - Math.round(((ctx.indentLeft + ctx.indentRight) / 1440) * 96);
    const { width, height } = fitImage(image.width, image.height, maxWidth, MAX_IMAGE_HEIGHT_PX);
    this.diagramCount += 1;
    const name = `Diagram ${this.diagramCount}`;
    const spec = this.baseProps(ctx);
    spec.alignment = AlignmentType.CENTER;
    spec.spacing = { before: 200, after: 240 };
    spec.keepLines = true;
    spec.children = [
      new ImageRun({
        type: 'png',
        data: image.data,
        transformation: { width, height },
        altText: { name, title: name, description: node.value.slice(0, 1000) },
      }),
    ];
    this.blocks.push({ paragraph: spec });
  }

  private blockquote(node: Md.Blockquote, ctx: BlockContext): void {
    const callout = classifyBlockquote(node);
    if (callout) {
      this.callout(node, callout, ctx);
      return;
    }
    const startIndex = this.blocks.length;
    const inner: BlockContext = {
      ...ctx,
      indentLeft: ctx.indentLeft + 480,
      indentRight: ctx.indentRight + 240,
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: THEME.rule, space: 12 } },
      run: { ...ctx.run, italics: true, color: THEME.quote },
      tight: true,
    };
    this.renderBlocks(node.children, inner);
    const last = this.lastParagraph(startIndex);
    if (last) last.spacing = { ...last.spacing, after: 200 };
  }

  private callout(node: Md.Blockquote, info: CalloutInfo, ctx: BlockContext): void {
    const accent = hex(info.color);
    const fill = hex(info.background);
    // Borders in the fill colour act as padding above/below and to the right of the text.
    const pad: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: fill, space: 6 };
    const inner: BlockContext = {
      ...ctx,
      indentLeft: ctx.indentLeft + 240,
      indentRight: ctx.indentRight + 120,
      shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 12 },
        right: { ...pad, space: 8 },
      },
      tight: true,
      ordered: undefined,
    };
    const startIndex = this.blocks.length;
    this.renderBlocks(node.children, inner, { accent });
    if (this.blocks.length === startIndex) return;
    const first = this.blocks[startIndex];
    if ('paragraph' in first) {
      first.paragraph.border = { ...first.paragraph.border, top: pad };
      first.paragraph.spacing = { ...first.paragraph.spacing, before: 120 };
    }
    const last = this.lastParagraph(startIndex);
    if (last) {
      last.border = { ...last.border, bottom: pad };
      last.spacing = { ...last.spacing, after: 200 };
    }
  }

  private table(node: Md.Table, ctx: BlockContext): void {
    const rows = node.children.filter((row): row is Md.TableRow => row.type === 'tableRow');
    const columns = rows.reduce((max, row) => Math.max(max, row.children.length), 0);
    if (rows.length === 0 || columns === 0) return;
    const available = Math.max(2000, CONTENT_WIDTH_DXA - ctx.indentLeft - ctx.indentRight);
    const widths = columnWidths(rows, columns, available);
    const aligns = node.align ?? [];
    const border: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: THEME.tableBorder };

    const tableRows = rows.map((row, r) => {
      const isHeader = r === 0;
      const fill = isHeader ? THEME.tableHeader : r % 2 === 0 ? THEME.tableStripe : undefined;
      const cellStyle: RunStyle = {
        ...ctx.run,
        size: SIZE.table,
        ...(isHeader ? { bold: true, color: THEME.tableHeaderText } : {}),
      };
      return new TableRow({
        tableHeader: isHeader,
        cantSplit: true,
        children: Array.from({ length: columns }, (_, c) => {
          const cell = row.children[c];
          const runs = cell ? this.inline(cell.children, cellStyle) : [];
          return new TableCell({
            width: { size: widths[c], type: WidthType.DXA },
            verticalAlign: VerticalAlignTable.CENTER,
            ...(fill ? { shading: { type: ShadingType.CLEAR, fill, color: 'auto' } } : {}),
            children: [
              new Paragraph({
                alignment: alignmentFor(aligns[c] ?? undefined),
                spacing: { before: 0, after: 0 },
                children: runs,
              }),
            ],
          });
        }),
      });
    });

    this.blocks.push({
      table: new Table({
        rows: tableRows,
        width: { size: available, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        borders: {
          top: border,
          bottom: border,
          left: border,
          right: border,
          insideHorizontal: border,
          insideVertical: border,
        },
        ...(ctx.indentLeft ? { indent: { size: ctx.indentLeft, type: WidthType.DXA } } : {}),
      }),
    });
    // Word needs a paragraph after a table (and before the section end); it also provides the gap below.
    this.blocks.push({ paragraph: { spacing: { before: 0, after: 120 }, run: { size: 10 }, children: [] } });
  }

  private rule(ctx: BlockContext): void {
    const spec = this.baseProps(ctx);
    spec.border = { ...spec.border, bottom: { style: BorderStyle.SINGLE, size: 6, color: THEME.rule, space: 1 } };
    spec.spacing = { before: 120, after: 240 };
    spec.run = { size: 12 };
    spec.children = [];
    this.blocks.push({ paragraph: spec });
  }

  private html(node: Md.Html, ctx: BlockContext): void {
    const text = stripHtmlTags(node.value).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const spec = this.baseProps(ctx);
    spec.children = [new TextRun({ ...runOptions(ctx.run), text })];
    this.blocks.push({ paragraph: spec });
  }

  private footnote(node: Md.FootnoteDefinition, ctx: BlockContext): void {
    const startIndex = this.blocks.length;
    const inner: BlockContext = {
      ...ctx,
      indentLeft: ctx.indentLeft + 360,
      run: { ...ctx.run, size: SIZE.small, color: THEME.quote },
      tight: true,
    };
    this.renderBlocks(node.children, inner);
    const first = this.blocks[startIndex];
    if (first && 'paragraph' in first) {
      const label = new TextRun({ text: `[${node.label ?? node.identifier}] `, bold: true, size: SIZE.small, color: THEME.quote });
      first.paragraph.children = [label, ...(first.paragraph.children ?? [])];
    }
  }
}

// ---------------------------------------------------------------------------
// Document chrome: styles, title block, footer
// ---------------------------------------------------------------------------
function buildStyles(): IStylesOptions {
  const headingParagraph = (before: number, after: number, outlineLevel: number) => ({
    spacing: { before, after },
    keepNext: true,
    keepLines: true,
    outlineLevel,
  });
  return {
    default: {
      document: {
        run: { font: FONT_BODY, size: SIZE.body, color: THEME.text },
        paragraph: { spacing: { after: 160, line: 264 } },
      },
      title: {
        run: { font: FONT_BODY, size: SIZE.title, bold: true, color: THEME.h1 },
        paragraph: { spacing: { before: 0, after: 160 } },
      },
      heading1: {
        run: { font: FONT_BODY, size: SIZE.h1, bold: true, color: THEME.h1 },
        paragraph: headingParagraph(480, 160, 0),
      },
      heading2: {
        run: { font: FONT_BODY, size: SIZE.h2, bold: true, color: THEME.h2 },
        paragraph: headingParagraph(360, 120, 1),
      },
      heading3: {
        run: { font: FONT_BODY, size: SIZE.h3, bold: true, color: THEME.h3 },
        paragraph: headingParagraph(280, 100, 2),
      },
      heading4: {
        run: { font: FONT_BODY, size: SIZE.h4, bold: true, italics: true, color: THEME.h4 },
        paragraph: headingParagraph(240, 80, 3),
      },
      heading5: {
        run: { font: FONT_BODY, size: SIZE.h5, bold: true, color: THEME.h4 },
        paragraph: headingParagraph(200, 80, 4),
      },
      heading6: {
        run: { font: FONT_BODY, size: SIZE.h6, bold: true, italics: true, color: THEME.muted },
        paragraph: headingParagraph(200, 80, 5),
      },
      hyperlink: {
        run: { color: THEME.link, underline: { type: UnderlineType.SINGLE } },
      },
      listParagraph: {
        paragraph: { spacing: { after: 60 }, contextualSpacing: true },
      },
    },
    paragraphStyles: [
      {
        id: 'CodeBlock',
        name: 'Code Block',
        basedOn: 'Normal',
        next: 'CodeBlock',
        quickFormat: true,
        run: { font: FONT_CODE, size: SIZE.code, color: THEME.codeText },
        paragraph: { spacing: { before: 0, after: 0, line: 240 } },
      },
      {
        id: 'Subtitle',
        name: 'Subtitle',
        basedOn: 'Normal',
        next: 'Normal',
        run: { font: FONT_BODY, size: SIZE.subtitle, color: THEME.quote },
        paragraph: { spacing: { before: 0, after: 120 } },
      },
    ],
    characterStyles: [
      {
        id: 'InlineCode',
        name: 'Inline Code',
        run: {
          font: FONT_CODE,
          size: SIZE.inlineCode,
          color: THEME.inlineCodeText,
          shading: { type: ShadingType.CLEAR, fill: THEME.inlineCodeBg, color: 'auto' },
        },
      },
    ],
  };
}

function formatDate(date: Date): string {
  try {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function titleBlock(title: string, subtitle: string | undefined, author: string | undefined): Paragraph[] {
  const meta = [author?.trim(), formatDate(new Date())].filter((part): part is string => Boolean(part));
  const paragraphs: Paragraph[] = [
    // Accent bar above the title.
    new Paragraph({
      spacing: { before: 3200, after: 360 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 36, color: THEME.accent, space: 1 } },
      run: { size: 8 },
      children: [],
    }),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title })] }),
  ];
  if (subtitle?.trim()) {
    paragraphs.push(
      new Paragraph({
        style: 'Subtitle',
        children: [new TextRun({ text: subtitle.trim(), size: SIZE.subtitle, color: THEME.quote })],
      }),
    );
  }
  paragraphs.push(
    new Paragraph({
      spacing: { before: 240, after: 0 },
      children: [new TextRun({ text: meta.join('  ·  '), size: SIZE.body, color: THEME.muted })],
    }),
  );
  return paragraphs;
}

function buildFooter(title: string): Footer {
  const label = title.length > 90 ? `${title.slice(0, 87)}…` : title;
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_DXA }],
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: THEME.rule, space: 6 } },
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({ text: label, size: SIZE.footer, color: THEME.muted }),
          new TextRun({
            children: [new Tab(), 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES],
            size: SIZE.footer,
            color: THEME.muted,
          }),
        ],
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Diagram rendering
// ---------------------------------------------------------------------------
async function defaultRenderDiagram(code: string): Promise<DiagramImage | null> {
  const { mermaidToPng } = await import('./mermaid');
  const png = await mermaidToPng(code, 2);
  if (!png) return null;
  return { data: await png.blob.arrayBuffer(), width: png.width, height: png.height };
}

async function renderDiagrams(
  tree: Md.Root,
  render: (code: string) => Promise<DiagramImage | null>,
  progress: (message: string) => void,
): Promise<Map<Md.Code, DiagramImage | null>> {
  const blocks = collectMermaidBlocks(tree);
  const out = new Map<Md.Code, DiagramImage | null>();
  for (const [index, block] of blocks.entries()) {
    progress(`Rendering diagram ${index + 1} of ${blocks.length}…`);
    let image: DiagramImage | null = null;
    try {
      image = await render(block.value);
    } catch {
      image = null;
    }
    out.set(block, image && image.data && image.data.byteLength > 0 ? image : null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function normaliseTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Drop a leading H1 that merely repeats the document title (it already sits on the title page). */
function bodyNodes(tree: Md.Root, title: string): Md.RootContent[] {
  const first = tree.children[0];
  if (first?.type === 'heading' && first.depth === 1 && normaliseTitle(mdastToPlainText(first)) === normaliseTitle(title)) {
    return tree.children.slice(1);
  }
  return tree.children;
}

async function buildDocument(markdown: string, options: DocxExportOptions): Promise<Document> {
  const progress = options.onProgress ?? noop;
  const title = (options.title ?? '').trim() || 'Study guide';
  progress('Parsing study guide…');
  const tree = parseMarkdown(markdown);
  const diagrams = await renderDiagrams(tree, options.renderDiagram ?? defaultRenderDiagram, progress);
  progress('Building document…');
  const builder = new DocxBuilder(diagrams);
  builder.renderBlocks(bodyNodes(tree, title), ROOT_CONTEXT);
  builder.startOnNewPage();

  return new Document({
    title,
    subject: options.subtitle?.trim() || undefined,
    description: options.subtitle?.trim() || undefined,
    creator: options.author?.trim() || APP_NAME,
    lastModifiedBy: options.author?.trim() || APP_NAME,
    styles: buildStyles(),
    numbering: builder.numberingOptions(),
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
            margin: {
              top: MARGIN_DXA,
              right: MARGIN_DXA,
              bottom: MARGIN_DXA,
              left: MARGIN_DXA,
              header: 708,
              footer: 708,
            },
          },
        },
        footers: { default: buildFooter(title) },
        children: [...titleBlock(title, options.subtitle, options.author), ...builder.finalize()],
      },
    ],
  });
}

/** Convert markdown to DOCX bytes. Works in Node and in the browser. */
export async function markdownToDocx(markdown: string, options: DocxExportOptions): Promise<Uint8Array> {
  const doc = await buildDocument(markdown, options);
  options.onProgress?.('Packaging DOCX…');
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/** Convert markdown to a DOCX Blob ready for download or upload. */
export async function markdownToDocxBlob(markdown: string, options: DocxExportOptions): Promise<Blob> {
  const doc = await buildDocument(markdown, options);
  options.onProgress?.('Packaging DOCX…');
  const buffer = await Packer.toArrayBuffer(doc);
  return new Blob([buffer], { type: DOCX_MIME_TYPE });
}
