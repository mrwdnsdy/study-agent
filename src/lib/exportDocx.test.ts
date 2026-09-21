/**
 * Exporter tests. Run with:
 *   node --import tsx --test src/lib/exportDocx.test.ts
 * Set EXPORT_TEST_OUT_DIR to also write sample.docx / sample.html for manual inspection.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { safeFilename } from './download';
import { markdownToDocx, markdownToDocxBlob, type DiagramImage } from './exportDocx';
import { markdownToStandaloneHtml } from './exportHtml';
import { classifyCallout, mdastToPlainText, parseMarkdown } from './markdownAst';

// ---------------------------------------------------------------------------
// A tiny valid PNG built by hand (RGBA, one solid colour).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function makePng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((1 + width * 4) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) raw.set(rgba, rowStart + 1 + x * 4);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const TINY_PNG = makePng(1, 1, [99, 102, 241, 255]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const stubRenderDiagram = async (): Promise<DiagramImage> => ({ data: toArrayBuffer(TINY_PNG), width: 1200, height: 800 });

const STUB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';

// ---------------------------------------------------------------------------
// Sample study guide covering every construct the exporters handle.
// ---------------------------------------------------------------------------
const SAMPLE = `# Enzyme Kinetics Study Guide

Prepared for the *Biochemistry 201* module — a naïve overview with **bold**, *italic*, ~~struck~~ and \`inline code\` text → done.

## Core Concepts

Enzymes lower the activation energy. See [the primary source](https://example.com/docs "Docs") and the note[^1].

### Michaelis–Menten Model

The rate is \`v = Vmax[S] / (Km + [S])\`.
This sentence continues on a soft line.

#### Assumptions

1. Steady state
2. Single substrate
   1. Nested first
   2. Nested second
3. No product inhibition

Restarting the count:

3. Counting restarts at three
4. And continues

- Bullet one with **emphasis**
  - Nested bullet
    - Deeply nested bullet
- Bullet two

- [x] Completed task
- [ ] Open task

| Process | Rate constant | Notes |
|:--------|:-------------:|------:|
| Hydrolysis | k1 | Fast & irreversible |
| Binding | k2 | Slow |

\`\`\`python
def hello(name):
    return f"Hello, {name}"
\`\`\`

\`\`\`mermaid
flowchart LR
  E[Enzyme] --> ES[Complex] --> P[Product]
\`\`\`

> **💡 Gold-standard tip:** Always cite the primary source when reporting Km values.
>
> A second callout paragraph with \`code\`.

> **⚠️ Common pitfall:** Confusing Km with binding affinity.

> **📌 Exam alert:** Derive the equation from first principles.

> **🔑 Key concept:** Turnover number kcat.

> **✅ Best practice:** Plot Lineweaver–Burk carefully.

> **🧠 Memory aid:** "Km is half-max".

> Note: plain note callout without an emoji.

> Warning without a colon is still a pitfall.

> Just an ordinary quotation — Leonor Michaelis.

---

![Reaction coordinate diagram](https://example.com/reaction.png)

Comparison: 2 < 3 && 4 > 1, and never type <script>alert(1)</script> or \`<script>\` in notes.<br>Line after break.

<div class="wrapper">Block HTML text survives as plain text</div>

[^1]: A footnote about Michaelis and Menten (1913).
`;

function outDir(): string | null {
  const dir = process.env.EXPORT_TEST_OUT_DIR;
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------
test('markdownToDocx produces a valid package with every construct rendered', async () => {
  const progress: string[] = [];
  const bytes = await markdownToDocx(SAMPLE, {
    title: 'Enzyme Kinetics Study Guide',
    subtitle: 'Biochemistry 201 · Week 4',
    author: 'Study Agent',
    renderDiagram: stubRenderDiagram,
    onProgress: (message) => progress.push(message),
  });

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x50, 'starts with the ZIP signature (P)');
  assert.equal(bytes[1], 0x4b, 'starts with the ZIP signature (K)');
  assert.ok(progress.some((m) => /diagram 1 of 1/i.test(m)), 'reports diagram progress');

  const dir = outDir();
  if (dir) writeFileSync(join(dir, 'sample.docx'), bytes);

  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const read = async (name: string): Promise<string> => {
    const file = zip.file(name);
    assert.ok(file, `${name} exists`);
    return file!.async('string');
  };

  const document = await read('word/document.xml');
  // Headings, body text and inline formatting.
  assert.ok(document.includes('Core Concepts'), 'H2 text');
  assert.ok(document.includes('Michaelis–Menten Model'), 'H3 text with unicode dash');
  assert.ok(document.includes('Assumptions'), 'H4 text');
  assert.ok(document.includes('w:val="Heading2"'), 'heading style applied');
  assert.ok(document.includes('naïve'), 'accented text survives');
  assert.ok(document.includes('→ done'), 'unicode arrow survives');
  assert.ok(document.includes('💡'), 'emoji survives');
  assert.ok(document.includes('<w:strike/>'), 'strikethrough rendered');
  // Table.
  assert.ok(document.includes('<w:tbl>'), 'table element');
  assert.ok(document.includes('Hydrolysis'), 'table cell text');
  assert.ok(document.includes('Fast &amp; irreversible'), 'table cell text is XML-escaped');
  assert.ok(/w:fill="e0e7ff"/i.test(document), 'header row shading');
  // Callouts, quotes, rule.
  assert.ok(document.includes('Always cite the primary source when reporting Km values.'), 'callout text');
  assert.ok(/w:fill="f0fdf4"/i.test(document), 'tip callout background');
  assert.ok(/<w:left [^>]*w:color="16a34a"/i.test(document), 'tip callout coloured left border');
  assert.ok(/<w:left [^>]*w:color="d97706"/i.test(document), 'pitfall callout coloured left border');
  assert.ok(/<w:left [^>]*w:color="e11d48"/i.test(document), 'exam callout coloured left border');
  assert.ok(/w:fill="f8fafc"/i.test(document), 'note callout background');
  assert.ok(document.includes('Warning without a colon is still a pitfall.'), 'prefix-only callout text');
  assert.ok(document.includes('Just an ordinary quotation'), 'plain quote text');
  // Code.
  assert.ok(document.includes('def hello(name):'), 'code block text');
  assert.ok(document.includes('    return f&quot;Hello, {name}&quot;'), 'code block preserves indentation');
  assert.ok(/w:fill="f1f5f9"/i.test(document), 'code block shading');
  assert.ok(/w:ascii="Consolas"/.test(document), 'code font');
  assert.ok(document.includes('v = Vmax[S] / (Km + [S])'), 'inline code text');
  // Lists.
  assert.ok(document.includes('<w:numPr>'), 'real Word numbering used');
  assert.ok(document.includes('<w:ilvl w:val="2"/>'), 'third-level nesting');
  assert.ok(document.includes('☑'), 'checked task glyph');
  assert.ok(document.includes('☐'), 'unchecked task glyph');
  // Links, images, footnotes, html.
  assert.ok(document.includes('<w:hyperlink'), 'external hyperlink element');
  assert.ok(document.includes('Reaction coordinate diagram'), 'image alt text rendered');
  assert.ok(document.includes('[1]'), 'footnote reference');
  assert.ok(document.includes('A footnote about Michaelis and Menten'), 'footnote definition');
  assert.ok(document.includes('Block HTML text survives as plain text'), 'block html stripped to text');
  assert.ok(!document.includes('<div'), 'no raw html leaks');
  assert.ok(document.includes('Line after break'), 'text after inline <br>');
  // Diagram image, scaled to the page width with aspect ratio preserved.
  assert.ok(document.includes('<w:drawing>'), 'drawing element');
  const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(document);
  assert.ok(extent, 'image extent present');
  const cx = Number(extent![1]);
  const cy = Number(extent![2]);
  assert.ok(cx <= 602 * 9525 && cx >= 590 * 9525, `image fits the 6.3in content width (cx=${cx})`);
  assert.ok(Math.abs(cy / cx - 800 / 1200) < 0.01, 'aspect ratio preserved');
  // Title page and footer.
  assert.ok(document.includes('Enzyme Kinetics Study Guide'), 'title on the title page');
  assert.ok(document.includes('Biochemistry 201 · Week 4'), 'subtitle on the title page');
  assert.ok(document.includes('<w:pageBreakBefore/>'), 'body starts on a new page');
  assert.ok(document.includes('w:val="Title"'), 'Title style used');
  assert.equal(
    (document.match(/w:val="Heading1"/g) ?? []).length,
    0,
    'the leading H1 that repeats the title is not duplicated in the body',
  );

  assert.ok(
    names.some((name) => /^word\/media\/.+\.png$/.test(name)),
    `a PNG media entry exists (${names.filter((n) => n.startsWith('word/media')).join(', ')})`,
  );
  const numbering = await read('word/numbering.xml');
  assert.ok(numbering.includes('<w:abstractNum'), 'numbering definitions exist');
  assert.ok(numbering.includes('w:val="bullet"'), 'bullet level format');
  assert.ok(numbering.includes('w:val="decimal"'), 'decimal level format');
  assert.ok(numbering.includes('w:val="3"'), 'ordered list starting at 3 has its own start');

  const footerName = names.find((name) => /^word\/footer\d*\.xml$/.test(name));
  assert.ok(footerName, 'footer part exists');
  const footer = await read(footerName!);
  assert.ok(footer.includes('PAGE') && footer.includes('NUMPAGES'), 'footer has "Page X of Y" fields');

  const rels = await read('word/_rels/document.xml.rels');
  assert.ok(rels.includes('https://example.com/docs'), 'hyperlink relationship target');
  assert.ok(rels.includes('relationships/footer'), 'footer relationship');

  const styles = await read('word/styles.xml');
  assert.ok(/w:color w:val="3730a3"/i.test(styles), 'H1 colour in styles');
  assert.ok(/w:ascii="Calibri"/.test(styles), 'body font');
  assert.ok(styles.includes('w:styleId="CodeBlock"'), 'custom code block style');
});

test('markdownToDocx falls back to source when a diagram cannot be rendered', async () => {
  const bytes = await markdownToDocx('# T\n\n```mermaid\ngraph TD; A-->B\n```\n', {
    title: 'T',
    renderDiagram: async () => null,
  });
  const zip = await JSZip.loadAsync(bytes);
  const document = await zip.file('word/document.xml')!.async('string');
  assert.ok(document.includes('Diagram (mermaid source):'), 'fallback caption');
  assert.ok(document.includes('graph TD; A--&gt;B'), 'diagram source shown as code');
  assert.ok(!document.includes('<w:drawing>'), 'no image inserted');
});

test('markdownToDocx never throws on odd input', async () => {
  const bytes = await markdownToDocx('', { title: '' });
  assert.ok(bytes.length > 0);
  const weird = await markdownToDocx('|a|\n|-|\n\n- \n\n> \n\n```\n```\n\n[x]: https://example.com\n', {
    title: 'Weird',
    renderDiagram: async () => {
      throw new Error('boom');
    },
  });
  assert.ok(weird.length > 0);
});

test('markdownToDocxBlob returns a DOCX blob', async () => {
  const blob = await markdownToDocxBlob('# Hi\n\nHello', { title: 'Hi', renderDiagram: stubRenderDiagram });
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(blob.size > 1000);
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
test('markdownToStandaloneHtml inlines diagrams, styles callouts, escapes text and renders tables', async () => {
  const html = await markdownToStandaloneHtml(SAMPLE, {
    title: 'Enzyme Kinetics Study Guide',
    subtitle: 'Biochemistry 201 · Week 4',
    renderSvg: async () => STUB_SVG,
  });

  const dir = outDir();
  if (dir) writeFileSync(join(dir, 'sample.html'), html);

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>Enzyme Kinetics Study Guide</title>'));
  assert.ok(html.includes(`<figure class="diagram">${STUB_SVG}</figure>`), 'SVG inlined');
  for (const kind of ['tip', 'pitfall', 'exam', 'key', 'practice', 'memory', 'note']) {
    assert.ok(html.includes(`class="callout callout-${kind}"`), `${kind} callout class`);
  }
  assert.ok(html.includes('<strong class="callout-label">💡 Gold-standard tip:</strong>'), 'callout label wrapped');
  assert.ok(html.includes('<strong class="callout-label">Note:</strong>'), 'plain-text label wrapped');
  assert.ok(html.includes('<blockquote>'), 'ordinary quote stays a blockquote');
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(!html.includes('</script>'), 'no raw closing script tag');
  assert.ok(html.includes('<code>&lt;script&gt;</code>'), 'script inside inline code is escaped');
  assert.ok(html.includes('2 &lt; 3 &amp;&amp; 4 &gt; 1'), 'angle brackets and ampersands escaped');
  assert.ok(html.includes('<table>') && html.includes('<th>Process</th>') && html.includes('<td>Hydrolysis</td>'), 'table rendered');
  assert.ok(html.includes('<th style="text-align:center">Rate constant</th>'), 'column alignment');
  assert.ok(html.includes('<td style="text-align:right">Fast &amp; irreversible</td>'), 'right-aligned escaped cell');
  assert.ok(html.includes('<pre class="code" data-lang="python"><code class="language-python">def hello(name):'), 'code block');
  assert.ok(html.includes('<ol start="3">'), 'ordered list start');
  assert.ok(html.includes('<p><input type="checkbox" disabled checked> Completed task</p>'), 'checked task');
  assert.ok(html.includes('<p><input type="checkbox" disabled> Open task</p>'), 'open task');
  assert.ok(html.includes('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" title="Docs">'), 'link');
  assert.ok(html.includes('<em class="image-alt">Reaction coordinate diagram</em>'), 'image alt in italics');
  assert.ok(html.includes('<h2 id="core-concepts">Core Concepts</h2>'), 'heading ids');
  assert.ok(html.includes('<hr>'), 'horizontal rule');
  assert.ok(html.includes('Block HTML text survives as plain text') && !html.includes('<div class="wrapper">'), 'block html stripped');
  assert.ok(html.includes('<br>'), 'inline <br> honoured');
  assert.ok(html.includes('@media print'), 'print styles present');
  assert.ok(!/<link[^>]+href=|<script[^>]+src=|url\(http/i.test(html), 'no external requests');
  assert.equal((html.match(/<h1 /g) ?? []).length, 1, 'title H1 not duplicated by the body H1');
});

test('markdownToStandaloneHtml shows the source when SVG rendering fails', async () => {
  const html = await markdownToStandaloneHtml('```mermaid\ngraph TD; A-->B\n```', {
    title: 'T',
    renderSvg: async () => null,
  });
  assert.ok(html.includes('Diagram (mermaid source):'));
  assert.ok(html.includes('<code class="language-mermaid">graph TD; A--&gt;B</code>'));
  const thrown = await markdownToStandaloneHtml('```mermaid\ngraph TD; A-->B\n```', {
    title: 'T',
    renderSvg: async () => {
      throw new Error('nope');
    },
  });
  assert.ok(thrown.includes('Diagram (mermaid source):'));
  const bogus = await markdownToStandaloneHtml('```mermaid\ngraph TD; A-->B\n```', {
    title: 'T',
    renderSvg: async () => '<script>alert(1)</script>',
  });
  assert.ok(!bogus.includes('<script>'), 'non-SVG render output is rejected');
});

test('unsafe link schemes are neutralised in HTML', async () => {
  const html = await markdownToStandaloneHtml('[click](javascript:alert(1)) and [ok](https://ok.example)', { title: 'T' });
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('href="https://ok.example"'));
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
test('classifyCallout recognises emoji, labels and prefixes', () => {
  assert.equal(classifyCallout('**💡 Gold-standard tip:** Always check')?.kind, 'tip');
  assert.equal(classifyCallout('💡 Gold-standard tip: Always check')?.label, 'Gold-standard tip');
  assert.equal(classifyCallout('⚠️ Common pitfall: x')?.kind, 'pitfall');
  assert.equal(classifyCallout('📌 Exam alert: x')?.kind, 'exam');
  assert.equal(classifyCallout('🔑 Key concept: x')?.kind, 'key');
  assert.equal(classifyCallout('✅ Best practice: x')?.kind, 'practice');
  assert.equal(classifyCallout('🧠 Memory aid: x')?.kind, 'memory');
  assert.equal(classifyCallout('Note: x')?.kind, 'note');
  assert.equal(classifyCallout('NOTE that this is important')?.kind, 'note');
  assert.equal(classifyCallout('Warning! Danger ahead')?.kind, 'pitfall');
  assert.equal(classifyCallout('Best practice — do this')?.kind, 'practice');
  assert.equal(classifyCallout('Tip: x')?.color, '#16a34a');
  assert.equal(classifyCallout('Just a quote'), null);
  assert.equal(classifyCallout('Albert Einstein: imagination matters'), null);
  assert.equal(classifyCallout(''), null);
});

test('mdastToPlainText flattens inline and block content', () => {
  const tree = parseMarkdown('# Hi **there**\n\n- one\n- two `x`\n');
  assert.equal(mdastToPlainText(tree.children[0]), 'Hi there');
  assert.equal(mdastToPlainText(tree.children[1]), 'one\ntwo x');
});

test('safeFilename strips unsafe characters and limits length', () => {
  assert.equal(safeFilename('Enzyme Kinetics: Week 4 / Part 2?', 'docx'), 'Enzyme-Kinetics-Week-4-Part-2.docx');
  assert.equal(safeFilename('  ...  ', '.html'), 'document.html');
  assert.equal(safeFilename('a'.repeat(200), 'docx'), `${'a'.repeat(80)}.docx`);
  assert.equal(safeFilename('con', 'docx'), '_con.docx');
  assert.equal(safeFilename('Café résumé 📚', 'md'), 'Café-résumé.md');
});
