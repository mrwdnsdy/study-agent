/**
 * In-browser material extraction for browser mode. Mirrors the server's
 * text + images fallback: PDFs pass through, PowerPoint decks yield slide text,
 * speaker notes and embedded pictures, Word files go through Mammoth, images
 * are downscaled with a canvas when large, text is read as UTF-8/UTF-16.
 */
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import type { MaterialKind } from '../../shared/types';
import type { BrowserMaterial, BrowserPart, ImageMediaType } from './db';

export interface ExtractResult {
  material: BrowserMaterial;
  files: Map<string, Blob>;
}

export const SUPPORTED_EXTENSIONS = ['.pdf', '.pptx', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.markdown', '.csv'] as const;

const MAX_PDF_PAGES = 600;
const MAX_IMAGES = 40;
const MIN_EMBEDDED_IMAGE_BYTES = 3 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4000;
const RESIZED_LONG_EDGE = 2000;

const IMAGE_EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function detectKind(name: string, mimeType: string): MaterialKind | null {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (ext === '.pptx' || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext) || /^image\/(png|jpeg|gif|webp)$/.test(mimeType)) return 'image';
  if (['.txt', '.md', '.markdown', '.csv'].includes(ext) || mimeType.startsWith('text/')) return 'text';
  return null;
}

export async function extractFile(file: File, id: string): Promise<ExtractResult> {
  const kind = detectKind(file.name, file.type);
  if (!kind) {
    throw new Error(`Unsupported file type "${file.name.match(/\.[^.]+$/)?.[0] ?? file.type}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`);
  }
  const base = { id, name: file.name, kind };
  switch (kind) {
    case 'pdf':
      return extractPdf(base, file);
    case 'pptx':
      return extractPptx(base, file);
    case 'docx':
      return extractDocx(base, file);
    case 'image':
      return extractImage(base, file);
    default:
      return extractText(base, file);
  }
}

type Base = Pick<BrowserMaterial, 'id' | 'name' | 'kind'>;

/** Bytes may sit in a SharedArrayBuffer-typed view; Blob wants a plain ArrayBuffer-backed one. */
function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function extractPdf(base: Base, file: File): Promise<ExtractResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF')) throw new Error(`"${base.name}" does not look like a PDF.`);
  let pages: number | undefined;
  try {
    pages = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    pages = undefined;
  }
  if (pages !== undefined && pages > MAX_PDF_PAGES) {
    throw new Error(`This PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES} pages per file. Please split it.`);
  }
  const fileId = `${base.id}.pdf`;
  return {
    material: { ...base, parts: [{ type: 'pdf', fileId, pages }], summary: pages ? plural(pages, 'page') : 'PDF document', pages },
    files: new Map([[fileId, new Blob([bytes], { type: 'application/pdf' })]]),
  };
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

interface SlideInfo {
  number: number;
  text: string;
  notes: string;
  pictures: string[];
}

interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
type RelMap = Map<string, Rel>;

async function extractPptx(base: Base, file: File): Promise<ExtractResult> {
  const zip = await loadZip(await file.arrayBuffer(), 'PPTX');
  const slides = await readSlides(zip);
  if (slides.length === 0) throw new Error(`No slides were found in "${base.name}".`);

  const files = new Map<string, Blob>();
  const parts: BrowserPart[] = [{ type: 'text', text: formatSlideText(slides), label: 'Slide text and speaker notes' }];
  const seen = new Set<string>();
  let imageCount = 0;
  for (const slide of slides) {
    let index = 0;
    for (const target of slide.pictures) {
      if (imageCount >= MAX_IMAGES) break;
      if (seen.has(target)) continue;
      seen.add(target);
      const data = await readZipBytes(zip, target);
      const mediaType = data && usableEmbeddedImage(data);
      if (!data || !mediaType) continue;
      index += 1;
      imageCount += 1;
      const fileId = `${base.id}-slide${slide.number}-${index}.${IMAGE_EXTENSIONS[mediaType]}`;
      files.set(fileId, new Blob([toBlobPart(data)], { type: mediaType }));
      parts.push({ type: 'image', fileId, mediaType, label: `Slide ${slide.number}, image ${index}` });
    }
  }
  const summary = imageCount ? `${plural(slides.length, 'slide')} · ${plural(imageCount, 'image')}` : plural(slides.length, 'slide');
  return { material: { ...base, parts, summary, pages: slides.length, imageCount }, files };
}

async function readSlides(zip: JSZip): Promise<SlideInfo[]> {
  const slidePaths = await orderedSlidePaths(zip);
  const slides: SlideInfo[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const xml = (await readZipText(zip, slidePath)) ?? '';
    const rels = await readRels(zip, slidePath);
    let text = drawingMlText(xml);
    const diagramText = await readDiagramText(zip, rels);
    if (diagramText) text = text ? `${text}\n\n${diagramText}` : diagramText;
    slides.push({ number: index + 1, text, notes: await readSpeakerNotes(zip, rels), pictures: pictureTargets(xml, rels) });
  }
  return slides;
}

async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const byNumber = zipPaths(zip)
    .map((p) => ({ p, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/i.exec(p)?.[1] ?? NaN) }))
    .filter((e) => Number.isFinite(e.n))
    .sort((a, b) => a.n - b.n)
    .map((e) => e.p);
  try {
    const presentation = await readZipText(zip, 'ppt/presentation.xml');
    if (!presentation) return byNumber;
    const rels = await readRels(zip, 'ppt/presentation.xml');
    const ordered: string[] = [];
    for (const m of presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
      const rel = rels.get(m[1]);
      if (rel && !rel.external && findZipEntry(zip, rel.target) && !ordered.includes(rel.target)) ordered.push(rel.target);
    }
    return ordered.length > 0 ? ordered : byNumber;
  } catch {
    return byNumber;
  }
}

async function readSpeakerNotes(zip: JSZip, rels: RelMap): Promise<string> {
  const rel = [...rels.values()].find((r) => !r.external && r.type.endsWith('/notesSlide'));
  if (!rel) return '';
  const xml = await readZipText(zip, rel.target);
  if (!xml) return '';
  const withoutPlaceholders = xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shape) =>
    /<p:ph\b[^>]*\btype="(?:sldNum|sldImg|dt|hdr|ftr)"/.test(shape) && /^[\s\d]*$/.test(drawingMlText(shape)) ? '' : shape,
  );
  return drawingMlText(withoutPlaceholders);
}

async function readDiagramText(zip: JSZip, rels: RelMap): Promise<string> {
  const blocks: string[] = [];
  for (const rel of rels.values()) {
    if (rel.external || !rel.type.endsWith('/diagramData')) continue;
    const xml = await readZipText(zip, rel.target);
    const text = xml ? drawingMlText(xml) : '';
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n');
}

function pictureTargets(xml: string, rels: RelMap): string[] {
  const targets: string[] = [];
  for (const m of xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
    const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(m[0]);
    const rel = embed ? rels.get(embed[1]) : undefined;
    if (rel && !rel.external && rel.type.endsWith('/image')) targets.push(rel.target);
  }
  return targets;
}

function formatSlideText(slides: SlideInfo[]): string {
  return slides
    .map((slide) => {
      let block = `## Slide ${slide.number}\n${slide.text}`.trimEnd();
      if (slide.notes) block += `\n\nSpeaker notes: ${slide.notes}`;
      return block;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

type MammothConvert = (
  input: { arrayBuffer: ArrayBuffer },
  options?: { convertImage?: unknown },
) => Promise<{ value: string }>;

async function extractDocx(base: Base, file: File): Promise<ExtractResult> {
  const arrayBuffer = await file.arrayBuffer();
  const files = new Map<string, Blob>();
  const parts: BrowserPart[] = [];
  let figure = 0;
  const imageParts: BrowserPart[] = [];
  const convertImage = mammoth.images.imgElement(async (image: { contentType: string; readAsArrayBuffer(): Promise<ArrayBuffer> }) => {
    const data = new Uint8Array(await image.readAsArrayBuffer());
    const mediaType = usableEmbeddedImage(data);
    if (!mediaType || imageParts.length >= MAX_IMAGES) return { src: '' };
    figure += 1;
    const fileId = `${base.id}-fig${figure}.${IMAGE_EXTENSIONS[mediaType]}`;
    files.set(fileId, new Blob([toBlobPart(data)], { type: mediaType }));
    imageParts.push({ type: 'image', fileId, mediaType, label: `Figure ${figure}` });
    return { src: `figure:${figure}` };
  });
  const convert = (mammoth as unknown as { convertToMarkdown: MammothConvert }).convertToMarkdown;
  let markdown: string;
  try {
    markdown = (await convert({ arrayBuffer }, { convertImage })).value;
  } catch {
    throw new Error(`"${base.name}" could not be read as a Word document.`);
  }
  const text = markdown
    .replace(/!\[([^\]]*)\]\(figure:(\d+)\)/g, (_m, alt: string, n: string) => `[Figure ${n}${alt ? `: ${alt}` : ''}]`)
    .replace(/!\[[^\]]*\]\(\)/g, '')
    .replace(/\\([.\-_*#()[\]])/g, '$1')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text && imageParts.length === 0) throw new Error(`"${base.name}" contains no readable text.`);
  parts.push({ type: 'text', text: text || '(no text)', label: 'Document text' }, ...imageParts);
  const words = countWords(text);
  const summary = imageParts.length ? `${plural(words, 'word')} · ${plural(imageParts.length, 'image')}` : plural(words, 'word');
  return { material: { ...base, parts, summary, imageCount: imageParts.length }, files };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function extractImage(base: Base, file: File): Promise<ExtractResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(bytes);
  if (!sniffed) throw new Error(`"${base.name}" is not a PNG, JPEG, GIF or WebP image.`);
  let blob: Blob = new Blob([bytes], { type: sniffed });
  let mediaType: ImageMediaType = sniffed;
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    const tooBig = bytes.byteLength > MAX_IMAGE_FILE_BYTES || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION;
    if (tooBig) {
      const scale = Math.min(1, RESIZED_LONG_EDGE / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const keepPng = sniffed === 'image/png';
      const resized = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, keepPng ? 'image/png' : 'image/jpeg', 0.85));
      if (!resized) throw new Error('canvas.toBlob failed');
      blob = resized.size > MAX_IMAGE_FILE_BYTES && keepPng
        ? ((await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))) ?? resized)
        : resized;
      mediaType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      width = canvas.width;
      height = canvas.height;
    }
    bitmap.close();
  } catch {
    if (bytes.byteLength > MAX_IMAGE_FILE_BYTES) {
      throw new Error(`"${base.name}" is larger than 4.5 MB and could not be resized in this browser.`);
    }
  }
  const fileId = `${base.id}.${IMAGE_EXTENSIONS[mediaType]}`;
  return {
    material: { ...base, parts: [{ type: 'image', fileId, mediaType }], summary: width && height ? `Image ${width}×${height}` : 'Image' },
    files: new Map([[fileId, blob]]),
  };
}

function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function usableEmbeddedImage(data: Uint8Array): ImageMediaType | null {
  if (data.byteLength < MIN_EMBEDDED_IMAGE_BYTES || data.byteLength > MAX_EMBEDDED_IMAGE_BYTES) return null;
  return sniffImageType(data);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

async function extractText(base: Base, file: File): Promise<ExtractResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  let text: string;
  try {
    text = utf16 ? new TextDecoder(utf16).decode(bytes.subarray(2)) : new TextDecoder('utf-8').decode(bytes);
  } catch {
    text = new TextDecoder('utf-8').decode(bytes);
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (text.includes('\u0000')) throw new Error(`"${base.name}" does not look like a text file.`);
  if (!text.trim()) throw new Error(`"${base.name}" is empty.`);
  return { material: { ...base, parts: [{ type: 'text', text, label: base.name }], summary: plural(countWords(text), 'word') }, files: new Map() };
}

// ---------------------------------------------------------------------------
// OOXML helpers (DrawingML text, relationships, zip access)
// ---------------------------------------------------------------------------

async function readRels(zip: JSZip, partPath: string): Promise<RelMap> {
  const rels: RelMap = new Map();
  const dir = posixDirname(partPath);
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${posixBasename(partPath)}.rels`;
  const xml = await readZipText(zip, relsPath);
  if (!xml) return rels;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(m[1]);
    if (!attrs.Id || !attrs.Target) continue;
    const external = attrs.TargetMode === 'External';
    rels.set(attrs.Id, { id: attrs.Id, type: attrs.Type ?? '', target: external ? attrs.Target : resolveZipPath(dir, attrs.Target), external });
  }
  return rels;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decodeXml(m[2] ?? m[3] ?? '');
  return attrs;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function resolveZipPath(baseDir: string, target: string): string {
  let decoded = target.replace(/\\/g, '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* literal percent sign */
  }
  const clean = decoded.replace(/^\/+/, '');
  const joined = target.startsWith('/') || !baseDir ? clean : `${baseDir}/${clean}`;
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function drawingMlText(xml: string): string {
  const blocks: string[] = [];
  const source = xml
    .replace(/<a:fld\b[^>]*\btype="slidenum"[^>]*\/>/g, '')
    .replace(/<a:fld\b(?![^>]*\/>)[^>]*\btype="slidenum"[^>]*>[\s\S]*?<\/a:fld>/g, '');
  for (const m of source.matchAll(/<a:tbl\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/a:tbl>|<(p:txBody|dgm:t)\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/\1>/g)) {
    const text = m[0].startsWith('<a:tbl') ? tableText(m[0]) : paragraphsText(m[0]).join('\n');
    if (text.trim()) blocks.push(text.trim());
  }
  return blocks.join('\n\n');
}

function paragraphsText(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<a:p\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let text = '';
    for (const r of p[1].matchAll(/<a:t\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*>/g)) text += r[1] === undefined ? '\n' : decodeXml(r[1]);
    if (text.trim()) paragraphs.push(text.replace(/[ \t]+$/g, ''));
  }
  return paragraphs;
}

function tableText(xml: string): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<a:tr\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<a:tc\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:tc>/g)) {
      cells.push(paragraphsText(cell[1]).join(' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
    }
    if (cells.some((c) => c)) rows.push(`| ${cells.join(' | ')} |`);
    if (rows.length === 1) rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
  }
  return rows.join('\n');
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

async function loadZip(bytes: ArrayBuffer, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(`This ${label} file could not be opened; it may be corrupted or not really a ${label}.`);
  }
}

function zipPaths(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir);
}

function findZipEntry(zip: JSZip, zipPath: string): JSZip.JSZipObject | null {
  const wanted = zipPath.replace(/^\/+/, '');
  const exact = zip.file(wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  for (const name of zipPaths(zip)) {
    if (name.replace(/^\/+/, '').toLowerCase() === lower) return zip.files[name];
  }
  return null;
}

async function readZipText(zip: JSZip, zipPath: string): Promise<string | null> {
  try {
    const entry = findZipEntry(zip, zipPath);
    return entry ? await entry.async('string') : null;
  } catch {
    return null;
  }
}

async function readZipBytes(zip: JSZip, zipPath: string): Promise<Uint8Array | null> {
  try {
    const entry = findZipEntry(zip, zipPath);
    return entry ? await entry.async('uint8array') : null;
  } catch {
    return null;
  }
}

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
}
