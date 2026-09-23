/**
 * Mermaid rendering helpers shared by the guide viewer and the exporters.
 * Diagrams render to SVG with plain-SVG labels (no foreignObject) so they can
 * be rasterised to PNG on a canvas for DOCX export.
 */
import mermaid from 'mermaid';

let initialised = false;
let counter = 0;

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
};

export function ensureMermaid(): void {
  if (initialised) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    suppressErrorRendering: true,
    themeVariables: THEME_VARIABLES,
    flowchart: { htmlLabels: false, curve: 'basis', padding: 12, useMaxWidth: true },
    class: { htmlLabels: false, useMaxWidth: true },
    state: { useMaxWidth: true },
    sequence: { useMaxWidth: true, mirrorActors: false },
    er: { useMaxWidth: true },
    mindmap: { useMaxWidth: true, padding: 12 },
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

/** Returns true if mermaid can parse the diagram; never throws. */
export async function isValidMermaid(code: string): Promise<boolean> {
  ensureMermaid();
  try {
    const result = await mermaid.parse(normaliseMermaidCode(code), { suppressErrors: true });
    return result !== false;
  } catch {
    return false;
  }
}

/** Render diagram source to an SVG string. Throws on invalid diagrams. */
export async function renderMermaidSvg(code: string): Promise<string> {
  ensureMermaid();
  const id = `mmd-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const { svg } = await mermaid.render(id, normaliseMermaidCode(code));
  return svg;
}

export interface RasterisedSvg {
  blob: Blob;
  /** Intrinsic (unscaled) size in CSS pixels. */
  width: number;
  height: number;
  /** Base64 PNG data URL for convenience. */
  dataUrl: string;
}

function svgDimensions(el: Element): { width: number; height: number } {
  const viewBox = el.getAttribute('viewBox');
  let width = Number.parseFloat(el.getAttribute('width') ?? '');
  let height = Number.parseFloat(el.getAttribute('height') ?? '');
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4) {
      if (!Number.isFinite(width) || width <= 0) width = parts[2];
      if (!Number.isFinite(height) || height <= 0) height = parts[3];
    }
  }
  if (!Number.isFinite(width) || width <= 0) width = 800;
  if (!Number.isFinite(height) || height <= 0) height = 500;
  return { width, height };
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

/** Render + rasterise in one step. Returns null if the diagram is invalid. */
export async function mermaidToPng(code: string, scale = 2): Promise<RasterisedSvg | null> {
  if (!(await isValidMermaid(code))) return null;
  try {
    const svg = await renderMermaidSvg(code);
    return await svgToPng(svg, scale);
  } catch {
    return null;
  }
}
