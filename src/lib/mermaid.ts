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
  primaryColor: '#e0e7ff',
  primaryTextColor: '#1e1b4b',
  primaryBorderColor: '#6366f1',
  secondaryColor: '#dcfce7',
  secondaryTextColor: '#14532d',
  secondaryBorderColor: '#22c55e',
  tertiaryColor: '#fef3c7',
  tertiaryTextColor: '#78350f',
  tertiaryBorderColor: '#f59e0b',
  lineColor: '#64748b',
  textColor: '#1e293b',
  background: '#ffffff',
  mainBkg: '#e0e7ff',
  nodeBorder: '#6366f1',
  clusterBkg: '#f8fafc',
  clusterBorder: '#cbd5e1',
  edgeLabelBackground: '#ffffff',
  actorBkg: '#e0e7ff',
  actorBorder: '#6366f1',
  signalColor: '#334155',
  labelBoxBkgColor: '#fef3c7',
  noteBkgColor: '#fef9c3',
  noteBorderColor: '#facc15',
  pie1: '#6366f1',
  pie2: '#22c55e',
  pie3: '#f59e0b',
  pie4: '#ec4899',
  pie5: '#06b6d4',
  pie6: '#8b5cf6',
  pie7: '#f97316',
  pie8: '#14b8a6',
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
