/**
 * Mermaid repair tests. Run with:
 *   node --import tsx --test shared/agent/mermaidRepair.test.ts
 *
 * Besides the expected text, every broken sample is checked against the real
 * mermaid 12 parser when it can be loaded under Node: it must fail before the
 * repair and parse after it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectDiagramType, listMermaidBlocks, repairMarkdownDiagrams, repairMermaid, type DiagramType } from './mermaidRepair.js';
import { MERMAID_RULES } from './prompts.js';

/**
 * mermaid parses under Node once DOMPurify, which needs a browser window, is
 * stubbed: parsing only registers hooks and sanitises label text. Returns a
 * function giving the parser's error (null when valid), or null when mermaid
 * cannot be loaded here, in which case the parser checks are skipped.
 */
async function loadParser(): Promise<((code: string) => Promise<string | null>) | null> {
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
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return async (code) => {
      try {
        await mermaid.parse(code);
        return null;
      } catch (err) {
        return String((err as Error)?.message ?? err).split('\n')[0];
      }
    };
  } catch {
    return null;
  }
}

const parse = await loadParser();
const skipParser = parse ? false : 'mermaid could not be loaded under Node';

interface Case {
  name: string;
  input: string;
  expected: string;
}

/** Broken diagrams (each fails to parse in mermaid 12) and their repairs. */
const CASES: Case[] = [
  // --- every type -----------------------------------------------------------
  {
    name: 'strips a surrounding fence, %%{init}%% and an italic caption',
    input: '```mermaid\n%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B\n_What to notice._\n```',
    expected: 'flowchart TD\n  A --> B',
  },
  {
    name: 'strips front matter and a starred caption',
    input: '---\nconfig:\n  theme: [bad\n---\nflowchart TD\n  A --> B\n*The whole flow.*',
    expected: 'flowchart TD\n  A --> B',
  },
  {
    name: 'straightens curly quotes and turns unicode arrows into -->',
    input: 'flowchart TD\n  A[“Input (raw)”] → B\n  B ⟶ C\n  C ⇒ D',
    expected: 'flowchart TD\n  A["Input (raw)"] --> B\n  B --> C\n  C --> D',
  },
  {
    name: 'removes trailing semicolons and fixes -- > and - ->',
    input: 'flowchart TD;\n  A -- > B;\n  B - -> C;',
    expected: 'flowchart TD\n  A --> B\n  B --> C',
  },
  {
    name: 'normalises <br> and <br /> to <br/>',
    input: 'flowchart TD\n  A[First<br>line (1)] --> B["Second<br />line"]',
    expected: 'flowchart TD\n  A["First<br/>line (1)"] --> B["Second<br/>line"]',
  },
  {
    name: 'fixes the case of the header keyword',
    input: 'Flowchart TD\n  A --> B',
    expected: 'flowchart TD\n  A --> B',
  },
  // --- flowchart ------------------------------------------------------------
  {
    name: 'renames end used as a node id, everywhere it is used',
    input: 'flowchart TD\n  start --> end\n  end --> done\n  classDef core fill:#FBEFD0\n  class end core',
    expected: 'flowchart TD\n  start --> end_["end"]\n  end_ --> done\n  classDef core fill:#FBEFD0\n  class end_ core',
  },
  {
    name: 'keeps the label of a renamed end node that has one',
    input: 'flowchart TD\n  end[Finish] --> B\n  B --> end',
    expected: 'flowchart TD\n  end_[Finish] --> B\n  B --> end_',
  },
  {
    name: 'quotes risky labels in every node shape',
    input: [
      'flowchart TD',
      '  A[Hello (x)] --> B([Start: here])',
      '  B --> C[[Sub, routine]]',
      '  C --> D((Hub #1))',
      '  D --> E{{Hex & more}}',
      '  E --> F[/In: x/]',
      '  F --> G{Ready?}',
      '  G --> H(Round (y))',
      '  H --> I[f(x) = [a, b]]',
      '  I --> J[user@mail] & K[a – b]',
    ].join('\n'),
    expected: [
      'flowchart TD',
      '  A["Hello (x)"] --> B(["Start: here"])',
      '  B --> C[["Sub, routine"]]',
      '  C --> D(("Hub #1"))',
      '  D --> E{{"Hex & more"}}',
      '  E --> F[/"In: x"/]',
      '  F --> G{Ready?}',
      '  G --> H("Round (y)")',
      '  H --> I["f(x) = [a, b]"]',
      '  I --> J["user@mail"] & K["a – b"]',
    ].join('\n'),
  },
  {
    name: 'escapes inner quotes and strips markdown and HTML from labels',
    input: 'flowchart TD\n  A[say "hi"] --> B["**Bold** and __two words__ <b>x</b>"]\n  B --> C["x "y" z"]',
    expected: 'flowchart TD\n  A["say #quot;hi#quot;"] --> B["Bold and two words x"]\n  B --> C["x #quot;y#quot; z"]',
  },
  {
    name: 'quotes |edge| labels',
    input: 'flowchart LR\n  A -->|yes (x)| B\n  A -->|say "no"| C\n  A -->|"ok"| D',
    expected: 'flowchart LR\n  A -->|"yes (x)"| B\n  A -->|"say #quot;no#quot;"| C\n  A -->|"ok"| D',
  },
  {
    name: 'removes spaces after commas in class statements',
    input: 'flowchart TD\n  A --> B\n  classDef core fill:#FBEFD0\n  class A, B core',
    expected: 'flowchart TD\n  A --> B\n  classDef core fill:#FBEFD0\n  class A,B core',
  },
  {
    name: 'closes a subgraph that was never ended',
    input: 'flowchart TD\n  subgraph S1["Stage 1"]\n    A --> B\n  end\n  subgraph S2["Stage 2"]\n    C --> D',
    expected: 'flowchart TD\n  subgraph S1["Stage 1"]\n    A --> B\n  end\n  subgraph S2["Stage 2"]\n    C --> D\n  end',
  },
  {
    name: 'quotes subgraph titles, drops a stray end, a space before a shape and fixes ->',
    input: 'flowchart TD\n  subgraph S[Group (x)]\n    A [Hello] -> B\n  end\n  subgraph Other (y)\n    C --> D\n  end\n  end',
    expected: 'flowchart TD\n  subgraph S["Group (x)"]\n    A[Hello] --> B\n  end\n  subgraph "Other (y)"\n    C --> D\n  end',
  },
  {
    name: 'repairs statements that share the header line',
    input: 'graph TD; A[x (y)]-->B; B-->end',
    expected: 'graph TD; A["x (y)"]-->B; B-->end_["end"]',
  },
  // --- sequence ---------------------------------------------------------------
  {
    name: 'sequence: semicolons in messages, notes and blocks, quoted text and unicode arrows',
    input: 'sequenceDiagram\n  Alice → Bob: Hello; world\n  Note right of Bob: a; b\n  loop every 5 s; retry\n    Bob->>Alice: "Hi"\n  end',
    expected: 'sequenceDiagram\n  Alice ->> Bob: Hello, world\n  Note right of Bob: a, b\n  loop every 5 s, retry\n    Bob->>Alice: Hi\n  end',
  },
  {
    name: 'sequence: drops classDef, class and style',
    input: 'sequenceDiagram\n  A->>B: hi\n  classDef core fill:#FBEFD0\n  class A core\n  style B fill:#fff',
    expected: 'sequenceDiagram\n  A->>B: hi',
  },
  // --- mindmap ----------------------------------------------------------------
  {
    name: 'mindmap: unquotes text, replaces brackets, strips list markers and styling',
    input: [
      'mindmap',
      '  root((Energy (ATP)))',
      '    "Glycolysis (cytoplasm)"',
      '    A[Krebs [cycle]]',
      '    1. Electron transport',
      '    - Yield {net}',
      '    B:::core',
      '  classDef core fill:#FBEFD0',
    ].join('\n'),
    expected: [
      'mindmap',
      '  root((Energy – ATP))',
      '    Glycolysis – cytoplasm',
      '    A[Krebs – cycle]',
      '    Electron transport',
      '    Yield – net',
      '    B',
    ].join('\n'),
  },
  {
    name: 'mindmap: moves a second root-level node under the root',
    input: 'mindmap\n  root((Topic))\n  Branch A\n    Leaf (1)\n  Branch B',
    expected: 'mindmap\n  root((Topic))\n    Branch A\n      Leaf – 1\n    Branch B',
  },
  {
    name: 'mindmap: drops class statements but keeps nodes that start with the word class',
    input: 'mindmap\n  root((OOP))\n    class hierarchy\n    class diagram basics\n  class A,B core\n  style A fill:#fff',
    expected: 'mindmap\n  root((OOP))\n    class hierarchy\n    class diagram basics',
  },
  // --- state ------------------------------------------------------------------
  {
    name: 'state: X["Label"] becomes a state declaration',
    input: 'StateDiagram-V2\n  [*] --> A["Idle state"]\n  A["Idle state"] --> B[Busy] : start\n  B -- > [*]',
    expected: 'stateDiagram-v2\n  state "Idle state" as A\n  state "Busy" as B\n  [*] --> A\n  A --> B : start\n  B --> [*]',
  },
  // --- class ------------------------------------------------------------------
  {
    name: 'class: semicolons in labels, unicode arrows and styling',
    input: 'classDiagram\n  Animal <|-- Duck : inherits; quacks\n  Animal → Fish\n  classDef core fill:#FBEFD0\n  class Animal,Duck core\n  class Fish:::core',
    expected: 'classDiagram\n  Animal <|-- Duck : inherits, quacks\n  Animal --> Fish\n  class Fish',
  },
  // --- timeline, pie and the rest ---------------------------------------------
  {
    name: 'timeline: unquotes events and drops styling',
    input: 'timeline\n  title History\n  2002 : "LinkedIn"\n  2004 : Facebook\n  classDef core fill:#FBEFD0\n  style x fill:#fff',
    expected: 'timeline\n  title History\n  2002 : LinkedIn\n  2004 : Facebook',
  },
  {
    name: 'pie: removes %, quotes labels and drops thousands separators',
    input: 'pie title Pets\n  Dogs : 38%\n  "Cats" : 1,200\n  "Birds" : 12 %;\n  classDef core fill:#FBEFD0',
    expected: 'pie title Pets\n  "Dogs" : 38\n  "Cats" : 1200\n  "Birds" : 12',
  },
  {
    name: 'quadrantChart: drops classDef',
    input: 'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]\n  classDef core fill:#FBEFD0',
    expected: 'quadrantChart\n  title Reach\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]',
  },
  {
    name: 'gantt: drops class statements',
    input: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2024-01-01, 10d\n  classDef core fill:#FBEFD0\n  class a1 core',
    expected: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2024-01-01, 10d',
  },
  {
    name: 'journey: drops classDef',
    input: 'journey\n  title My day\n  section Go\n    Make tea: 5: Me\n  classDef core fill:#FBEFD0',
    expected: 'journey\n  title My day\n  section Go\n    Make tea: 5: Me',
  },
  {
    name: 'erDiagram: quotes relationship labels and drops styling',
    input: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places; buys\n  classDef core fill:#FBEFD0\n  CUSTOMER:::core ||--|{ ITEM : has',
    expected: 'erDiagram\n  CUSTOMER ||--o{ ORDER : "places; buys"\n  CUSTOMER ||--|{ ITEM : has',
  },
];

/** Diagrams that already parse and follow the prompt's rules: the repair leaves them byte for byte. */
const VALID: Record<string, string> = {
  flowchart: [
    'flowchart TD',
    '  A["Raw input (CSV)"] --> B{"Valid?"}',
    '  B -->|"yes"| C["Store in DB"]',
    '  B -->|"no, retry"| A',
    '  C --> D(["Done"])',
    '  subgraph S1["Pipeline: stage 1"]',
    '    E["Parse"] --> F["Clean<br/>and dedupe"]',
    '  end',
    '  classDef core fill:#FBEFD0,stroke:#D9961A,color:#14343B',
    '  classDef good fill:#E6EFD6,stroke:#6E9A3C,color:#2E4B14',
    '  class A,C core',
    '  D:::good',
  ].join('\n'),
  'flowchart with plain labels and text links': 'graph TD\n  A[Start] --> B(Process)\n  B --> C{Decide}\n  C -- yes --> D[End]\n  C -. maybe .-> E[Retry]\n  E ==> A',
  'flowchart with a markdown string': 'flowchart TD\n  A["`**Bold** text`"] --> B',
  sequence: 'sequenceDiagram\n  participant C as Client\n  participant S as Server\n  C->>S: SYN\n  S-->>C: SYN-ACK\n  Note over C,S: Connected\n  loop Every 30 s\n    C->>S: Keep-alive\n  end',
  state: 'stateDiagram-v2\n  state "Running (busy)" as S2\n  [*] --> S1\n  S1 --> S2 : start\n  S2 --> [*] : crash\n  classDef core fill:#FBEFD0,stroke:#D9961A,color:#14343B\n  class S1 core',
  class: 'classDiagram\n  class Animal {\n    +String name\n    +eat(food) bool\n  }\n  Animal <|-- Duck : inherits',
  mindmap: 'mindmap\n  root((Networking))\n    Transport layer\n      TCP\n      UDP\n    Network layer\n      Routing',
  timeline: 'timeline\n  title Evolution of the web\n  section Early\n    1991 : First website\n    2004 : Web 2.0 : Social media',
  pie: 'pie title Energy mix\n  "Solar" : 35\n  "Wind" : 25.5',
};

describe('detectDiagramType', () => {
  const table: Array<[string, DiagramType]> = [
    ['flowchart TD\n  A --> B', 'flowchart'],
    ['graph LR\n  A --> B', 'flowchart'],
    ['Flowchart TD', 'flowchart'],
    ['```mermaid\nflowchart TD\n```', 'flowchart'],
    ['%%{init: {}}%%\n---\ntitle: x\n---\n%% note\nsequenceDiagram', 'sequence'],
    ['stateDiagram-v2', 'state'],
    ['stateDiagram', 'state'],
    ['classDiagram', 'class'],
    ['mindmap', 'mindmap'],
    ['timeline', 'timeline'],
    ['pie title Pets', 'pie'],
    ['erDiagram', 'er'],
    ['gantt', 'gantt'],
    ['journey', 'journey'],
    ['quadrantChart', 'quadrant'],
    ['gitGraph', 'other'],
    ['flowcharts TD', 'other'],
    ['', 'other'],
  ];
  for (const [code, type] of table) {
    test(`${JSON.stringify(code.split('\n').pop())} is ${type}`, () => assert.equal(detectDiagramType(code), type));
  }
});

describe('repairMermaid', () => {
  for (const { name, input, expected } of CASES) {
    test(name, () => {
      const repaired = repairMermaid(input);
      assert.equal(repaired, expected);
      assert.equal(repairMermaid(repaired), repaired, 'idempotent');
    });
  }

  test('leaves valid diagrams unchanged', () => {
    for (const [name, code] of Object.entries(VALID)) assert.equal(repairMermaid(code), code, name);
  });

  test('keeps a valid diagram valid in other ways: blank lines, comments and unknown types', () => {
    assert.equal(repairMermaid('\n\nflowchart TD\n  %% comment\n  A --> B\n\n'), 'flowchart TD\n  %% comment\n  A --> B');
    assert.equal(repairMermaid('gitGraph\n  commit\n  branch dev'), 'gitGraph\n  commit\n  branch dev');
    assert.equal(repairMermaid(''), '');
  });

  test('broken samples fail to parse before the repair and parse after it', { skip: skipParser }, async () => {
    for (const { name, input, expected } of CASES) {
      assert.ok(await parse!(input), `${name}: the sample should fail to parse as written`);
      assert.equal(await parse!(expected), null, `${name}: the repaired diagram should parse`);
    }
  });

  test('valid samples parse before and after the repair', { skip: skipParser }, async () => {
    for (const [name, code] of Object.entries(VALID)) {
      assert.equal(await parse!(code), null, name);
      assert.equal(await parse!(repairMermaid(code)), null, name);
    }
  });
});

describe('the prompt rules', () => {
  const classDefs = MERMAID_RULES.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('classDef '));
  const names = classDefs.map((line) => line.split(/\s+/)[1]);

  test('teach the four palette classes', () => {
    assert.deepEqual(names, ['core', 'info', 'good', 'warn']);
  });

  test('the palette parses in a flowchart', { skip: skipParser }, async () => {
    const flowchart = ['flowchart TD', '  A["One"] --> B["Two"]', ...classDefs.map((line) => `  ${line}`), '  class A,B core', '  B:::warn'].join('\n');
    assert.equal(await parse!(flowchart), null);
  });

  test('the repair recognises the palette classes where styling is not allowed', () => {
    for (const name of names) {
      assert.equal(repairMermaid(`mindmap\n  root((Topic))\n    A\n    class A ${name}`), 'mindmap\n  root((Topic))\n    A', name);
    }
  });
});

describe('listMermaidBlocks', () => {
  const DOC = [
    '# Title',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
    '_Caption._',
    '',
    '~~~Mermaid',
    'pie',
    '  "A" : 1',
    '~~~',
    '',
    '```python',
    'print("x")',
    '```',
    '',
    '- item',
    '',
    '  ```MERMAID',
    '  sequenceDiagram',
    '    A->>B: hi',
    '  ```',
    '',
    '````mermaid',
    'graph LR',
    '```',
    '````',
    '',
  ].join('\n');

  test('finds ``` and ~~~ mermaid fences in any case, with their source', () => {
    const blocks = listMermaidBlocks(DOC);
    assert.deepEqual(
      blocks.map((block) => block.code),
      ['flowchart TD\n  A --> B', 'pie\n  "A" : 1', 'sequenceDiagram\n  A->>B: hi', 'graph LR\n```'],
    );
    assert.equal(DOC.slice(blocks[0].start, blocks[0].end), 'flowchart TD\n  A --> B');
    assert.equal(DOC.slice(blocks[1].start, blocks[1].end), 'pie\n  "A" : 1');
    assert.equal(DOC.slice(blocks[2].start, blocks[2].end), '  sequenceDiagram\n    A->>B: hi');
  });

  test('ignores other languages and reads an unclosed fence to the end', () => {
    assert.deepEqual(listMermaidBlocks('```js\nx\n```\n'), []);
    assert.deepEqual(
      listMermaidBlocks('Text\n```mermaid\nflowchart TD\n  A --> B').map((block) => block.code),
      ['flowchart TD\n  A --> B'],
    );
    const empty = listMermaidBlocks('```mermaid\n```\n');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].code, '');
    assert.equal(empty[0].start, empty[0].end);
  });
});

describe('repairMarkdownDiagrams', () => {
  const DOC = 'Intro — keep “this” exactly;\n\n```mermaid\nflowchart TD\n  A[x (y)] --> B\n```\n*Caption.*\n\n```mermaid\nflowchart TD\n  A --> B\n```\nOutro\n';

  test('replaces block bodies and keeps everything else byte for byte', () => {
    const out = repairMarkdownDiagrams(DOC, (code) => (code.includes('(y)') ? 'flowchart TD\n  A["x (y)"] --> B' : null));
    assert.equal(
      out,
      'Intro — keep “this” exactly;\n\n```mermaid\nflowchart TD\n  A["x (y)"] --> B\n```\n*Caption.*\n\n```mermaid\nflowchart TD\n  A --> B\n```\nOutro\n',
    );
    assert.equal(repairMarkdownDiagrams(DOC, () => null), DOC);
    assert.equal(repairMarkdownDiagrams(DOC, (code) => code), DOC);
  });

  test('keeps CRLF line breaks, list indentation and empty blocks intact', () => {
    const crlf = 'A\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\nB\r\n';
    assert.equal(
      repairMarkdownDiagrams(crlf, () => 'flowchart LR\n  A --> B'),
      'A\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\nB\r\n',
    );
    const nested = '1. Step\n\n   ```mermaid\n   flowchart TD\n     A[x (y)] --> B\n   ```\n';
    assert.equal(
      repairMarkdownDiagrams(nested, repairMermaid),
      '1. Step\n\n   ```mermaid\n   flowchart TD\n     A["x (y)"] --> B\n   ```\n',
    );
    assert.equal(repairMarkdownDiagrams('```mermaid\n```\n', () => 'pie\n  "A" : 1'), '```mermaid\npie\n  "A" : 1\n```\n');
  });

  test('repairs every diagram of a guide into one that parses', { skip: skipParser }, async () => {
    // Samples that carry their own fence cannot sit inside another one.
    const samples = CASES.filter(({ input }) => !input.includes('```'));
    const guide = samples.map(({ name, input }) => `## ${name}\n\n\`\`\`mermaid\n${input}\n\`\`\`\n`).join('\n');
    const repaired = repairMarkdownDiagrams(guide, repairMermaid);
    const blocks = listMermaidBlocks(repaired);
    assert.equal(blocks.length, samples.length);
    for (const block of blocks) assert.equal(await parse!(block.code), null, block.code);
    assert.equal(repaired.split('\n## ').length, guide.split('\n## ').length, 'headings kept');
  });
});
