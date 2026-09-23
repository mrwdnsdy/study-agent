/**
 * Mermaid rendering helpers shared by the guide viewer and the exporters.
 * Diagrams render to SVG with plain-SVG labels (no foreignObject) so they can
 * be rasterised to PNG on a canvas for DOCX export.
 *
 * Every render goes through resolveMermaidCode: the diagram as written, else
 * its repaired version (shared/agent/mermaidRepair.ts). The viewer and the
 * exporters therefore agree on which diagrams render.
 */
import mermaid from 'mermaid';
import { repairMermaid } from '../../shared/agent/mermaidRepair';

let initialised = false;
let counter = 0;

/** Soft Kiiku pastels for mindmap branches and timeline sections (cScale0…11). */
const SCALE = ['#FBEFD0', '#DCE9EE', '#E6EFD6', '#FBE4CF', '#E9E2F2', '#F7EAC8', '#D5EDE4', '#F3E0D3', '#E3ECF4', '#EEF4E3', '#FFF4DC', '#EAE2D2'];
/** The same hues a little darker, for outlines and the rule under mindmap and timeline nodes. */
const SCALE_PEER = ['#F5D98E', '#ACCBD7', '#C7DBA3', '#F6BF8D', '#C4B1DC', '#EED28A', '#A3D8C4', '#E4B89B', '#B0C9E0', '#CFE0B0', '#FFDE95', '#D3C3A1'];
const SCALE_LABEL = '#14343B';

/** Twelve numbered theme variables, e.g. cScale0…cScale11. */
function scaleVariables(prefix: string, values: (index: number) => string): Record<string, string> {
  return Object.fromEntries(SCALE.map((_, index) => [`${prefix}${index}`, values(index)]));
}

const THEME_VARIABLES = {
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: '15px',
  primaryColor: '#FBEFD0',
  primaryTextColor: '#14343B',
  primaryBorderColor: '#D9961A',
  secondaryColor: '#E6EFD6',
  secondaryTextColor: '#2E4B14',
  secondaryBorderColor: '#6E9A3C',
  tertiaryColor: '#DCE9EE',
  tertiaryTextColor: '#14484E',
  tertiaryBorderColor: '#1F6F78',
  lineColor: '#4F6B70',
  textColor: '#14343B',
  background: '#ffffff',
  mainBkg: '#FBEFD0',
  nodeBorder: '#D9961A',
  clusterBkg: '#F7F2E8',
  clusterBorder: '#CFC4AE',
  edgeLabelBackground: '#ffffff',
  actorBkg: '#FBEFD0',
  actorBorder: '#D9961A',
  signalColor: '#2F4A50',
  labelBoxBkgColor: '#DCE9EE',
  noteBkgColor: '#FFF4DC',
  noteBorderColor: '#E9A824',
  pie1: '#E9A824',
  pie2: '#1F6F78',
  pie3: '#6E9A3C',
  pie4: '#C0611A',
  pie5: '#7E5FA8',
  pie6: '#C63D3D',
  pie7: '#4C8DB8',
  pie8: '#B59A5B',
  // Without these, mindmaps and timelines fall back to mermaid's rainbow.
  ...scaleVariables('cScale', (index) => SCALE[index]),
  ...scaleVariables('cScalePeer', (index) => SCALE_PEER[index]),
  ...scaleVariables('cScaleInv', (index) => SCALE_PEER[index]),
  ...scaleVariables('cScaleLabel', () => SCALE_LABEL),
};

export function ensureMermaid(): void {
  if (initialised) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    // mermaid 12 falls back to the 'neo' look and the ELK layout when these are unset.
    look: 'classic',
    layout: 'dagre',
    securityLevel: 'strict',
    suppressErrorRendering: true,
    themeVariables: THEME_VARIABLES,
    flowchart: {
      htmlLabels: false,
      curve: 'basis',
      padding: 12,
      useMaxWidth: true,
      // mermaid 12 wraps labels at 120 px, which stacks short labels into tall, narrow nodes.
      wrappingWidth: 220,
      nodeSpacing: 40,
      rankSpacing: 48,
    },
    class: { htmlLabels: false, useMaxWidth: true },
    state: { useMaxWidth: true },
    sequence: { useMaxWidth: true, mirrorActors: false },
    er: { useMaxWidth: true },
    // Mindmaps keep their radial layout; the top-level dagre setting would turn them into trees.
    mindmap: { useMaxWidth: true, padding: 12, layout: 'cose-bilkent' },
    timeline: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    // Mermaid's own htmlLabels flag lives at the top level for some diagram types.
    htmlLabels: false,
  } as Parameters<typeof mermaid.initialize>[0]);
  initialised = true;
}

/** Strip a markdown fence if the code still carries one and normalise whitespace. */
export function normaliseMermaidCode(code: string): string {
  return code
    .replace(/^\s*```(?:mermaid)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

const MAX_ERROR_LENGTH = 200;

/** First line of a parser error, without the trailing colon that introduces mermaid's excerpt. */
function errorSummary(err: unknown): string {
  const message = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  const line = message
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  const summary = (line ?? '').replace(/[\s:]+$/, '') || 'the diagram syntax is invalid';
  return summary.length > MAX_ERROR_LENGTH ? `${summary.slice(0, MAX_ERROR_LENGTH - 1).trimEnd()}…` : summary;
}

/** The parser's message when the diagram is invalid (first line, at most ~200 characters), else null. Never throws. */
export async function mermaidError(code: string): Promise<string | null> {
  ensureMermaid();
  try {
    await mermaid.parse(normaliseMermaidCode(code));
    return null;
  } catch (err) {
    return errorSummary(err);
  }
}

/** Returns true if mermaid can parse the diagram; never throws. */
export async function isValidMermaid(code: string): Promise<boolean> {
  return (await mermaidError(code)) === null;
}

export type ResolvedMermaid =
  | { code: string; repaired: boolean; error?: undefined }
  | { error: string; code?: undefined; repaired?: undefined };

/**
 * The code to render: its repaired version when the repair changed something
 * and that parses, else the diagram as written when it parses. Some slips parse
 * but draw the wrong thing (A["Label"] in a state diagram invents extra states),
 * and the repair leaves a diagram that follows the prompt's rules byte for byte.
 * When neither parses, the error is the original's, since that is the code the
 * reader can see.
 */
export async function resolveMermaidCode(code: string): Promise<ResolvedMermaid> {
  const original = normaliseMermaidCode(code);
  const repaired = repairMermaid(original);
  if (repaired && repaired !== original && (await mermaidError(repaired)) === null) return { code: repaired, repaired: true };
  const error = await mermaidError(original);
  if (error === null) return { code: original, repaired: false };
  return { error };
}

const FONT_TIMEOUT_MS = 1500;
let fontsReadyPromise: Promise<void> | null = null;

/**
 * Resolves once the page fonts are ready, or after 1.5 s. Mermaid measures
 * label text while it lays a diagram out, so a render made with the fallback
 * font leaves labels overflowing once Inter arrives, and the SVG cache would
 * keep that result.
 */
function fontsReady(): Promise<void> {
  if (!fontsReadyPromise) {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    // Asking for Inter starts the download even if nothing on the page has used it yet.
    const loading = fonts
      ? Promise.all([fonts.load?.('400 15px Inter'), fonts.load?.('600 15px Inter'), fonts.ready]).then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
    fontsReadyPromise = Promise.race([loading, new Promise<void>((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS))]);
  }
  return fontsReadyPromise;
}

/** Node groups whose plain-SVG labels mermaid 12 does not centre: mindmap nodes and state boxes. */
const UNCENTRED_NODE = /<g class="node\b[^"]*\b(?:mindmap-node|statediagram-state)\b[^"]*"[^>]*>/g;
const G_TAG = /<(\/?)g\b([^>]*)>/g;
const LABEL_TRANSLATE = /\btransform="translate\(\s*[-+\d.e]+\s*,\s*([-+\d.e]+)\s*\)"/;
const TEXT_OPEN = /<text\b[^>]*>/g;

/**
 * mermaid 12 draws the plain-SVG labels of mindmap nodes and state boxes
 * left-aligned: the text starts at the node's centre (circle, square, rounded
 * and hexagon mindmap shapes) or at the left of a fixed-width label box (state
 * boxes), so short labels sit off to one side. Each such node's label group
 * moves to the node's centre and its text is centred there, which leaves the
 * shapes that came out right as they were. Applied to the SVG itself, so the
 * page and every export agree.
 */
export function centreNodeLabels(svg: string): string {
  if (!/mindmap-node|statediagram-state/.test(svg)) return svg;
  const edits: { from: number; to: number; text: string }[] = [];
  for (const node of svg.matchAll(UNCENTRED_NODE)) {
    // The node's own label is a direct child group: track <g> depth so a nested or later label is never taken.
    G_TAG.lastIndex = node.index + node[0].length;
    let depth = 1;
    for (let tag = G_TAG.exec(svg); tag && depth > 0; tag = G_TAG.exec(svg)) {
      if (tag[1]) {
        depth -= 1;
        continue;
      }
      if (depth === 1 && /\bclass="label"/.test(tag[2])) {
        const translate = LABEL_TRANSLATE.exec(tag[0]);
        TEXT_OPEN.lastIndex = tag.index + tag[0].length;
        const text = TEXT_OPEN.exec(svg);
        const nextGroup = svg.slice(tag.index + tag[0].length, text?.index ?? tag.index).search(/<g class="(?:node|label)\b/);
        if (translate && text && nextGroup === -1 && !/text-anchor/.test(text[0])) {
          const labelStart = tag.index + translate.index;
          edits.push({ from: labelStart, to: labelStart + translate[0].length, text: `transform="translate(0, ${translate[1]})"` });
          edits.push({ from: text.index + 5, to: text.index + 5, text: ' text-anchor="middle"' });
        }
        break;
      }
      if (!tag[0].endsWith('/>')) depth += 1;
    }
  }
  let out = svg;
  for (const edit of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  return out;
}

/**
 * Render diagram source to an SVG string, repairing common slips first.
 * Throws with the parser's reason when the diagram cannot be drawn.
 */
export async function renderMermaidSvg(code: string): Promise<string> {
  const resolved = await resolveMermaidCode(code);
  if (resolved.error !== undefined) throw new Error(resolved.error);
  await fontsReady();
  const id = `mmd-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const { svg } = await mermaid.render(id, resolved.code);
  return centreNodeLabels(svg);
}

/** Widest a diagram is drawn in the page; anything wider scrolls sideways or opens in the lightbox. */
export const MAX_DIAGRAM_WIDTH = 1100;

/**
 * On-screen width for a diagram whose natural (viewBox) width is `natural`
 * in a column `column` px wide. Diagrams keep their natural size, up to
 * 1100 px. One a little wider than the column shrinks to fit, down to 75% of
 * that size, where labels are still comfortable to read; a wider one is drawn
 * at 75% and scrolls sideways (Expand shows it whole). Squeezing every diagram
 * into the column made labels 3–4 px tall.
 */
export function diagramDisplayWidth(natural: number, column: number): number {
  const width = Math.min(natural, MAX_DIAGRAM_WIDTH);
  if (column <= 0 || column >= width) return width;
  return Math.max(column, MIN_DIAGRAM_SCALE * width);
}

/** Smallest scale a diagram is shrunk to so it fits the column. */
export const MIN_DIAGRAM_SCALE = 0.75;

export interface RasterisedSvg {
  blob: Blob;
  /** Intrinsic (unscaled) size in CSS pixels. */
  width: number;
  height: number;
  /** Base64 PNG data URL for convenience. */
  dataUrl: string;
}

/** A plain number or px length ("812.5", "812.5px"); null for %, em, auto or a missing value. */
function pixelLength(value: string | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?\s*$/i.exec(value ?? '');
  const length = match ? Number(match[1]) : NaN;
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * Intrinsic size of a rendered diagram in CSS pixels. Mermaid writes
 * width="100%" and keeps the real size in the viewBox (and an inline
 * max-width), so a missing, percentage or other non-pixel width or height
 * comes from the viewBox, keeping its aspect ratio; without a viewBox the
 * width comes from the max-width style.
 */
export function svgDimensions(el: Pick<Element, 'getAttribute'>): { width: number; height: number } {
  let width = pixelLength(el.getAttribute('width'));
  let height = pixelLength(el.getAttribute('height'));
  const box = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
    const [, , boxWidth, boxHeight] = box;
    if (width === null && height === null) {
      width = boxWidth;
      height = boxHeight;
    } else if (width === null) {
      width = (height! * boxWidth) / boxHeight;
    } else if (height === null) {
      height = (width * boxHeight) / boxWidth;
    }
  }
  if (width === null) {
    const maxWidth = /max-width:\s*(\d+(?:\.\d+)?)px/i.exec(el.getAttribute('style') ?? '');
    if (maxWidth && Number(maxWidth[1]) > 0) width = Number(maxWidth[1]);
  }
  return { width: width ?? 800, height: height ?? 500 };
}

/** Rasterise an SVG string to a PNG blob using a canvas (browser only). */
export async function svgToPng(svg: string, scale = 2): Promise<RasterisedSvg> {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.documentElement;
  const { width, height } = svgDimensions(el);
  el.setAttribute('width', String(width));
  el.setAttribute('height', String(height));
  el.removeAttribute('style');
  if (!el.getAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const serialised = new XMLSerializer().serializeToString(el);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serialised);

  const img = new Image();
  img.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load SVG into an image'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'),
  );
  return { blob, width, height, dataUrl: canvas.toDataURL('image/png') };
}

/** Render (repairing if needed) and rasterise in one step. Returns null if the diagram cannot be drawn. */
export async function mermaidToPng(code: string, scale = 2): Promise<RasterisedSvg | null> {
  try {
    const svg = await renderMermaidSvg(code);
    return await svgToPng(svg, scale);
  } catch {
    return null;
  }
}
