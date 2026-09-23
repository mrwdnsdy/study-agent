/**
 * Run with: node --import tsx --test src/browser/diagramFix.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixDiagramsInMarkdown, type BrokenDiagram } from './diagramFix';

/**
 * A stand-in parser: a diagram is broken when it says BROKEN or has an
 * unquoted label with parentheses, which the rule-based repair quotes.
 */
async function validate(code: string): Promise<string | null> {
  if (code.includes('BROKEN')) return 'Parse error on line 2';
  if (/\[[^"\]]*\(/.test(code)) return 'Parse error on line 2: unquoted label';
  return null;
}

const fence = (code: string) => `\`\`\`mermaid\n${code}\n\`\`\``;

const VALID = 'flowchart TD\n  A --> B';
const REPAIRABLE = 'flowchart TD\n  A[Input (raw)] --> B';
const REPAIRED = 'flowchart TD\n  A["Input (raw)"] --> B';
const NEEDS_MODEL = 'flowchart TD\n  A --> BROKEN';
const MODEL_FIX = 'flowchart TD\n  A --> B["Fixed"]';

const DOC = [
  '# Guide',
  '',
  fence(VALID),
  '_Valid caption._',
  '',
  '## Section “two”',
  '',
  fence(REPAIRABLE),
  '',
  fence(NEEDS_MODEL),
  '*Model caption.*',
  '',
  'The end.',
  '',
].join('\n');

test('keeps valid diagrams, repairs locally, then asks the model once for the rest', async () => {
  const calls: BrokenDiagram[][] = [];
  const status: string[] = [];
  const result = await fixDiagramsInMarkdown(DOC, {
    validate,
    onStatus: (text) => status.push(text),
    repairWithModel: async (items) => {
      calls.push(items);
      return items.map(() => MODEL_FIX);
    },
  });
  assert.deepEqual(calls, [[{ code: NEEDS_MODEL, error: 'Parse error on line 2' }]]);
  assert.deepEqual(status, ['Tidying up 1 diagram…']);
  assert.equal(result.fixed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.markdown, DOC.replace(fence(REPAIRABLE), fence(REPAIRED)).replace(fence(NEEDS_MODEL), fence(MODEL_FIX)));
});

test('leaves the document alone when every diagram is valid', async () => {
  let called = false;
  const markdown = `# T\n\n${fence(VALID)}\n`;
  const result = await fixDiagramsInMarkdown(markdown, {
    validate,
    repairWithModel: async (items) => {
      called = true;
      return items.map(() => null);
    },
  });
  assert.deepEqual(result, { markdown, fixed: 0, failed: 0 });
  assert.equal(called, false);
});

test('counts what the model could not fix and gives its code a rule-based second chance', async () => {
  const other = 'flowchart LR\n  X --> BROKEN';
  const markdown = [fence(NEEDS_MODEL), fence(other), fence(NEEDS_MODEL)].join('\n\n');
  const result = await fixDiagramsInMarkdown(markdown, {
    validate,
    // First: still broken as sent back, but the rule-based repair can finish it. Second: still broken.
    repairWithModel: async () => ['flowchart TD\n  A --> C[Done (ok)]', 'flowchart LR\n  X --> BROKEN'],
  });
  assert.equal(result.fixed, 2, 'both copies of the first diagram');
  assert.equal(result.failed, 1);
  assert.ok(result.markdown.includes('A --> C["Done (ok)"]'));
  assert.ok(result.markdown.includes(fence(other)));
});

test('sends at most `max` diagrams and counts the rest as failed', async () => {
  const codes = Array.from({ length: 5 }, (_, i) => `flowchart TD\n  N${i} --> BROKEN`);
  let sent = 0;
  const result = await fixDiagramsInMarkdown(codes.map(fence).join('\n\n'), {
    validate,
    max: 3,
    repairWithModel: async (items) => {
      sent = items.length;
      return items.map((item) => item.code.replace('BROKEN', 'OK'));
    },
  });
  assert.equal(sent, 3);
  assert.equal(result.fixed, 3);
  assert.equal(result.failed, 2);
});

test('never throws: a failing model or validator keeps the fixes that worked', async () => {
  const modelFails = await fixDiagramsInMarkdown(DOC, {
    validate,
    repairWithModel: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(modelFails.fixed, 1);
  assert.equal(modelFails.failed, 1);
  assert.ok(modelFails.markdown.includes(fence(REPAIRED)) && modelFails.markdown.includes(fence(NEEDS_MODEL)));

  const withoutModel = await fixDiagramsInMarkdown(DOC, { validate });
  assert.deepEqual(withoutModel, modelFails);

  const validatorFails = await fixDiagramsInMarkdown(DOC, {
    validate: async () => {
      throw new Error('mermaid failed to load');
    },
    repairWithModel: async () => {
      throw new Error('should not be called');
    },
  });
  assert.deepEqual(validatorFails, { markdown: DOC, fixed: 0, failed: 0 });

  const weird = await fixDiagramsInMarkdown(DOC, { validate, repairWithModel: async () => [42 as unknown as string] });
  assert.equal(weird.failed, 1);
});

test('uses the real mermaid parser by default', async (t) => {
  // mermaid parses under Node once DOMPurify, which needs a browser window, is stubbed.
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
    await import('mermaid');
  } catch {
    t.skip('mermaid could not be loaded under Node');
    return;
  }
  const markdown = `# T\n\n${fence('flowchart TD\n  A[Input (raw)] --> end')}\n\n${fence('pie\n  "A" : 40%\n  "B" : 60%')}\n`;
  const result = await fixDiagramsInMarkdown(markdown);
  assert.equal(result.fixed, 2);
  assert.equal(result.failed, 0);
  assert.ok(result.markdown.includes('A["Input (raw)"] --> end_["end"]'));
  assert.ok(result.markdown.includes('"A" : 40\n  "B" : 60'));
});

test('replaces a diagram that parses but draws the wrong thing with its repair', async () => {
  // mermaid accepts flowchart labels in a state diagram and invents extra states from them.
  const lenient = 'stateDiagram-v2\n  [*] --> A["Idle state"]\n  A --> [*]';
  const result = await fixDiagramsInMarkdown(fence(lenient), { validate: async () => null });
  assert.equal(result.fixed, 1);
  assert.ok(result.markdown.includes('state "Idle state" as A'), result.markdown);
  assert.ok(!result.markdown.includes('A["Idle state"]'), result.markdown);
});
