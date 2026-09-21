/**
 * Tests for server/lib/extract.ts.
 *
 * Run: node --import tsx --test server/lib/extract.test.ts
 *
 * Every fixture (PPTX, DOCX, PDF, images, text) is generated programmatically
 * into a temp directory, so nothing binary is committed. Set EXTRACT_TEST_KEEP=1
 * to keep that directory (its path is printed) for poking at the fixtures.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import JSZip from 'jszip';
import { Jimp } from 'jimp';
import { PDFDocument } from 'pdf-lib';
import {
  SUPPORTED_EXTENSIONS,
  detectKind,
  extractMaterial,
  findSoffice,
  type ExtractInput,
  type ExtractedMaterial,
  type MaterialPart,
} from './extract.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';
const PML_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function relsXml(entries: Array<[id: string, type: string, target: string]>): string {
  const body = entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('');
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function contentTypesXml(overrides: Array<[partName: string, contentType: string]>): string {
  const defaults =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>';
  const body = overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('');
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${body}</Types>`;
}

/** A deterministic noisy PNG (incompressible, so it lands well above the 3 KB icon threshold). */
async function noisePng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height });
  let seed = 0x2545f491;
  for (let i = 0; i < image.bitmap.data.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    image.bitmap.data[i] = i % 4 === 3 ? 255 : (seed >>> 16) & 0xff;
  }
  return image.getBuffer('image/png');
}

/** A tiny solid PNG (well under 3 KB, i.e. icon-sized). */
async function solidPng(width: number, height: number, color = 0x3366ccff): Promise<Buffer> {
  return new Jimp({ width, height, color }).getBuffer('image/png');
}

const GROUP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function run(text: string, sz = 2400): string {
  return `<a:r><a:rPr lang="en-US" sz="${sz}" dirty="0"/><a:t>${text}</a:t></a:r>`;
}

function para(...runs: string[]): string {
  return `<a:p>${runs.join('')}</a:p>`;
}

function textBox(id: number, y: number, paragraphs: string): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="1143000"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

function picture(id: number, rId: string, y: number): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="1524000" y="${y}"/><a:ext cx="3048000" cy="2286000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function slideXml(shapes: string): string {
  return `${XML_HEAD}<p:sld ${PML_NS}><p:cSld><p:spTree>${GROUP_HEADER}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function notesXml(notesParagraphs: string, slideNumber: number): string {
  const placeholder = (id: number, type: string, body: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Placeholder ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="${type}"${type === 'body' ? ' idx="1"' : type === 'sldNum' ? ' sz="quarter" idx="10"' : ''}/></p:nvPr></p:nvSpPr><p:spPr/>${body}</p:sp>`;
  const slideNumberField =
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">` +
    `<a:rPr lang="en-US"/><a:t>${slideNumber}</a:t></a:fld></a:p></p:txBody>`;
  return (
    `${XML_HEAD}<p:notes ${PML_NS}><p:cSld><p:spTree>${GROUP_HEADER}` +
    placeholder(2, 'sldImg', '') +
    placeholder(3, 'body', `<p:txBody><a:bodyPr/><a:lstStyle/>${notesParagraphs}</p:txBody>`) +
    placeholder(4, 'sldNum', slideNumberField) +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
}

function themeXml(name: string): string {
  const accent = (n: number, hex: string) => `<a:accent${n}><a:srgbClr val="${hex}"/></a:accent${n}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return (
    `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>` +
    '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    accent(1, '4472C4') + accent(2, 'ED7D31') + accent(3, 'A5A5A5') + accent(4, 'FFC000') + accent(5, '5B9BD5') + accent(6, '70AD47') +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="DejaVu Sans"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="DejaVu Sans"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
  );
}

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

interface PptxFixtureOptions {
  /** Slide file numbers in the order presentation.xml should list them (default 1, 2, 3). */
  presentationOrder?: number[];
  /** Leave out every slide's .rels part (so notes and pictures cannot be resolved). */
  dropSlideRels?: boolean;
  /** Omit ppt/presentation.xml entirely. */
  dropPresentation?: boolean;
}

/**
 * A 3-slide deck: slide 1 has a title and body text (one paragraph is split
 * across two runs and contains an entity), slide 2 has speaker notes, slide 3
 * has one real picture plus an icon-sized one. The deck carries a master,
 * layout, theme and notes master so LibreOffice can open it too.
 */
async function buildPptx(file: string, opts: PptxFixtureOptions = {}): Promise<string> {
  const order = opts.presentationOrder ?? [1, 2, 3];
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    contentTypesXml([
      ['/ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`],
      ['/ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`],
      ['/ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`],
      ['/ppt/notesMasters/notesMaster1.xml', `${CT}.presentationml.notesMaster+xml`],
      ['/ppt/theme/theme1.xml', `${CT}.theme+xml`],
      ['/ppt/theme/theme2.xml', `${CT}.theme+xml`],
      ['/ppt/slides/slide1.xml', `${CT}.presentationml.slide+xml`],
      ['/ppt/slides/slide2.xml', `${CT}.presentationml.slide+xml`],
      ['/ppt/slides/slide3.xml', `${CT}.presentationml.slide+xml`],
      ['/ppt/notesSlides/notesSlide1.xml', `${CT}.presentationml.notesSlide+xml`],
    ]),
  );
  zip.file('_rels/.rels', relsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']]));

  if (!opts.dropPresentation) {
    const slideIds = order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + n}"/>`).join('');
    zip.file(
      'ppt/presentation.xml',
      `${XML_HEAD}<p:presentation ${PML_NS} saveSubsetFonts="1">` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
        `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
        '<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/>' +
        '</p:presentation>',
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      relsXml([
        ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
        ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
        ['rId3', 'theme', 'theme/theme1.xml'],
        ['rId11', 'slide', 'slides/slide1.xml'],
        ['rId12', 'slide', 'slides/slide2.xml'],
        ['rId13', 'slide', 'slides/slide3.xml'],
      ]),
    );
  }

  // Master / layout / notes master / themes: the minimum LibreOffice needs to open the deck.
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML_HEAD}<p:sldMaster ${PML_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
      `<p:spTree>${GROUP_HEADER}</p:spTree></p:cSld>${CLR_MAP}` +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '<p:txStyles><p:titleStyle><a:lvl1pPr/></p:titleStyle><p:bodyStyle><a:lvl1pPr/></p:bodyStyle><p:otherStyle><a:lvl1pPr/></p:otherStyle></p:txStyles>' +
      '</p:sldMaster>',
  );
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relsXml([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'theme', '../theme/theme1.xml'],
    ]),
  );
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML_HEAD}<p:sldLayout ${PML_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_HEADER}</p:spTree></p:cSld>` +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
  );
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  zip.file(
    'ppt/notesMasters/notesMaster1.xml',
    `${XML_HEAD}<p:notesMaster ${PML_NS}><p:cSld><p:spTree>${GROUP_HEADER}</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`,
  );
  zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', relsXml([['rId1', 'theme', '../theme/theme2.xml']]));
  zip.file('ppt/theme/theme1.xml', themeXml('Office Theme'));
  zip.file('ppt/theme/theme2.xml', themeXml('Notes Theme'));

  // Slides are added out of numeric order on purpose: zip entry order must not matter.
  zip.file(
    'ppt/slides/slide3.xml',
    slideXml(textBox(2, 274638, para(run('Slide three has a picture', 3200))) + picture(3, 'rId2', 1905000) + picture(4, 'rId3', 4500000)),
  );
  zip.file(
    'ppt/slides/slide1.xml',
    slideXml(
      textBox(2, 274638, para(run('Cell Biology 101', 3200))) +
        textBox(3, 1600200, para(run('Mitochondria are the powerhouse of the cell')) + para(run('Krebs '), run('cycle &amp; ATP'))),
    ),
  );
  zip.file('ppt/slides/slide2.xml', slideXml(textBox(2, 274638, para(run('Slide two: DNA replication', 3200)))));

  if (!opts.dropSlideRels) {
    zip.file('ppt/slides/_rels/slide1.xml.rels', relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      relsXml([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'],
      ]),
    );
    zip.file(
      'ppt/slides/_rels/slide3.xml.rels',
      relsXml([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', '../media/image1.png'],
        ['rId3', 'image', '../media/image2.png'],
      ]),
    );
  }

  zip.file('ppt/notesSlides/notesSlide1.xml', notesXml(para(run('Remember to mention helicase.', 1200)), 2));
  zip.file(
    'ppt/notesSlides/_rels/notesSlide1.xml.rels',
    relsXml([
      ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'],
      ['rId2', 'slide', '../slides/slide2.xml'],
    ]),
  );

  zip.file('ppt/media/image1.png', await noisePng(48, 48));
  zip.file('ppt/media/image2.png', await solidPng(2, 2));

  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

/** A minimal DOCX with two paragraphs and one inline picture (with alt text). */
async function buildDocx(file: string): Promise<string> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml([['/word/document.xml', `${CT}.wordprocessingml.document.main+xml`]]));
  zip.file('_rels/.rels', relsXml([['rId1', 'officeDocument', 'word/document.xml']]));
  zip.file('word/_rels/document.xml.rels', relsXml([['rId1', 'image', 'media/image1.png']]));
  const drawing =
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1828800" cy="1828800"/>' +
    '<wp:docPr id="1" name="Picture 1" descr="A diagram of the cell"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  zip.file(
    'word/document.xml',
    `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
      '<w:p><w:r><w:t>First paragraph about mitochondria.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph about ATP synthesis.</w:t></w:r></w:p>' +
      `<w:p>${drawing}</w:p>` +
      '<w:sectPr/></w:body></w:document>',
  );
  zip.file('word/media/image1.png', await noisePng(48, 48));
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

async function buildPdf(file: string, pages: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  await fs.writeFile(file, await doc.save());
  return file;
}

/** A WebP container with a VP8L header declaring the given dimensions (no real image data). */
function webpHeader(width: number, height: number): Buffer {
  const w = width - 1;
  const h = height - 1;
  const bits = Buffer.from([w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f]);
  const payload = Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(16)]);
  const chunk = Buffer.concat([Buffer.from('VP8L'), uint32(payload.length), payload]);
  return Buffer.concat([Buffer.from('RIFF'), uint32(4 + chunk.length), Buffer.from('WEBP'), chunk]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp: string;
let outDir: string;
let counter = 0;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-test-'));
  outDir = path.join(tmp, 'out');
  if (process.env.EXTRACT_TEST_KEEP) console.log(`[extract.test] fixtures in ${tmp}`);
});

after(async () => {
  if (!process.env.EXTRACT_TEST_KEEP) await fs.rm(tmp, { recursive: true, force: true });
});

function input(filePath: string, overrides: Partial<ExtractInput> = {}): ExtractInput {
  counter += 1;
  return {
    id: `m${counter}`,
    originalName: path.basename(filePath),
    mimeType: 'application/octet-stream',
    filePath,
    sizeBytes: 0,
    ...overrides,
  };
}

async function extract(filePath: string, overrides: Partial<ExtractInput> = {}, sofficePath: string | null = null): Promise<ExtractedMaterial> {
  const inp = input(filePath, overrides);
  inp.sizeBytes = inp.sizeBytes || (await fs.stat(filePath)).size;
  return extractMaterial(inp, { outDir, sofficePath });
}

function textPart(m: ExtractedMaterial, label: string): Extract<MaterialPart, { type: 'text' }> {
  const part = m.parts.find((p) => p.type === 'text' && p.label === label);
  assert.ok(part && part.type === 'text', `expected a text part labelled "${label}", got ${JSON.stringify(m.parts.map((p) => [p.type, 'label' in p ? p.label : '']))}`);
  return part;
}

function imageParts(m: ExtractedMaterial): Array<Extract<MaterialPart, { type: 'image' }>> {
  return m.parts.filter((p): p is Extract<MaterialPart, { type: 'image' }> => p.type === 'image');
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

/**
 * Debian/Ubuntu split LibreOffice into packages; a `libreoffice-core`-only
 * install has an `soffice` that cannot open presentations at all. Detect that
 * so the conversion test skips with a useful message instead of failing.
 */
async function sofficeHasImpress(soffice: string): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  try {
    const programDir = path.dirname(await fs.realpath(soffice));
    if (!(await exists(path.join(programDir, 'soffice.bin')))) return true; // not a LibreOffice tree we understand
    return exists(path.join(programDir, 'libsdlo.so'));
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// detectKind
// ---------------------------------------------------------------------------

describe('detectKind', () => {
  test('prefers the extension, case-insensitively', () => {
    assert.equal(detectKind('Lecture 3.PDF', 'application/octet-stream'), 'pdf');
    assert.equal(detectKind('deck.pptx', ''), 'pptx');
    assert.equal(detectKind('notes.docx', ''), 'docx');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) assert.equal(detectKind(`photo.${ext}`, ''), 'image', ext);
    for (const ext of ['txt', 'md', 'markdown', 'csv']) assert.equal(detectKind(`notes.${ext}`, ''), 'text', ext);
  });

  test('falls back to the MIME type when the extension is unknown', () => {
    assert.equal(detectKind('upload', 'application/pdf'), 'pdf');
    assert.equal(detectKind('upload.bin', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
    assert.equal(detectKind('upload', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
    assert.equal(detectKind('upload', 'image/jpeg'), 'image');
    assert.equal(detectKind('upload', 'text/plain; charset=utf-8'), 'text');
    assert.equal(detectKind('upload.log', 'text/x-log'), 'text');
  });

  test('returns null for unsupported files', () => {
    assert.equal(detectKind('setup.exe', 'application/octet-stream'), null);
    assert.equal(detectKind('old.ppt', 'application/vnd.ms-powerpoint'), null);
    assert.equal(detectKind('', ''), null);
  });

  test('SUPPORTED_EXTENSIONS matches detectKind', () => {
    assert.ok(SUPPORTED_EXTENSIONS.length >= 12);
    for (const ext of SUPPORTED_EXTENSIONS) {
      assert.ok(ext.startsWith('.'), ext);
      assert.notEqual(detectKind(`file${ext}`, ''), null, ext);
    }
  });
});

// ---------------------------------------------------------------------------
// Unsupported / invalid input
// ---------------------------------------------------------------------------

describe('unsupported files', () => {
  test('throws a user-readable error', async () => {
    const file = path.join(tmp, 'setup.exe');
    await fs.writeFile(file, 'MZ');
    await assert.rejects(extract(file), {
      message: 'Unsupported file type: .exe. Upload PDF, PPTX, DOCX, images (PNG/JPG/GIF/WebP) or text/markdown.',
    });
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe('text', () => {
  test('reads UTF-8, strips the BOM and normalises line endings', async () => {
    const file = path.join(tmp, 'notes.md');
    await fs.writeFile(file, '﻿# Notes\r\n\r\nOne two three four.\r\n');
    const m = await extract(file, { mimeType: 'text/markdown' });
    assert.equal(m.kind, 'text');
    assert.equal(m.name, 'notes.md');
    assert.equal(m.parts.length, 1);
    const part = textPart(m, 'notes.md');
    assert.equal(part.text, '# Notes\n\nOne two three four.\n');
    assert.equal(m.summary, '6 words');
    assert.equal(m.sizeBytes, (await fs.stat(file)).size);
  });

  test('rejects an empty file', async () => {
    const file = path.join(tmp, 'empty.txt');
    await fs.writeFile(file, '   \n');
    await assert.rejects(extract(file), /empty/);
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe('pdf', () => {
  test('counts pages and points at the original file', async () => {
    const file = await buildPdf(path.join(tmp, 'lecture.pdf'), 3);
    const m = await extract(file, { mimeType: 'application/pdf' });
    assert.equal(m.kind, 'pdf');
    assert.equal(m.pages, 3);
    assert.equal(m.summary, '3 pages');
    assert.deepEqual(m.parts, [{ type: 'pdf', path: file, pages: 3 }]);
    assert.ok(path.isAbsolute(m.parts[0].path));
  });

  test('accepts a PDF that pdf-lib cannot parse, with an unknown page count', async () => {
    const file = path.join(tmp, 'odd.pdf');
    await fs.writeFile(file, '%PDF-1.4\n%garbage that is not a real xref table\n');
    const m = await extract(file);
    assert.equal(m.pages, undefined);
    assert.equal(m.summary, 'PDF document');
    assert.equal(m.parts[0].type, 'pdf');
  });

  test('rejects files that are not PDFs at all', async () => {
    const file = path.join(tmp, 'fake.pdf');
    await fs.writeFile(file, 'hello');
    await assert.rejects(extract(file), /valid PDF/);
  });

  test('rejects PDFs over 600 pages', async () => {
    const file = await buildPdf(path.join(tmp, 'huge.pdf'), 601);
    await assert.rejects(extract(file), { message: 'This PDF has 601 pages; the limit is 600 pages per file. Please split it.' });
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('image', () => {
  test('small image: one image part pointing at the original', async () => {
    const file = path.join(tmp, 'diagram.png');
    await fs.writeFile(file, await solidPng(64, 48));
    const m = await extract(file, { mimeType: 'image/png' });
    assert.equal(m.kind, 'image');
    assert.equal(m.summary, 'Image 64×48');
    assert.deepEqual(m.parts, [{ type: 'image', path: file, mediaType: 'image/png' }]);
  });

  test('media type comes from the bytes, not the extension', async () => {
    const jpeg = await new Jimp({ width: 10, height: 10, color: 0xff0000ff }).getBuffer('image/jpeg');
    const file = path.join(tmp, 'actually-a-jpeg.png');
    await fs.writeFile(file, jpeg);
    const m = await extract(file);
    assert.equal(imageParts(m)[0].mediaType, 'image/jpeg');
  });

  test('oversized image is downscaled into outDir', async () => {
    const file = path.join(tmp, 'wide.png');
    await fs.writeFile(file, await solidPng(4500, 90));
    const m = await extract(file);
    const part = imageParts(m)[0];
    assert.equal(part.mediaType, 'image/png');
    assert.equal(part.path, path.join(outDir, `${m.id}.png`));
    assert.ok(await exists(part.path));
    const resized = await Jimp.read(part.path);
    assert.equal(resized.bitmap.width, 2000);
    assert.equal(resized.bitmap.height, 40);
    assert.equal(m.summary, 'Image 2000×40');
  });

  test('WebP dimensions are read from the header', async () => {
    const file = path.join(tmp, 'photo.webp');
    await fs.writeFile(file, webpHeader(100, 50));
    const m = await extract(file);
    assert.equal(m.summary, 'Image 100×50');
    assert.deepEqual(m.parts, [{ type: 'image', path: file, mediaType: 'image/webp' }]);
  });

  test('rejects a file that is not an image', async () => {
    const file = path.join(tmp, 'broken.png');
    await fs.writeFile(file, 'definitely not a png, just some text padding');
    await assert.rejects(extract(file), /not a valid PNG image/);
  });
});

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

describe('docx', () => {
  test('extracts markdown text and embedded figures', async () => {
    const file = await buildDocx(path.join(tmp, 'notes.docx'));
    const m = await extract(file);
    assert.equal(m.kind, 'docx');
    const text = textPart(m, 'Document text');
    assert.match(text.text, /First paragraph about mitochondria\./);
    assert.match(text.text, /Second paragraph about ATP synthesis\./);
    assert.match(text.text, /\[Figure 1: A diagram of the cell\]/);
    assert.doesNotMatch(text.text, /data:image/);

    const images = imageParts(m);
    assert.equal(images.length, 1);
    assert.equal(images[0].label, 'Figure 1');
    assert.equal(images[0].mediaType, 'image/png');
    assert.equal(images[0].path, path.join(outDir, `${m.id}-fig1.png`));
    assert.ok((await fs.stat(images[0].path)).size > 3 * 1024);
    assert.equal(m.imageCount, 1);
    assert.match(m.summary, /^\d+ words · 1 image$/);
    assert.equal(m.parts[0].type, 'text');
  });

  test('rejects a file that is not a DOCX', async () => {
    const file = path.join(tmp, 'bogus.docx');
    await fs.writeFile(file, 'not a zip');
    await assert.rejects(extract(file), /Word document/);
  });
});

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

describe('pptx', () => {
  test('text + images fallback when LibreOffice is not configured', async () => {
    const file = await buildPptx(path.join(tmp, 'deck.pptx'));
    const m = await extract(file, { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    assert.equal(m.kind, 'pptx');
    assert.equal(m.pages, 3);
    assert.equal(m.imageCount, 1);
    assert.equal(m.summary, '3 slides · 1 image');

    assert.equal(m.parts[0].type, 'text');
    const text = textPart(m, 'Slide text and speaker notes');
    const expected =
      '## Slide 1\nCell Biology 101\n\nMitochondria are the powerhouse of the cell\nKrebs cycle & ATP\n\n' +
      '## Slide 2\nSlide two: DNA replication\n\nSpeaker notes: Remember to mention helicase.\n\n' +
      '## Slide 3\nSlide three has a picture';
    assert.equal(text.text, expected);

    const images = imageParts(m);
    assert.equal(images.length, 1, 'the icon-sized picture is skipped');
    assert.deepEqual(images[0], {
      type: 'image',
      path: path.join(outDir, `${m.id}-slide3-1.png`),
      mediaType: 'image/png',
      label: 'Slide 3, image 1',
    });
    const written = await fs.readFile(images[0].path);
    assert.ok(written.length > 3 * 1024);
    assert.deepEqual(written.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test('slides follow presentation.xml order, not file numbering', async () => {
    const file = await buildPptx(path.join(tmp, 'reordered.pptx'), { presentationOrder: [3, 1, 2] });
    const m = await extract(file);
    const text = textPart(m, 'Slide text and speaker notes').text;
    assert.match(text, /^## Slide 1\nSlide three has a picture/);
    assert.match(text, /## Slide 2\nCell Biology 101/);
    assert.match(text, /## Slide 3\nSlide two: DNA replication\n\nSpeaker notes: Remember to mention helicase\./);
    assert.equal(imageParts(m)[0].label, 'Slide 1, image 1');
  });

  test('falls back to numeric slide order without presentation.xml', async () => {
    const file = await buildPptx(path.join(tmp, 'no-presentation.pptx'), { dropPresentation: true });
    const m = await extract(file);
    const text = textPart(m, 'Slide text and speaker notes').text;
    assert.match(text, /^## Slide 1\nCell Biology 101/);
    assert.match(text, /## Slide 3\nSlide three has a picture$/);
  });

  test('degrades gracefully when slide relationships are missing', async () => {
    const file = await buildPptx(path.join(tmp, 'no-rels.pptx'), { dropSlideRels: true });
    const m = await extract(file);
    assert.equal(m.summary, '3 slides');
    assert.equal(m.imageCount, 0);
    const text = textPart(m, 'Slide text and speaker notes').text;
    assert.doesNotMatch(text, /Speaker notes/);
    assert.match(text, /## Slide 3\nSlide three has a picture$/);
  });

  test('handles empty runs, line breaks, slide-number fields and tables', async () => {
    // A bare deck: just one slide part, no presentation.xml, no rels.
    const zip = new JSZip();
    const body =
      '<p:txBody><a:bodyPr/><a:lstStyle/>' +
      '<a:p><a:r><a:rPr lang="en-US"/><a:t/></a:r><a:r><a:t>Line one</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:r><a:t>Line two</a:t></a:r></a:p>' +
      '<a:p/>' +
      '<a:p><a:fld id="{0F2E5A7B-1C3D-4E5F-8A9B-0C1D2E3F4A5B}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld></a:p>' +
      '</p:txBody>';
    const cell = (text: string) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
    const table =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>' +
      `<a:tr h="370840">${cell('Term')}${cell('Definition')}</a:tr><a:tr h="370840">${cell('ATP')}${cell('Energy currency')}</a:tr>` +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    zip.file(
      'ppt/slides/slide1.xml',
      `${XML_HEAD}<p:sld ${PML_NS}><p:cSld><p:spTree>${GROUP_HEADER}<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr/>${body}</p:sp>${table}</p:spTree></p:cSld></p:sld>`,
    );
    const file = path.join(tmp, 'bare.pptx');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const m = await extract(file);
    assert.equal(m.summary, '1 slide');
    assert.equal(
      textPart(m, 'Slide text and speaker notes').text,
      '## Slide 1\nLine one\nLine two\n\n| Term | Definition |\n| --- | --- |\n| ATP | Energy currency |',
    );
  });

  test('rejects a file that is not a PPTX', async () => {
    const file = path.join(tmp, 'bogus.pptx');
    await fs.writeFile(file, 'not a zip');
    await assert.rejects(extract(file), /could not be opened/);
  });

  test('falls back to text + images when the converter produces nothing', { skip: process.platform === 'win32' }, async () => {
    const fake = path.join(tmp, 'fake-soffice.sh');
    await fs.writeFile(fake, '#!/bin/sh\necho "Error: source file could not be loaded" >&2\nexit 0\n');
    await fs.chmod(fake, 0o755);
    const file = await buildPptx(path.join(tmp, 'deck-fallback.pptx'));
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const m = await extract(file, {}, fake);
      assert.equal(m.summary, '3 slides · 1 image');
      assert.equal(m.parts[0].type, 'text');
      assert.equal(imageParts(m).length, 1);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /source file could not be loaded/);
  });

  test('LibreOffice renders the deck to a PDF part plus speaker notes', async (t) => {
    const soffice = await findSoffice(process.env.SOFFICE_PATH);
    if (!soffice) return t.skip('LibreOffice with Impress not found (set SOFFICE_PATH to test conversion)');
    if (!(await sofficeHasImpress(soffice))) {
      return t.skip(`${soffice} belongs to a LibreOffice install without Impress (install libreoffice-impress)`);
    }

    const file = await buildPptx(path.join(tmp, 'deck-render.pptx'));
    const m = await extract(file, {}, soffice);
    assert.equal(m.summary, '3 slides (rendered to PDF)');
    assert.equal(m.pages, 3);
    assert.equal(m.parts.length, 2);

    const pdf = m.parts[0];
    assert.equal(pdf.type, 'pdf');
    assert.ok(pdf.type === 'pdf');
    assert.equal(pdf.path, path.join(outDir, `${m.id}.pdf`));
    assert.ok(await exists(pdf.path), 'converted PDF exists');
    assert.equal(pdf.pages, 3);
    assert.equal(pdf.fileId, undefined);
    const rendered = await PDFDocument.load(await fs.readFile(pdf.path));
    assert.equal(rendered.getPageCount(), 3);

    const notes = textPart(m, 'Speaker notes');
    assert.equal(notes.text, '## Slide 2\nRemember to mention helicase.');
    assert.doesNotMatch(notes.text, /Mitochondria/);
  });
});
