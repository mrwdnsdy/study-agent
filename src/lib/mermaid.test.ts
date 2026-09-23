/**
 * Run with: node --import tsx --test src/lib/mermaid.test.ts
 *
 * Rendering needs a browser, but sizing is pure and parsing works under Node
 * once DOMPurify (which needs a window) is stubbed: parsing only registers
 * hooks and sanitises label text.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_DIAGRAM_WIDTH,
  centreNodeLabels,
  diagramDisplayWidth,
  isValidMermaid,
  mermaidError,
  normaliseMermaidCode,
  resolveMermaidCode,
  svgDimensions,
} from './mermaid';

async function stubDomPurify(): Promise<boolean> {
  try {
    const purify = (await import('dompurify')).default as unknown as Record<string, unknown>;
    if (typeof purify.addHook !== 'function') {
      Object.assign(purify, {
        addHook: () => undefined,
        removeHook: () => undefined,
        removeHooks: () => undefined,
        removeAllHooks: () => undefined,
        sanitize: (text: unknown) => String(text),
      });
    }
    return true;
  } catch {
    return false;
  }
}

const skipParser = (await stubDomPurify()) ? false : 'DOMPurify could not be stubbed under Node';

/** Just enough of an Element for svgDimensions. */
function svgAttributes(attributes: Record<string, string>): Pick<Element, 'getAttribute'> {
  return { getAttribute: (name: string) => attributes[name] ?? null };
}

describe('svgDimensions', () => {
  test('width="100%" takes the size from the viewBox', () => {
    assert.deepEqual(
      svgDimensions(svgAttributes({ width: '100%', viewBox: '0 0 812.5 400', style: 'max-width: 812.5px;' })),
      { width: 812.5, height: 400 },
    );
  });

  test('plain and px sizes are used as they are', () => {
    assert.deepEqual(svgDimensions(svgAttributes({ width: '640', height: '480', viewBox: '0 0 10 10' })), { width: 640, height: 480 });
    assert.deepEqual(svgDimensions(svgAttributes({ width: '640px', height: '480px' })), { width: 640, height: 480 });
  });

  test('other units or a missing size fall back to the viewBox, keeping its aspect ratio', () => {
    assert.deepEqual(svgDimensions(svgAttributes({ width: '50em', height: 'auto', viewBox: '0 0 300 200' })), { width: 300, height: 200 });
    assert.deepEqual(svgDimensions(svgAttributes({ viewBox: '-8,-8,300,200' })), { width: 300, height: 200 });
    assert.deepEqual(svgDimensions(svgAttributes({ width: '600', viewBox: '0 0 300 200' })), { width: 600, height: 400 });
    assert.deepEqual(svgDimensions(svgAttributes({ height: '100', viewBox: '0 0 300 200' })), { width: 150, height: 100 });
  });

  test('without a viewBox, the max-width style gives the width; then defaults', () => {
    assert.deepEqual(svgDimensions(svgAttributes({ width: '100%', height: '320', style: 'max-width: 900px;' })), { width: 900, height: 320 });
    assert.deepEqual(svgDimensions(svgAttributes({ width: '100%', viewBox: '0 0 0 0' })), { width: 800, height: 500 });
    assert.deepEqual(svgDimensions(svgAttributes({})), { width: 800, height: 500 });
  });
});

describe('diagramDisplayWidth', () => {
  test('natural size when it fits, capped at 1100 px', () => {
    assert.equal(diagramDisplayWidth(400, 700), 400);
    assert.equal(diagramDisplayWidth(700, 700), 700);
    assert.equal(diagramDisplayWidth(2000, 1400), MAX_DIAGRAM_WIDTH);
    assert.equal(diagramDisplayWidth(600, 0), 600, 'an unmeasured column changes nothing');
  });

  test('a little too wide: shrinks to fit the column, down to 75%', () => {
    assert.equal(diagramDisplayWidth(517, 496), 496, 'no sideways scroll for a few pixels');
    assert.equal(diagramDisplayWidth(900, 700), 700);
    assert.equal(diagramDisplayWidth(1000, 750), 750);
    assert.equal(diagramDisplayWidth(2000, 900), 900, 'measured against the 1100 px cap');
  });

  test('much too wide: 75% of its size, scrolling sideways', () => {
    assert.equal(diagramDisplayWidth(1000, 549), 750);
    assert.equal(diagramDisplayWidth(800, 269), 600, 'a diagram in the chat column');
    assert.equal(diagramDisplayWidth(1600, 300), 825, '75% of the 1100 px cap');
  });
});

describe('centreNodeLabels', () => {
  // Trimmed from mermaid 12 output with plain-SVG labels.
  const label = (x: string, text: string) =>
    `<g class="label" style="" transform="translate(${x}, -9)"><rect></rect><g><rect class="background" style="stroke: none"></rect>` +
    `<text y="-10.1" style=""><tspan class="text-outer-tspan row" x="0" y="-0.1em" dy="1.1em"><tspan class="text-inner-tspan">${text}</tspan></tspan></text></g></g>`;
  const mindmapNode = (shape: string, x: string, text: string) =>
    `<g class="node mindmap-node section-5" id="m-${text}" data-look="classic" transform="translate(10, 20)">${shape}${label(x, text)}</g>`;
  const circle = '<circle class="basic label-container" r="35" cx="0" cy="0"></circle>';
  const cloud = '<path class="basic label-container" d="M0 0"></path>';
  const stateBox = (text: string) =>
    `<g class="node  statediagram-state" id="s-${text}" data-look="classic" transform="translate(76, 89)"><rect class="basic label-container" rx="5" ry="5" x="-68" y="-17" width="136" height="34"></rect>${label('-60', text)}</g>`;
  const centred = (svg: string) => svg.match(/transform="translate\(0, -9\)"><rect><\/rect><g><rect class="background" style="stroke: none"><\/rect><text text-anchor="middle" y="-10.1"/g)?.length ?? 0;

  test('centres mindmap labels drawn from the node centre and those already centred alike', () => {
    const svg = `<svg aria-roledescription="mindmap"><g class="mindmap-nodes">${mindmapNode(circle, '0', 'Root')}${mindmapNode(cloud, '-42.53125', 'Cloud')}</g></svg>`;
    const fixed = centreNodeLabels(svg);
    assert.equal(centred(fixed), 2);
    assert.equal(fixed.replaceAll(' text-anchor="middle"', '').replace('translate(0, -9)"><rect></rect><g><rect class="background" style="stroke: none"></rect><text y="-10.1" style=""><tspan class="text-outer-tspan row" x="0" y="-0.1em" dy="1.1em"><tspan class="text-inner-tspan">Cloud', 'translate(-42.53125, -9)"><rect></rect><g><rect class="background" style="stroke: none"></rect><text y="-10.1" style=""><tspan class="text-outer-tspan row" x="0" y="-0.1em" dy="1.1em"><tspan class="text-inner-tspan">Cloud'), svg, 'nothing else changes');
  });

  test('centres state box labels but not edge labels', () => {
    const edge = `<g class="edgeLabel"><g class="label" transform="translate(-30, -9)"><text y="0">start work</text></g></g>`;
    const svg = `<svg aria-roledescription="stateDiagram"><g class="nodes">${stateBox('Idle')}${stateBox('Busy')}</g><g class="edgeLabels">${edge}</g></svg>`;
    const fixed = centreNodeLabels(svg);
    assert.equal(centred(fixed), 2);
    assert.ok(fixed.includes(edge), 'edge labels are left alone');
    assert.equal(centreNodeLabels(fixed), fixed, 'idempotent');
  });

  test('leaves other diagrams and label-less nodes alone', () => {
    const flowchart = '<svg aria-roledescription="flowchart-v2"><g class="node default"><rect></rect><g class="label" transform="translate(-20, -9)"><text y="0">A</text></g></g></svg>';
    assert.equal(centreNodeLabels(flowchart), flowchart);
    const bare = `<svg><g class="node mindmap-node section-1" transform="translate(0, 0)">${circle}</g><g class="edgeLabel"><g class="label" transform="translate(-30, -9)"><text y="0">x</text></g></g></svg>`;
    assert.equal(centreNodeLabels(bare), bare, 'a later, unrelated label is never taken');
  });
});

test('normaliseMermaidCode strips a fence and trims', () => {
  assert.equal(normaliseMermaidCode('```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\n'), 'flowchart TD\n  A --> B');
});

describe('parsing', { skip: skipParser }, () => {
  test('mermaidError is null for a valid diagram and the first line of the error otherwise', async () => {
    assert.equal(await mermaidError('flowchart TD\n  A --> B'), null);
    assert.equal(await mermaidError('flowchart TD\n  A[Input (raw)] --> B'), 'Parse error on line 2');
    const unknown = await mermaidError(`notADiagram ${'x'.repeat(400)}`);
    assert.ok(unknown && unknown.length <= 200 && !unknown.includes('\n'), unknown ?? '');
    assert.equal(await isValidMermaid('pie\n  "A" : 1'), true);
    assert.equal(await isValidMermaid('pie\n  "A" : 1%'), false);
  });

  test('resolveMermaidCode keeps valid code, repairs what it can and reports the original error', async () => {
    assert.deepEqual(await resolveMermaidCode('```mermaid\nflowchart TD\n  A --> B\n```'), { code: 'flowchart TD\n  A --> B', repaired: false });
    assert.deepEqual(await resolveMermaidCode('flowchart TD\n  A[Input (raw)] --> B'), {
      code: 'flowchart TD\n  A["Input (raw)"] --> B',
      repaired: true,
    });
    assert.deepEqual(await resolveMermaidCode('mindmap\n  root((Topic))\n    A\n  classDef core fill:#FBEFD0'), {
      code: 'mindmap\n  root((Topic))\n    A',
      repaired: true,
    });
    const broken = 'flowchart TD\n  A -->';
    const resolved = await resolveMermaidCode(broken);
    assert.equal(resolved.code, undefined);
    assert.equal(resolved.error, await mermaidError(broken));
    assert.ok(resolved.error);
  });
});
