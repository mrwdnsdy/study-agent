/**
 * Conservative text repairs for the Mermaid slips that language models make
 * most often. Each rule was checked against mermaid 12.0.0: it turns a diagram
 * that fails to parse into one that parses without changing what it says.
 * A diagram that already follows the prompt's rules comes out byte for byte, so
 * callers prefer the repaired version whenever it parses: some slips parse but
 * draw the wrong thing (A["Label"] in a state diagram invents extra states).
 *
 * Pure TypeScript with no DOM access, so it runs in the browser, on the server
 * and under node:test.
 */

export type DiagramType =
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'class'
  | 'mindmap'
  | 'timeline'
  | 'pie'
  | 'er'
  | 'gantt'
  | 'journey'
  | 'quadrant'
  | 'other';

interface HeaderRule {
  pattern: RegExp;
  type: DiagramType;
  /** Canonical spelling of the matched keyword (group 1 holds an optional suffix such as -v2). */
  keyword: string;
}

// Matched case-insensitively so that a capitalised keyword ("Flowchart TD"),
// which mermaid rejects, can be detected and then fixed.
const HEADERS: readonly HeaderRule[] = [
  { pattern: /^flowchart(-elk)?(?=$|[\s;])/i, type: 'flowchart', keyword: 'flowchart' },
  { pattern: /^graph()(?=$|[\s;])/i, type: 'flowchart', keyword: 'graph' },
  { pattern: /^sequenceDiagram()(?=$|[\s;])/i, type: 'sequence', keyword: 'sequenceDiagram' },
  { pattern: /^stateDiagram(-v2)?(?=$|[\s;])/i, type: 'state', keyword: 'stateDiagram' },
  { pattern: /^classDiagram(-v2)?(?=$|[\s;])/i, type: 'class', keyword: 'classDiagram' },
  { pattern: /^mindmap()(?=$|\s)/i, type: 'mindmap', keyword: 'mindmap' },
  { pattern: /^timeline()(?=$|\s)/i, type: 'timeline', keyword: 'timeline' },
  { pattern: /^pie()(?=$|\s)/i, type: 'pie', keyword: 'pie' },
  { pattern: /^erDiagram()(?=$|\s)/i, type: 'er', keyword: 'erDiagram' },
  { pattern: /^gantt()(?=$|\s)/i, type: 'gantt', keyword: 'gantt' },
  { pattern: /^journey()(?=$|\s)/i, type: 'journey', keyword: 'journey' },
  { pattern: /^quadrantChart()(?=$|\s)/i, type: 'quadrant', keyword: 'quadrantChart' },
];

/** Diagram types whose grammar has no classDef / class / style statements (or rejects ours). */
const UNSTYLED: ReadonlySet<DiagramType> = new Set([
  'sequence',
  'timeline',
  'pie',
  'mindmap',
  'class',
  'quadrant',
  'gantt',
  'journey',
  'er',
]);

/** The classDef names the prompt teaches (see MERMAID_RULES in prompts.ts). */
const PALETTE_CLASSES = ['core', 'info', 'good', 'warn'];

// ---------------------------------------------------------------------------
// Whole-text clean-up shared by every diagram type
// ---------------------------------------------------------------------------

/** Remove a surrounding ``` / ~~~ fence (with or without a language) and normalise line breaks. */
function stripFence(code: string): string {
  return String(code ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*\n/, '')
    .replace(/\n[ \t]*(?:`{3,}|~{3,})\s*$/, '');
}

/** Drop %%{init}%% directives anywhere and a leading --- front matter block. */
function stripConfig(text: string): string {
  return text
    .replace(/%%\{[\s\S]*?\}%%[ \t]*/g, '')
    .replace(/^\s*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?:\n|$)/, '');
}

/** Curly quotes become straight ones. Primes (′ ″) are left alone: they are units, not quotes. */
function straightenQuotes(text: string): string {
  return text.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
}

/** A whole line of italic or bold markdown is a caption that belongs after the fence, not inside it. */
const CAPTION_LINE = /^\s*(\*{1,2}|_{1,2})(?=\S)(.*\S)?\1[ \t]*$/;
/** ...unless it holds a link, as in an edge between ids that start and end with underscores. */
const ARROW_OPERATOR = /-->|---|==>|-\.-|->>/;

function isCaptionLine(line: string): boolean {
  return CAPTION_LINE.test(line) && !ARROW_OPERATOR.test(line);
}

/** Mermaid only understands the self-closing form of the line break. */
function normaliseBreaks(text: string): string {
  return text.replace(/<br\s*\/?\s*>/gi, '<br/>');
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith('%%');
}

/** Index of the header line: the first line that is not blank and not a %% comment. */
function headerIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => !isBlank(line) && !isComment(line));
}

function matchHeader(line: string): { rule: HeaderRule; match: RegExpExecArray } | null {
  const trimmed = line.trim();
  for (const rule of HEADERS) {
    const match = rule.pattern.exec(trimmed);
    if (match) return { rule, match };
  }
  return null;
}

/** The header line with its keyword spelled the way mermaid expects. */
function canonicalHeader(line: string): string {
  const found = matchHeader(line);
  if (!found) return line;
  const indent = /^\s*/.exec(line)![0];
  const trimmed = line.trim();
  const suffix = (found.match[1] ?? '').toLowerCase();
  return indent + found.rule.keyword + suffix + trimmed.slice(found.match[0].length);
}

/** Which kind of diagram the code declares; 'flowchart' also covers `graph`. */
export function detectDiagramType(code: string): DiagramType {
  const lines = stripConfig(stripFence(code)).split('\n');
  const index = headerIndex(lines);
  if (index === -1) return 'other';
  return matchHeader(lines[index])?.rule.type ?? 'other';
}

// ---------------------------------------------------------------------------
// Small scanning helpers
// ---------------------------------------------------------------------------

const ID_CHAR = /[\p{L}\p{N}_]/u;

/** End index of a node id starting at `i` (letters, digits, _, and inner - or . as mermaid allows). */
function readId(line: string, i: number): number {
  if (i >= line.length || !ID_CHAR.test(line[i])) return i;
  let j = i + 1;
  while (j < line.length) {
    const c = line[j];
    if (ID_CHAR.test(c)) j++;
    else if ((c === '-' || c === '.') && j + 1 < line.length && ID_CHAR.test(line[j + 1])) j++;
    else break;
  }
  return j;
}

/** Index of `char` outside double-quoted strings, or -1. */
function indexOutsideQuotes(line: string, char: string, from = 0): number {
  let quoted = false;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === char) return i;
  }
  return -1;
}

/** Apply `fn` to the parts of `line` that are outside double-quoted strings. */
function mapOutsideQuotes(line: string, fn: (part: string) => string): string {
  const parts = line.split('"');
  // Even indexes are outside quotes; an unbalanced trailing quote leaves the rest untouched.
  const balanced = parts.length % 2 === 1;
  return parts.map((part, i) => (i % 2 === 0 && (balanced || i < parts.length - 1) ? fn(part) : part)).join('"');
}

/** `-- >` and `- ->` are always typos for `-->`. */
function fixSplitArrows(text: string): string {
  return text.replace(/--[ \t]+>/g, '-->').replace(/(^|[^-])-[ \t]+->/g, '$1-->');
}

const UNICODE_ARROW = /[→⟶⇒]/;

/** Unwrap text that is entirely enclosed in double quotes (where quotes would be shown literally). */
function unquoteWhole(text: string): string {
  const match = /^(\s*)"([^"]*)"(\s*)$/.exec(text);
  return match ? match[1] + match[2] + match[3] : text;
}

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

/** Characters that make an unquoted flowchart label fail (or risk failing) to parse. */
const LABEL_SPECIAL = /[()[\]{}:;,#&<>|"'@]/;
/** Subgraph titles break on fewer characters; quoting only these keeps valid titles as they were. */
const TITLE_SPECIAL = /[()[\]{}|",@]/;

function hasNonAsciiPunctuation(text: string): boolean {
  for (const char of text) {
    if (char.charCodeAt(0) > 0x7f && /[\p{P}\p{S}]/u.test(char)) return true;
  }
  return false;
}

/** Labels are plain text: no markdown emphasis and no HTML except <br/>. */
function cleanLabelText(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/__([^_]+?)__/g, (whole, inner: string) => (/^\w+$/.test(inner) ? whole : inner)) // keep __init__
    .replace(/<(?!br\/>)\/?[a-zA-Z][^<>]*>/g, '');
}

function quoteLabel(text: string): string {
  return `"${text.trim().replace(/"/g, '#quot;')}"`;
}

/** Fix one flowchart node or edge label (the text between the shape or pipe delimiters). */
function fixFlowLabel(raw: string): string {
  const trimmed = raw.trim();
  if (/^"`[\s\S]*`"$/.test(trimmed)) return raw; // a markdown string: mermaid formats it itself
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // Already quoted; inner quotes would end the string early.
    return `"${cleanLabelText(trimmed.slice(1, -1)).replace(/"/g, '#quot;')}"`;
  }
  const text = cleanLabelText(raw);
  if (!LABEL_SPECIAL.test(text) && !hasNonAsciiPunctuation(text)) return text;
  return quoteLabel(text);
}

/** Node shapes, longest opener first. Parallelograms and trapezoids accept either closing slash. */
const SHAPES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['(((', [')))']],
  ['((', ['))']],
  ['([', ['])']],
  ['[[', [']]']],
  ['[(', [')]']],
  ['[/', ['/]', '\\]']],
  ['[\\', ['\\]', '/]']],
  ['{{', ['}}']],
  ['[', [']']],
  ['(', [')']],
  ['{', ['}']],
  ['>', [']']],
];

/** What may follow a complete node: end of line, `;`, `&`, a class suffix or a link. */
const NODE_END = /^(?:\s*$|\s*;|\s*&|:::|\s*[xo<]?(?:-{2,}|={2,}|-?\.+-|~{3,}|->)|\s*[→⟶⇒])/;

/** A link: -->, ---, --x, --o, <-->, ==>, ===, -.->, -.-, ~~~, and the invalid -> and unicode arrows. */
const LINK = /^[xo<]?(?:-{2,}[->]|-{2,}[xo](?![\p{L}\p{N}_])|={2,}[=>]|={2,}[xo](?![\p{L}\p{N}_])|-?\.+-[xo>]?|~{3,})|^->|^[→⟶⇒]/u;
/** The start of a link that carries its text inline: `A -- text --> B`. */
const TEXT_LINK_START = /^[xo<]?(--|==|-\.)(?=\s)/;
const TEXT_LINK_END: Readonly<Record<string, RegExp>> = {
  '--': /[xo<]?-{2,}[-xo>]/,
  '==': /={2,}[=xo>]/,
  '-.': /\.+-[xo>]?/,
};

interface ShapeMatch {
  open: string;
  label: string;
  close: string;
  end: number;
}

/**
 * The shape that starts at `start`, closed by the first closer that is followed by
 * something that can end a node. Unquoted labels may contain the closer themselves,
 * as in A[f(x) = [a, b]], so the first closer is not always the right one.
 */
function matchShape(line: string, start: number, allowAsymmetric: boolean): ShapeMatch | null {
  for (const [open, closers] of SHAPES) {
    if (!line.startsWith(open, start)) continue;
    if (open === '>' && !allowAsymmetric) continue;
    const from = start + open.length;
    let k = from;
    // A quoted label runs to its closing quote; quotes inside an unquoted label are just text.
    const lead = /^\s*"/.exec(line.slice(from));
    if (lead) {
      const closeQuote = line.indexOf('"', from + lead[0].length);
      if (closeQuote !== -1) k = closeQuote + 1;
    }
    for (; k < line.length; k++) {
      for (const close of closers) {
        if (line.startsWith(close, k) && NODE_END.test(line.slice(k + close.length))) {
          return { open, label: line.slice(from, k), close, end: k + close.length };
        }
      }
    }
  }
  return null;
}

/**
 * Rewrite one flowchart statement line: `end` ids renamed, stray spaces before
 * shapes removed, risky labels quoted and unicode or broken arrows replaced.
 * Returns null when the line does not look like nodes and links, so the caller
 * can leave it alone.
 */
function fixFlowStatement(line: string): string | null {
  let out = '';
  let i = 0;
  const n = line.length;

  const takeSpace = (): void => {
    const start = i;
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    out += line.slice(start, i);
  };

  const node = (): boolean => {
    const idEnd = readId(line, i);
    if (idEnd === i) return false;
    const id = line.slice(i, idEnd);
    out += id === 'end' ? 'end_' : id;
    i = idEnd;
    if (line.startsWith('@{', i)) {
      // Shape data (A@{ shape: rect }): copy it through unchanged.
      const close = indexOutsideQuotes(line, '}', i);
      if (close === -1) return false;
      out += line.slice(i, close + 1);
      i = close + 1;
    } else {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      // "A [Label]" fails to parse; the space between id and shape is dropped.
      const shape = /[[({>]/.test(line[j] ?? '') ? matchShape(line, j, j === i) : null;
      if (shape) {
        out += shape.open + fixFlowLabel(shape.label) + shape.close;
        i = shape.end;
      }
    }
    const suffix = /^:::[\w-]+/.exec(line.slice(i));
    if (suffix) {
      out += suffix[0];
      i += suffix[0].length;
    }
    return true;
  };

  const link = (): boolean => {
    const rest = line.slice(i);
    const plain = LINK.exec(rest);
    if (plain) {
      const token = plain[0];
      out += token === '->' || UNICODE_ARROW.test(token) ? '-->' : token;
      i += token.length;
      // Optional |label| straight after the arrow.
      const pipe = /^\s*\|/.exec(line.slice(i));
      if (pipe) {
        const labelStart = i + pipe[0].length;
        let labelEnd = -1;
        if (line[labelStart] === '"') {
          const closeQuote = line.indexOf('"', labelStart + 1);
          labelEnd = closeQuote === -1 ? -1 : line.indexOf('|', closeQuote);
        } else {
          labelEnd = line.indexOf('|', labelStart);
        }
        if (labelEnd === -1) return false;
        out += pipe[0] + fixFlowLabel(line.slice(labelStart, labelEnd)) + '|';
        i = labelEnd + 1;
      }
      return true;
    }
    const textStart = TEXT_LINK_START.exec(rest);
    if (textStart) {
      // A -- text --> B: the text is copied as written (mermaid accepts punctuation there).
      const end = TEXT_LINK_END[textStart[1]].exec(rest.slice(textStart[0].length));
      if (!end) return false;
      const length = textStart[0].length + end.index + end[0].length;
      out += rest.slice(0, length);
      i += length;
      return true;
    }
    return false;
  };

  takeSpace();
  if (!node()) return null;
  for (;;) {
    takeSpace();
    if (i >= n) break;
    if (line[i] === ';') {
      // Several statements on one line.
      out += ';';
      i++;
      takeSpace();
      if (i >= n) break;
      if (!node()) return null;
      continue;
    }
    if (line[i] === '&') {
      out += '&';
      i++;
      takeSpace();
      if (!node()) return null;
      continue;
    }
    if (!link()) return null;
    takeSpace();
    if (!node()) return null;
  }
  return out;
}

/** A statement line, or the line with only its arrows fixed when it is not nodes and links. */
function fixFlowLine(line: string): string {
  const prepared = mapOutsideQuotes(line, fixSplitArrows);
  return (
    fixFlowStatement(prepared) ??
    mapOutsideQuotes(prepared, (part) => part.replace(/[ \t]*[→⟶⇒][ \t]*/g, ' --> '))
  );
}

function fixSubgraphLine(line: string): string {
  const match = /^(\s*subgraph\s+)(.*?)\s*$/.exec(line);
  if (!match) return line;
  const [, head, rest] = match;
  if (!rest || rest.startsWith('"')) return line;
  const titled = /^([\p{L}\p{N}_][\p{L}\p{N}_.-]*)\s*\[(.*)\]$/u.exec(rest);
  if (titled) return `${head}${titled[1]}[${fixFlowLabel(titled[2])}]`;
  if (TITLE_SPECIAL.test(rest)) return head + quoteLabel(cleanLabelText(rest));
  return line;
}

/** `class A, B core` and `class A B core` become `class A,B core`; an `end` id is renamed. */
function fixClassLine(line: string): string {
  const match = /^(\s*class\s+)(.+?)\s+([\w-]+)\s*$/.exec(line);
  if (!match) return line;
  const ids = match[2]
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => (id === 'end' ? 'end_' : id));
  return `${match[1]}${ids.join(',')} ${match[3]}`;
}

/** Lines that hold no nodes: comments and class, style, click, subgraph and direction statements. */
const NOT_A_STATEMENT = /^\s*(?:%%|class\s|classDef\s|style\s|click\s|linkStyle\s|subgraph\b|direction\s|accTitle|accDescr)/;
const SHAPED_END = /(?:^|[^\p{L}\p{N}_.-])end_[[({>@]/u;
const BARE_END = /(^|[^\p{L}\p{N}_.-])end_(?![\p{L}\p{N}_.\-[({>@])/u;

function maskQuotes(line: string): string {
  return line.replace(/"[^"]*"/g, (quoted) => ' '.repeat(quoted.length));
}

/**
 * A node renamed from `end` would show "end_" as its text, so its first bare
 * use gets the original text back as a label, unless the node has a label of its own.
 */
function labelRenamedEnd(lines: string[]): string[] {
  const masked = lines.map(maskQuotes);
  if (masked.some((line) => SHAPED_END.test(line))) return lines;
  const index = masked.findIndex((line) => !NOT_A_STATEMENT.test(line) && BARE_END.test(line));
  if (index === -1) return lines;
  const match = BARE_END.exec(masked[index])!;
  const at = match.index + match[1].length + 'end_'.length;
  const out = [...lines];
  out[index] = `${lines[index].slice(0, at)}["end"]${lines[index].slice(at)}`;
  return out;
}

function repairFlowchart(lines: string[], header: number): string[] {
  const out: string[] = [];
  let depth = 0;
  lines.forEach((line, index) => {
    if (index < header) {
      out.push(line);
      return;
    }
    if (index === header) {
      // `graph TD; A-->B` keeps statements on the header line.
      const semi = line.indexOf(';');
      if (semi === -1) {
        out.push(line);
      } else {
        const rest = line.slice(semi + 1);
        out.push(line.slice(0, semi + 1) + (rest.trim() ? fixFlowLine(rest) : rest));
      }
      return;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) {
      out.push(line);
    } else if (/^subgraph\b/.test(trimmed)) {
      depth++;
      out.push(fixSubgraphLine(line));
    } else if (/^end\s*;?$/.test(trimmed)) {
      // A stray `end` with no open subgraph is a parse error; drop it.
      if (depth > 0) {
        depth--;
        out.push(line);
      }
    } else if (/^(?:direction|classDef|linkStyle|accTitle|accDescr)\b/.test(trimmed)) {
      out.push(line);
    } else if (/^class\s/.test(trimmed)) {
      out.push(fixClassLine(line));
    } else if (/^(?:style|click)\s/.test(trimmed)) {
      out.push(line.replace(/^(\s*(?:style|click)\s+)end(?=\s)/, '$1end_'));
    } else {
      out.push(fixFlowLine(line));
    }
  });
  // Close any subgraph the model forgot to end.
  for (; depth > 0; depth--) out.push('  end');
  const renamedEnd = !lines.some((line) => /\bend_\b/.test(line)) && out.some((line) => /\bend_\b/.test(line));
  return renamedEnd ? labelRenamedEnd(out) : out;
}

// ---------------------------------------------------------------------------
// Sequence, state and class diagrams: structure before the first colon, free text after it
// ---------------------------------------------------------------------------

function splitAtColon(line: string): [string, string] {
  const colon = indexOutsideQuotes(line, ':');
  return colon === -1 ? [line, ''] : [line.slice(0, colon), line.slice(colon)];
}

/** Arrow fixes for the structural part of a line; `arrow` replaces a unicode arrow. */
function fixHeadArrows(head: string, arrow: string): string {
  return mapOutsideQuotes(fixSplitArrows(head), (part) => part.replace(/[ \t]*[→⟶⇒][ \t]*/g, ` ${arrow} `));
}

/** Block keywords whose label runs to the end of the line, where ; would end it early. */
const SEQUENCE_BLOCKS = /^(\s*(?:loop|alt|else|opt|par|and|critical|break|option)\b)(.*)$/;

function repairSequenceLine(line: string): string {
  if (isBlank(line) || isComment(line)) return line;
  const block = SEQUENCE_BLOCKS.exec(line);
  if (block) return block[1] + block[2].replace(/;/g, ',');
  const [head, tail] = splitAtColon(line);
  // A unicode arrow means a message, which is ->> in a sequence diagram (--> would drop the arrowhead).
  const fixedHead = fixHeadArrows(head, '->>');
  if (!tail) return fixedHead;
  // Everything after the colon is message or note text, where ; would end the statement early.
  return `${fixedHead}:${unquoteWhole(tail.slice(1).replace(/;/g, ','))}`;
}

function repairClassLine(line: string): string {
  if (isBlank(line) || isComment(line)) return line;
  const [head, tail] = splitAtColon(line);
  const fixedHead = fixHeadArrows(head, '-->');
  return tail ? `${fixedHead}:${tail.slice(1).replace(/;/g, ',')}` : fixedHead;
}

/**
 * State diagrams have no A["Label"] syntax: mermaid invents extra states from it.
 * The label moves into a `state "Label" as A` declaration after the header.
 */
function repairState(lines: string[], header: number): string[] {
  const declared = new Set<string>();
  for (const line of lines) {
    const match = /^\s*state\s+"[^"]*"\s+as\s+([\p{L}\p{N}_]+)/u.exec(line);
    if (match) declared.add(match[1]);
  }
  const labels = new Map<string, string>();
  const body = lines.map((line, index) => {
    if (index <= header || isBlank(line) || isComment(line)) return line;
    const trimmed = line.trim();
    if (/^(?:state|note|classDef|class|style|direction)\b/.test(trimmed) || /^[{}]/.test(trimmed)) return line;
    const [head, tail] = splitAtColon(line);
    const fixedHead = fixHeadArrows(head, '-->').replace(
      /([\p{L}\p{N}_]+)(?:\[\s*"?([^"\]]*)"?\s*\]|\(\s*"([^"()]*)"\s*\))/gu,
      (_whole, id: string, square?: string, round?: string) => {
        const label = (square ?? round ?? '').trim();
        if (label && !declared.has(id) && !labels.has(id)) labels.set(id, label);
        return id;
      },
    );
    return tail ? `${fixedHead}:${unquoteWhole(tail.slice(1))}` : fixedHead;
  });
  if (labels.size === 0) return body;
  const sample = body.slice(header + 1).find((line) => !isBlank(line));
  const indent = sample ? /^\s*/.exec(sample)![0] : '  ';
  const declarations = [...labels].map(([id, label]) => `${indent}state "${label.replace(/"/g, "'")}" as ${id}`);
  return [...body.slice(0, header + 1), ...declarations, ...body.slice(header + 1)];
}

// ---------------------------------------------------------------------------
// Mindmap
// ---------------------------------------------------------------------------

/** Mindmap node shapes as [open, close]; the text in between is plain. */
const MINDMAP_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['((', '))'],
  ['))', '(('],
  ['{{', '}}'],
  ['(', ')'],
  [')', '('],
  ['[', ']'],
];

/**
 * Brackets end a mindmap node early, so they become dashes:
 * "Energy (ATP)" reads "Energy – ATP" and "Stack (LIFO) order" reads "Stack – LIFO – order".
 */
function debracket(text: string): string {
  let out = text;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\s*[([{]\s*([^()[\]{}]*?)\s*[)\]}]\s*/g, ' – $1 – ');
  } while (out !== previous);
  out = out.replace(/\s*[()[\]{}]\s*/g, ' – ');
  return out
    .replace(/\s*–(?:\s*–)+\s*/g, ' – ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*–\s*|\s*–\s*$/g, '')
    .trim();
}

function plainMindmapText(text: string): string {
  const trimmed = text.trim();
  if (/^"`[\s\S]*`"$/.test(trimmed)) return trimmed; // markdown string
  const unquoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  return debracket(unquoted ? unquoted[1] : trimmed);
}

function repairMindmapNode(line: string): string {
  const indent = /^\s*/.exec(line)![0];
  // List markers (1. - * + > #) are not mindmap syntax; they show up as text.
  const text = line.slice(indent.length).replace(/^(?:\d+[.)]|[-*+>#]+)\s+/, '').trimEnd();
  const shaped = /^([\p{L}\p{N}_-]*)(.*)$/u.exec(text)!;
  const [, id, rest] = shaped;
  for (const [open, close] of MINDMAP_SHAPES) {
    if (rest.length >= open.length + close.length && rest.startsWith(open) && rest.endsWith(close)) {
      const inner = rest.slice(open.length, rest.length - close.length);
      return `${indent}${id}${open}${plainMindmapText(inner)}${close}`;
    }
  }
  return indent + plainMindmapText(text);
}

function repairMindmap(lines: string[], header: number): string[] {
  const out = lines.map((line, index) => {
    if (index <= header || isBlank(line) || isComment(line) || /^\s*::icon\(/.test(line)) return line;
    return repairMindmapNode(line);
  });
  // "There can be only one root": push nodes written at the root's level under the root.
  const nodes = out.map((line, index) => ({ line, index })).filter(({ line, index }) => index > header && !isBlank(line) && !isComment(line));
  if (nodes.length > 1) {
    const width = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, '  ').length;
    const rootIndent = width(nodes[0].line);
    const minChild = Math.min(...nodes.slice(1).map(({ line }) => width(line)));
    if (minChild <= rootIndent) {
      const shift = ' '.repeat(rootIndent + 2 - minChild);
      for (const { index } of nodes.slice(1)) {
        out[index] = shift + out[index].replace(/^\s*/, (space) => space.replace(/\t/g, '  '));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline and pie
// ---------------------------------------------------------------------------

function repairTimelineLine(line: string): string {
  if (isBlank(line) || isComment(line) || /^\s*(?:title|section)\b/.test(line)) return line;
  // period : event : event, each shown as written, so quotes would show.
  return line
    .split(':')
    .map((part) => unquoteWhole(part))
    .join(':');
}

function repairPieLine(line: string): string {
  const match = /^(\s*)(.+?)\s*:\s*(-?[\d.,]+)\s*%?\s*$/.exec(line);
  if (!match || /^(?:title|accTitle|accDescr|showData)\b/.test(match[2])) return line;
  const [, indent, label, value] = match;
  const number = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value) ? value.replace(/,/g, '') : value;
  const quoted = /^"[^"]*"$|^'[^']*'$/.test(label) ? label : `"${label.replace(/^["']|["']$/g, '').replace(/"/g, "'")}"`;
  return `${indent}${quoted} : ${number}`;
}

/** An erDiagram relationship label is one word or a quoted string. */
function repairErLine(line: string): string {
  const match = /^(\s*[^\s:]+\s+[|}{o.-]+\s+[^\s:]+\s*:\s*)(.*?)\s*$/.exec(line);
  if (!match || !match[2] || /^"[^"]*"$|^[\w-]+$/.test(match[2])) return line;
  return `${match[1]}"${match[2].replace(/"/g, "'")}"`;
}

// ---------------------------------------------------------------------------
// Styling statements in diagram types that do not support them
// ---------------------------------------------------------------------------

function isStylingLine(line: string, type: DiagramType, classNames: ReadonlySet<string>): boolean {
  const trimmed = line.trim();
  if (/^classDef\s/.test(trimmed)) return true;
  if (/^style\s+\S+\s+[\w-]+\s*:/.test(trimmed)) return true;
  if (/^:::[\w\s-]*$/.test(trimmed)) return true;
  if (/^class\s/.test(trimmed) && !trimmed.includes(':')) {
    const match = /^class\s+(.+?)\s+([\w-]+)$/.exec(trimmed);
    if (!match) return false;
    // In class diagrams `class Animal` declares a class, and a mindmap node may start with the word;
    // only a list of ids or a known class name marks a styling statement there.
    if ((type === 'class' || type === 'mindmap') && !match[1].includes(',') && !classNames.has(match[2])) return false;
    return true;
  }
  return false;
}

function stripStyling(lines: string[], header: number, type: DiagramType): string[] {
  const classNames = new Set(PALETTE_CLASSES);
  for (const line of lines) {
    const match = /^\s*classDef\s+([\w-]+)/.exec(line);
    if (match) classNames.add(match[1]);
  }
  return lines
    .filter((line, index) => index <= header || !isStylingLine(line, type, classNames))
    .map((line, index) => (index <= header ? line : mapOutsideQuotes(line, (part) => part.replace(/:::[\w-]+/g, ''))));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fix the syntax slips that stop a diagram from parsing. Conservative: it
 * changes syntax and, where the grammar demands it, punctuation (brackets in
 * mindmap text, semicolons in messages), never what the diagram says; and
 * repair(repair(x)) === repair(x).
 */
export function repairMermaid(code: string): string {
  let text = stripConfig(stripFence(code));
  text = normaliseBreaks(straightenQuotes(text));
  let lines = text
    .split('\n')
    .filter((line) => !isCaptionLine(line))
    // Trailing semicolons are never needed, and they end pie values and messages early.
    .map((line) => line.replace(/[ \t]*;+[ \t]*$/, ''));

  const header = headerIndex(lines);
  if (header === -1) return lines.join('\n').trim();
  lines[header] = canonicalHeader(lines[header]);
  const type = matchHeader(lines[header])?.rule.type ?? 'other';

  if (UNSTYLED.has(type)) lines = stripStyling(lines, header, type);

  switch (type) {
    case 'flowchart':
      lines = repairFlowchart(lines, header);
      break;
    case 'sequence':
      lines = lines.map((line, index) => (index > header ? repairSequenceLine(line) : line));
      break;
    case 'state':
      lines = repairState(lines, header);
      break;
    case 'class':
      lines = lines.map((line, index) => (index > header ? repairClassLine(line) : line));
      break;
    case 'mindmap':
      lines = repairMindmap(lines, header);
      break;
    case 'timeline':
      lines = lines.map((line, index) => (index > header ? repairTimelineLine(line) : line));
      break;
    case 'pie':
      lines = lines.map((line, index) => (index > header ? repairPieLine(line) : line));
      break;
    case 'er':
      lines = lines.map((line, index) => (index > header ? repairErLine(line) : line));
      break;
    default:
      break;
  }
  return lines
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Mermaid blocks inside markdown
// ---------------------------------------------------------------------------

export interface MermaidBlock {
  /** Offset of the first character of the diagram source (the line after the opening fence). */
  start: number;
  /** Offset just past the last character of the source (before the line break that precedes the closing fence). */
  end: number;
  /** The diagram source, with the fence's own indentation removed. */
  code: string;
}

interface ScannedBlock extends MermaidBlock {
  /** Leading whitespace of the opening fence, re-applied when the body is replaced. */
  indent: string;
  eol: string;
}

const OPEN_FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;

function scanMermaidBlocks(markdown: string): ScannedBlock[] {
  const blocks: ScannedBlock[] = [];
  const lineRe = /[^\n]*(?:\n|$)/g;
  let open: { fence: string; indent: string; mermaid: boolean; bodyStart: number; bodyEnd: number; lines: string[]; eol: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(markdown)) && match[0] !== '') {
    const raw = match[0];
    const start = match.index;
    const line = raw.replace(/\r?\n$/, '');
    const eol = raw.slice(line.length);
    if (!open) {
      const fence = OPEN_FENCE.exec(line);
      if (fence && !(fence[2][0] === '`' && line.slice(fence[1].length + fence[2].length).includes('`'))) {
        open = {
          fence: fence[2],
          indent: fence[1],
          mermaid: /^mermaid$/i.test(fence[3]),
          bodyStart: start + raw.length,
          bodyEnd: start + raw.length,
          lines: [],
          eol: eol || '\n',
        };
      }
      continue;
    }
    const closing = new RegExp(`^[ \\t]*\\${open.fence[0]}{${open.fence.length},}[ \\t]*$`);
    if (closing.test(line)) {
      if (open.mermaid) blocks.push(finishBlock(open));
      open = null;
      continue;
    }
    if (open.lines.length === 0 && eol) open.eol = eol;
    open.lines.push(line);
    open.bodyEnd = start + line.length;
  }
  // An unclosed fence runs to the end of the document (as in CommonMark).
  if (open?.mermaid) blocks.push(finishBlock(open));
  return blocks;
}

function finishBlock(open: { indent: string; bodyStart: number; bodyEnd: number; lines: string[]; eol: string }): ScannedBlock {
  const width = open.indent.length;
  const code = open.lines
    .map((line) => {
      let cut = 0;
      while (cut < width && cut < line.length && (line[cut] === ' ' || line[cut] === '\t')) cut++;
      return line.slice(cut).replace(/\r$/, '');
    })
    .join('\n');
  return { start: open.bodyStart, end: open.lines.length ? open.bodyEnd : open.bodyStart, code, indent: open.indent, eol: open.eol };
}

/** Every ``` or ~~~ fenced block whose language is mermaid (any case), in document order. */
export function listMermaidBlocks(markdown: string): MermaidBlock[] {
  return scanMermaidBlocks(String(markdown ?? '')).map(({ start, end, code }) => ({ start, end, code }));
}

/**
 * Replace the body of each mermaid block with `fix(code)`. A null result (or the
 * same code) leaves the block alone; everything outside the replaced bodies is
 * kept byte for byte.
 */
export function repairMarkdownDiagrams(markdown: string, fix: (code: string) => string | null): string {
  const source = String(markdown ?? '');
  let out = '';
  let last = 0;
  for (const block of scanMermaidBlocks(source)) {
    const next = fix(block.code);
    if (next === null || next === block.code) continue;
    const body = next
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => (line ? block.indent + line : line))
      .join(block.eol);
    out += source.slice(last, block.start) + body + (block.start === block.end && body ? block.eol : '');
    last = block.end;
  }
  return out + source.slice(last);
}
