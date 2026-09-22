/**
 * Material extraction.
 *
 * Turns an uploaded study file (PDF, PPTX, DOCX, image or plain text/markdown)
 * into `parts` that the server later sends to the Claude API as content blocks:
 *
 *   - `pdf`   parts become document blocks (the file itself is sent),
 *   - `image` parts become image blocks,
 *   - `text`  parts become text blocks.
 *
 * Everything derived from an upload (a PDF rendered from a deck, extracted or
 * resized images) is written to `opts.outDir`; the caller owns that directory.
 * `fileId` on a part is left undefined here and filled in by the module that
 * uploads files to the API.
 *
 * Dependencies are deliberately few: jszip + hand-rolled regex parsing for the
 * Office XML we need, mammoth for DOCX text, pdf-lib for page counts, jimp for
 * image dimensions/downscaling, and LibreOffice (optional, external) to render
 * PPTX decks to PDF so the model sees slides exactly as laid out.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { Jimp } from 'jimp';
import { PDFDocument } from 'pdf-lib';
import type { MaterialKind } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MaterialPart =
  | { type: 'pdf'; path: string; pages?: number; fileId?: string; /** Extracted text for models without native PDF input. */ text?: string }
  | {
      type: 'image';
      path: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      label?: string;
      fileId?: string;
    }
  | { type: 'text'; text: string; label?: string };

export interface ExtractedMaterial {
  id: string;
  /** Original filename as uploaded. */
  name: string;
  kind: MaterialKind;
  sizeBytes: number;
  parts: MaterialPart[];
  /** Short human summary, e.g. "42 slides · 12 images", "18 pages", "Image 1920×1080", "1,204 words". */
  summary: string;
  /** Pages or slides when known. */
  pages?: number;
  imageCount?: number;
}

export interface ExtractOptions {
  /** Absolute directory for derived files (converted PDFs, extracted/resized images). Created if missing. */
  outDir: string;
  /** Absolute path to LibreOffice's `soffice`, or null to disable PPTX → PDF conversion. */
  sofficePath: string | null;
  /** Cap on embedded images extracted from a deck or document. Default 40. */
  maxImages?: number;
}

export interface ExtractInput {
  id: string;
  originalName: string;
  mimeType: string;
  filePath: string;
  sizeBytes: number;
}

type ImageMediaType = Extract<MaterialPart, { type: 'image' }>['mediaType'];

// ---------------------------------------------------------------------------
// Limits and lookup tables
// ---------------------------------------------------------------------------

const EXTENSION_KINDS: Readonly<Record<string, MaterialKind>> = {
  '.pdf': 'pdf',
  '.pptx': 'pptx',
  '.docx': 'docx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.csv': 'text',
};

export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_KINDS);

const MIME_KINDS: Readonly<Record<string, MaterialKind>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
};

const IMAGE_EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The API rejects PDFs above this many pages, so refuse them up front with a clear message. */
const MAX_PDF_PAGES = 600;
const DEFAULT_MAX_IMAGES = 40;
/** Embedded pictures smaller than this are almost always icons, bullets or logos. */
const MIN_EMBEDDED_IMAGE_BYTES = 3 * 1024;
const MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024;
/** Standalone images above either limit are downscaled before being sent. */
const MAX_IMAGE_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4000;
const RESIZED_LONG_EDGE = 2000;
const SOFFICE_TIMEOUT_MS = 240_000;

const WELL_KNOWN_SOFFICE_PATHS: readonly string[] = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  path.join(os.homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/opt/libreoffice/program/soffice',
  '/snap/bin/libreoffice',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Classify an upload by extension first, then by MIME type. Returns null when unsupported. */
export function detectKind(originalName: string, mimeType: string): MaterialKind | null {
  const ext = path.extname(originalName ?? '').toLowerCase();
  if (ext && EXTENSION_KINDS[ext]) return EXTENSION_KINDS[ext];
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (MIME_KINDS[mime]) return MIME_KINDS[mime];
  if (mime.startsWith('text/')) return 'text';
  return null;
}

/**
 * Locate LibreOffice's `soffice` binary.
 *   - `'off'`            → null (conversion disabled by configuration)
 *   - an explicit path   → that path if it exists, otherwise null
 *   - blank / undefined  → the first of `soffice`/`libreoffice` on PATH, then well-known install
 *                          locations, skipping installs that cannot open presentations (see below)
 */
export async function findSoffice(configured?: string): Promise<string | null> {
  const value = (configured ?? '').trim();
  if (value.toLowerCase() === 'off') return null;
  if (value) {
    if (!(await isFile(value))) return null;
    const resolved = path.resolve(value);
    if (!(await hasImpressComponent(resolved))) {
      console.warn(`[extract] LibreOffice at ${resolved} has no Impress component; PPTX conversion will fail until libreoffice-impress is installed.`);
    }
    return resolved;
  }

  const names = process.platform === 'win32' ? ['soffice.exe', 'soffice.com', 'soffice'] : ['soffice', 'libreoffice'];
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) for (const name of names) candidates.push(path.join(dir, name));
  }
  candidates.push(...WELL_KNOWN_SOFFICE_PATHS);
  for (const candidate of candidates) {
    if ((await isFile(candidate)) && (await hasImpressComponent(candidate))) return candidate;
  }
  return null;
}

/**
 * Debian/Ubuntu (and Fedora) split LibreOffice into packages; a `libreoffice-core`-only
 * install ships an `soffice` that cannot open presentations at all ("source file could
 * not be loaded"). Recognise that layout by the missing Impress/Draw library next to
 * `soffice.bin`; any other layout (macOS bundle, Windows, snap, AppImage) is assumed complete.
 */
async function hasImpressComponent(sofficePath: string): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  try {
    const programDir = path.dirname(await fs.realpath(sofficePath));
    if (!(await isFile(path.join(programDir, 'soffice.bin')))) return true;
    return await isFile(path.join(programDir, 'libsdlo.so'));
  } catch {
    return true;
  }
}

/**
 * Extract an uploaded file into parts. Throws an Error with a user-readable
 * message when the file is unsupported or invalid.
 */
export async function extractMaterial(input: ExtractInput, opts: ExtractOptions): Promise<ExtractedMaterial> {
  const kind = detectKind(input.originalName, input.mimeType);
  if (!kind) {
    const ext = path.extname(input.originalName ?? '').toLowerCase() || input.mimeType || 'unknown';
    throw new Error(`Unsupported file type: ${ext}. Upload PDF, PPTX, DOCX, images (PNG/JPG/GIF/WebP) or text/markdown.`);
  }

  const outDir = path.resolve(opts.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.resolve(input.filePath);
  const base = { id: input.id, name: input.originalName, kind, sizeBytes: input.sizeBytes };
  const maxImages = Math.max(0, opts.maxImages ?? DEFAULT_MAX_IMAGES);

  switch (kind) {
    case 'pdf':
      return extractPdf(base, filePath);
    case 'pptx':
      return extractPptx(base, filePath, outDir, opts.sofficePath, maxImages);
    case 'docx':
      return extractDocx(base, filePath, outDir, maxImages);
    case 'image':
      return extractImage(base, filePath, input.mimeType, outDir);
    case 'text':
      return extractText(base, filePath);
  }
}

type MaterialBase = Pick<ExtractedMaterial, 'id' | 'name' | 'kind' | 'sizeBytes'>;

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Longest PDF text kept for text-only models (about 100k tokens). */
const MAX_PDF_TEXT_CHARS = 400_000;

/** Page text through pdf.js, for models without native PDF input. Undefined when the file cannot be read. */
export async function pdfText(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = `${path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))}/standard_fonts/`;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, standardFontDataUrl, verbosity: 0 });
    const doc = await task.promise;
    try {
      const chunks: string[] = [];
      let length = 0;
      for (let i = 1; i <= doc.numPages && length < MAX_PDF_TEXT_CHARS; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        page.cleanup();
        if (text) {
          const chunk = `[Page ${i}]\n${text}`;
          chunks.push(chunk);
          length += chunk.length;
        }
      }
      return chunks.join('\n\n') || undefined;
    } finally {
      await task.destroy();
    }
  } catch {
    return undefined;
  }
}

async function extractPdf(base: MaterialBase, filePath: string): Promise<ExtractedMaterial> {
  const bytes = await fs.readFile(filePath);
  // The header may be preceded by a little junk; PDF readers tolerate that, so look within the first KB.
  if (!bytes.subarray(0, 1024).includes('%PDF')) {
    throw new Error(`"${base.name}" does not look like a valid PDF file.`);
  }
  const pages = await countPdfPages(bytes);
  if (pages !== undefined && pages > MAX_PDF_PAGES) {
    throw new Error(`This PDF has ${pages} pages; the limit is ${MAX_PDF_PAGES} pages per file. Please split it.`);
  }
  if (pages === 0) throw new Error(`"${base.name}" has no pages.`);
  const text = await pdfText(bytes);
  return {
    ...base,
    parts: [{ type: 'pdf', path: filePath, pages, ...(text ? { text } : {}) }],
    summary: pages === undefined ? 'PDF document' : formatCount(pages, 'page'),
    pages,
  };
}

/** Page count via pdf-lib; undefined when the file cannot be parsed (it is still accepted). */
async function countPdfPages(bytes: Uint8Array): Promise<number | undefined> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

interface SlideInfo {
  /** 1-based position in the presentation. */
  number: number;
  text: string;
  notes: string;
  /** Zip paths of the pictures placed on the slide, in document order. */
  pictures: string[];
}

async function extractPptx(
  base: MaterialBase,
  filePath: string,
  outDir: string,
  sofficePath: string | null,
  maxImages: number,
): Promise<ExtractedMaterial> {
  const zip = await loadZip(await fs.readFile(filePath), 'PPTX');
  const slides = await readSlides(zip);
  if (slides.length === 0) throw new Error(`No slides were found in "${base.name}".`);

  // Preferred path: render the deck to PDF so the model sees every slide as laid out.
  if (sofficePath) {
    try {
      const pdfPath = await convertToPdfWithSoffice(sofficePath, filePath, base.id, '.pptx', outDir);
      const pages = await countPdfPages(await fs.readFile(pdfPath));
      const parts: MaterialPart[] = [{ type: 'pdf', path: pdfPath, pages }];
      const notes = formatSpeakerNotes(slides);
      if (notes) parts.push({ type: 'text', text: notes, label: 'Speaker notes' });
      return { ...base, parts, summary: `${formatCount(slides.length, 'slide')} (rendered to PDF)`, pages: slides.length };
    } catch (err) {
      console.warn(`[extract] LibreOffice conversion of "${base.name}" failed, falling back to text + images: ${errorMessage(err)}`);
    }
  }

  // Fallback: slide text (with notes) plus the pictures embedded in the deck.
  const images = await writeSlidePictures(zip, slides, base.id, outDir, maxImages);
  const parts: MaterialPart[] = [
    { type: 'text', text: formatSlideText(slides), label: 'Slide text and speaker notes' },
    ...images,
  ];
  const summary = images.length
    ? `${formatCount(slides.length, 'slide')} · ${formatCount(images.length, 'image')}`
    : formatCount(slides.length, 'slide');
  return { ...base, parts, summary, pages: slides.length, imageCount: images.length };
}

/** Read every slide (in presentation order) with its text, speaker notes and picture references. */
async function readSlides(zip: JSZip): Promise<SlideInfo[]> {
  const slidePaths = await orderedSlidePaths(zip);
  const slides: SlideInfo[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const xml = (await readZipText(zip, slidePath)) ?? '';
    const rels = await readRels(zip, slidePath);
    let text = drawingMlText(xml);
    const diagramText = await readDiagramText(zip, rels);
    if (diagramText) text = text ? `${text}\n\n${diagramText}` : diagramText;
    slides.push({
      number: index + 1,
      text,
      notes: await readSpeakerNotes(zip, rels),
      pictures: pictureTargets(xml, rels),
    });
  }
  return slides;
}

/**
 * Slide parts in the order the deck shows them. `ppt/presentation.xml` lists
 * slides in display order (file numbers go stale when slides are reordered),
 * so that list wins; when it is missing or unusable we sort `slideN.xml` by N.
 */
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
      if (rel && !rel.external && findZipEntry(zip, rel.target) && !ordered.includes(rel.target)) {
        ordered.push(rel.target);
      }
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
  // Notes pages carry placeholders for the slide thumbnail, number, date, header and footer.
  // Drop those when they hold nothing but a number (or nothing at all).
  const withoutPlaceholders = xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shape) =>
    /<p:ph\b[^>]*\btype="(?:sldNum|sldImg|dt|hdr|ftr)"/.test(shape) && /^[\s\d]*$/.test(drawingMlText(shape)) ? '' : shape,
  );
  return drawingMlText(withoutPlaceholders);
}

/** Text of SmartArt diagrams placed on the slide (their data lives in separate parts). */
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

/** Zip paths of the images referenced by `<p:pic>` elements, in document order. */
function pictureTargets(xml: string, rels: RelMap): string[] {
  const targets: string[] = [];
  for (const m of xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
    const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(m[0]);
    const rel = embed ? rels.get(embed[1]) : undefined;
    if (rel && !rel.external && rel.type.endsWith('/image')) targets.push(rel.target);
  }
  return targets;
}

/** Write the usable embedded pictures to `outDir` and return their parts. */
async function writeSlidePictures(
  zip: JSZip,
  slides: SlideInfo[],
  id: string,
  outDir: string,
  maxImages: number,
): Promise<MaterialPart[]> {
  const parts: MaterialPart[] = [];
  const seen = new Set<string>();
  for (const slide of slides) {
    let index = 0;
    for (const target of slide.pictures) {
      if (parts.length >= maxImages) return parts;
      if (seen.has(target)) continue;
      seen.add(target);
      const data = await readZipBuffer(zip, target);
      const mediaType = data && usableEmbeddedImage(data);
      if (!data || !mediaType) continue;
      index += 1;
      const dest = path.join(outDir, `${id}-slide${slide.number}-${index}.${IMAGE_EXTENSIONS[mediaType]}`);
      await fs.writeFile(dest, data);
      parts.push({ type: 'image', path: dest, mediaType, label: `Slide ${slide.number}, image ${index}` });
    }
  }
  return parts;
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

function formatSpeakerNotes(slides: SlideInfo[]): string {
  return slides
    .filter((slide) => slide.notes)
    .map((slide) => `## Slide ${slide.number}\n${slide.notes}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** mammoth ships no typings for convertToMarkdown, but it takes the same input/options as convertToHtml. */
type MammothConvert = (
  input: { path: string },
  options?: { convertImage?: ReturnType<typeof mammoth.images.imgElement> },
) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;

async function extractDocx(base: MaterialBase, filePath: string, outDir: string, maxImages: number): Promise<ExtractedMaterial> {
  const figures: MaterialPart[] = [];
  const figureByHash = new Map<string, number>();

  // Images are handled while mammoth walks the document, which keeps figure
  // numbers in the text and the image parts in the same (document) order.
  // Anything filtered out is replaced by its alt text or dropped.
  const convertImage = mammoth.images.imgElement(async (image) => {
    try {
      const data = await image.readAsBuffer();
      const mediaType = usableEmbeddedImage(data);
      if (!mediaType) return { src: '' };
      const hash = createHash('sha1').update(data).digest('hex');
      const existing = figureByHash.get(hash);
      if (existing) return { src: `figure-${existing}` };
      if (figures.length >= maxImages) return { src: '' };
      const number = figures.length + 1;
      figureByHash.set(hash, number);
      const dest = path.join(outDir, `${base.id}-fig${number}.${IMAGE_EXTENSIONS[mediaType]}`);
      await fs.writeFile(dest, data);
      figures.push({ type: 'image', path: dest, mediaType, label: `Figure ${number}` });
      return { src: `figure-${number}` };
    } catch {
      return { src: '' };
    }
  });

  let markdown: string;
  try {
    const convertToMarkdown = (mammoth as unknown as { convertToMarkdown: MammothConvert }).convertToMarkdown;
    markdown = (await convertToMarkdown({ path: filePath }, { convertImage })).value;
  } catch (err) {
    throw new Error(`Could not read "${base.name}" as a Word document; it may be corrupted or password-protected. (${errorMessage(err)})`);
  }

  const text = markdown
    .replace(/!\[([^\]]*)\]\(figure-(\d+)\)/g, (_m, alt: string, n: string) => (alt.trim() ? `[Figure ${n}: ${alt.trim()}]` : `[Figure ${n}]`))
    .replace(/!\[([^\]]*)\]\(\)/g, (_m, alt: string) => (alt.trim() ? `[Image: ${alt.trim()}]` : ''))
    // mammoth backslash-escapes Markdown punctuation in every text run ("e\.g\.", "2\-3"), which is
    // noise for a model reading the text. Undo it; a doubled backslash was a literal one.
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const words = countWords(text);
  if (words === 0 && figures.length === 0) throw new Error(`No text or images could be extracted from "${base.name}".`);

  const parts: MaterialPart[] = [];
  if (text) parts.push({ type: 'text', text, label: 'Document text' });
  parts.push(...figures);
  const summary = figures.length
    ? `${formatCount(words, 'word')} · ${formatCount(figures.length, 'image')}`
    : formatCount(words, 'word');
  return { ...base, parts, summary, imageCount: figures.length };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

async function extractImage(base: MaterialBase, filePath: string, mimeType: string, outDir: string): Promise<ExtractedMaterial> {
  const bytes = await fs.readFile(filePath);
  // Trust the bytes, not the extension: the API checks that the media type matches the data.
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    const claimed = path.extname(base.name).replace('.', '').toUpperCase() || mimeType || 'image';
    throw new Error(`"${base.name}" is not a valid ${claimed} image (or uses an unsupported variant).`);
  }

  let image: Awaited<ReturnType<typeof Jimp.read>> | null = null;
  let width: number | undefined;
  let height: number | undefined;
  try {
    // jimp decodes PNG/JPEG/GIF (first frame); WebP is not supported, so read its header by hand below.
    image = await Jimp.read(bytes);
    width = image.bitmap.width;
    height = image.bitmap.height;
  } catch {
    const size = sniffed === 'image/webp' ? readWebpSize(bytes) : null;
    if (size) ({ width, height } = size);
  }

  let partPath = filePath;
  let mediaType: ImageMediaType = sniffed;
  const tooLarge =
    bytes.length > MAX_IMAGE_FILE_BYTES ||
    (width !== undefined && width > MAX_IMAGE_DIMENSION) ||
    (height !== undefined && height > MAX_IMAGE_DIMENSION);

  if (tooLarge) {
    if (!image) {
      throw new Error(
        `"${base.name}" is too large (${formatMegabytes(bytes.length)}, ${width ?? '?'}×${height ?? '?'}) and cannot be resized automatically. Please export it as PNG or JPEG under ${formatMegabytes(MAX_IMAGE_FILE_BYTES)}.`,
      );
    }
    // Shrink to a 2000 px long edge, keeping PNG as PNG and JPEG as JPEG (q85). GIF becomes PNG.
    // If a PNG is still too big (photographs stored as PNG), fall back to JPEG, then shrink further.
    const preferred: ImageMediaType = sniffed === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const attempts: Array<{ edge: number; type: 'image/png' | 'image/jpeg' }> = [
      { edge: RESIZED_LONG_EDGE, type: preferred },
      { edge: RESIZED_LONG_EDGE, type: 'image/jpeg' },
      { edge: 1568, type: 'image/jpeg' },
    ];
    let written = false;
    for (const attempt of attempts) {
      const resized = image.clone();
      if (Math.max(resized.bitmap.width, resized.bitmap.height) > attempt.edge) {
        resized.scaleToFit({ w: attempt.edge, h: attempt.edge });
      }
      const out =
        attempt.type === 'image/jpeg'
          ? await resized.getBuffer('image/jpeg', { quality: 85 })
          : await resized.getBuffer('image/png');
      if (out.length > MAX_IMAGE_FILE_BYTES) continue;
      partPath = path.join(outDir, `${base.id}.${IMAGE_EXTENSIONS[attempt.type]}`);
      await fs.writeFile(partPath, out);
      mediaType = attempt.type;
      width = resized.bitmap.width;
      height = resized.bitmap.height;
      written = true;
      break;
    }
    if (!written) throw new Error(`"${base.name}" could not be reduced below ${formatMegabytes(MAX_IMAGE_FILE_BYTES)}. Please use a smaller image.`);
  }

  return {
    ...base,
    parts: [{ type: 'image', path: partPath, mediaType }],
    summary: width !== undefined && height !== undefined ? `Image ${width}×${height}` : 'Image',
    imageCount: 1,
  };
}

/** Detect PNG / JPEG / GIF / WebP from magic bytes. */
function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Dimensions from a WebP header (VP8, VP8L or VP8X chunk); null when unreadable. */
function readWebpSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  return null;
}

/** Media type of an embedded picture worth sending, or null (wrong format, icon-sized, or huge). */
function usableEmbeddedImage(data: Buffer): ImageMediaType | null {
  if (data.length < MIN_EMBEDDED_IMAGE_BYTES || data.length > MAX_EMBEDDED_IMAGE_BYTES) return null;
  return sniffImageType(data);
}

// ---------------------------------------------------------------------------
// Plain text / markdown
// ---------------------------------------------------------------------------

async function extractText(base: MaterialBase, filePath: string): Promise<ExtractedMaterial> {
  const bytes = await fs.readFile(filePath);
  const text = decodeTextFile(bytes).replace(/\r\n?/g, '\n');
  if (text.includes('\u0000')) throw new Error(`"${base.name}" does not look like a text file.`);
  if (!text.trim()) throw new Error(`"${base.name}" is empty.`);
  const words = countWords(text);
  return {
    ...base,
    parts: [{ type: 'text', text, label: base.name }],
    summary: formatCount(words, 'word'),
  };
}

/** UTF-8 by default; honours (and strips) UTF-8 / UTF-16 byte-order marks. */
function decodeTextFile(bytes: Buffer): string {
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (utf16) {
    try {
      return new TextDecoder(utf16).decode(bytes.subarray(2));
    } catch {
      // Node built without ICU: fall through and treat it as UTF-8.
    }
  }
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// LibreOffice conversion
// ---------------------------------------------------------------------------

/** Conversions run one at a time: each launches a full LibreOffice process. */
let sofficeQueue: Promise<unknown> = Promise.resolve();

function withSofficeLock<T>(task: () => Promise<T>): Promise<T> {
  const run = sofficeQueue.then(task, task);
  sofficeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Render `inputPath` to `<outDir>/<id>.pdf` with LibreOffice and return that path.
 *
 * Each run gets a throwaway profile directory (`-env:UserInstallation`) so
 * concurrent or crashed instances never fight over the profile lock, the input
 * is copied to a plain ASCII path with the right extension (LibreOffice picks
 * the import filter by extension and can choke on exotic names), and the
 * output is produced in a private directory before being moved into place.
 */
async function convertToPdfWithSoffice(
  sofficePath: string,
  inputPath: string,
  id: string,
  inputExt: string,
  outDir: string,
): Promise<string> {
  return withSofficeLock(async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'study-agent-soffice-'));
    try {
      const profileDir = path.join(work, 'profile');
      const convertDir = path.join(work, 'out');
      const inputCopy = path.join(work, `${id}${inputExt}`);
      await fs.mkdir(profileDir);
      await fs.mkdir(convertDir);
      await fs.copyFile(inputPath, inputCopy);

      const args = [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--norestore',
        '--nologo',
        '--convert-to',
        'pdf',
        '--outdir',
        convertDir,
        inputCopy,
      ];
      const result = await runProcess(sofficePath, args, {
        timeoutMs: SOFFICE_TIMEOUT_MS,
        env: { ...process.env, HOME: process.env.HOME || work },
      });
      if (result.timedOut) throw new Error(`LibreOffice timed out after ${SOFFICE_TIMEOUT_MS / 1000}s`);

      // soffice exits 0 even when it could not load the file, so trust only the output.
      const produced = path.join(convertDir, `${id}.pdf`);
      if (!(await isFile(produced))) {
        const detail = lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.code ?? result.signal}`;
        throw new Error(`LibreOffice did not produce a PDF (${detail})`);
      }
      const dest = path.join(outDir, `${id}.pdf`);
      await moveFile(produced, dest);
      return dest;
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a process with a hard timeout. `soffice` is a launcher that starts
 * `soffice.bin` underneath it, so on timeout the whole process group is killed
 * (POSIX) rather than just the launcher.
 */
function runProcess(command: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 65_536) stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 65_536) stderr += chunk.toString(); });
    const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, opts.timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

// ---------------------------------------------------------------------------
// Office XML helpers (regex based; the inputs are machine-generated XML)
// ---------------------------------------------------------------------------

interface Rel {
  id: string;
  type: string;
  /** Zip path (already resolved against the source part), or the raw URL for external targets. */
  target: string;
  external: boolean;
}
type RelMap = Map<string, Rel>;

/** Relationships of an OOXML part (`x/y.xml` → `x/_rels/y.xml.rels`). Missing or malformed → empty map. */
async function readRels(zip: JSZip, partPath: string): Promise<RelMap> {
  const rels: RelMap = new Map();
  const dir = path.posix.dirname(partPath);
  const relsPath = path.posix.join(dir, '_rels', `${path.posix.basename(partPath)}.rels`);
  const xml = await readZipText(zip, relsPath);
  if (!xml) return rels;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = parseAttributes(m[1]);
    const id = attrs.Id;
    const target = attrs.Target;
    if (!id || !target) continue;
    const external = attrs.TargetMode === 'External';
    rels.set(id, {
      id,
      type: attrs.Type ?? '',
      target: external ? target : resolveZipPath(dir, target),
      external,
    });
  }
  return rels;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeXml(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** Resolve a relationship target against the directory of its source part. */
function resolveZipPath(baseDir: string, target: string): string {
  let decoded = target.replace(/\\/g, '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Not percent-encoded (a literal '%' in the name); use it as is.
  }
  const clean = decoded.replace(/^\/+/, '');
  const joined = target.startsWith('/') ? clean : path.posix.join(baseDir, clean);
  return path.posix.normalize(joined).replace(/^(\.\.\/)+/, '');
}

/**
 * Plain text of DrawingML content: every text body (`<p:txBody>`, SmartArt
 * `<dgm:t>`) and table (`<a:tbl>`) in document order. Runs within a paragraph
 * are joined without separators, paragraphs with newlines, blocks with blank
 * lines. Slide-number fields are dropped.
 */
function drawingMlText(xml: string): string {
  const blocks: string[] = [];
  const source = xml
    .replace(/<a:fld\b[^>]*\btype="slidenum"[^>]*\/>/g, '')
    .replace(/<a:fld\b(?![^>]*\/>)[^>]*\btype="slidenum"[^>]*>[\s\S]*?<\/a:fld>/g, '');
  // `(?![^>]*\/>)` keeps a self-closing empty element from being read as an opening tag.
  for (const m of source.matchAll(/<a:tbl\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/a:tbl>|<(p:txBody|dgm:t)\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/\1>/g)) {
    const text = m[0].startsWith('<a:tbl') ? tableText(m[0]) : paragraphsText(m[0]).join('\n');
    if (text.trim()) blocks.push(text.trim());
  }
  return blocks.join('\n\n');
}

/** One string per non-empty `<a:p>` paragraph. A line break (`<a:br>`) becomes a newline. */
function paragraphsText(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<a:p\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let text = '';
    for (const r of p[1].matchAll(/<a:t\b(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*>/g)) {
      text += r[1] === undefined ? '\n' : decodeXml(r[1]);
    }
    if (text.trim()) paragraphs.push(text.replace(/[ \t]+$/g, ''));
  }
  return paragraphs;
}

/** A DrawingML table as a Markdown table (one line per row). */
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

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

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

// ---------------------------------------------------------------------------
// Zip helpers
// ---------------------------------------------------------------------------

async function loadZip(bytes: Buffer, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(`This ${label} file could not be opened; it may be corrupted or not really a ${label}.`);
  }
}

function zipPaths(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir);
}

/** Case-insensitive, leading-slash-tolerant lookup (some generators are sloppy about part names). */
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

async function readZipBuffer(zip: JSZip, zipPath: string): Promise<Buffer | null> {
  try {
    const entry = findZipEntry(zip, zipPath);
    return entry ? await entry.async('nodebuffer') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Rename, falling back to copy + delete when source and destination are on different filesystems. */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src).catch(() => undefined);
  }
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function formatCount(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lastLine(output: string): string {
  return output.trim().split('\n').filter(Boolean).pop()?.trim() ?? '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
