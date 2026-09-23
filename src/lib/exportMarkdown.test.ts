/**
 * Quiz, chat and diagram exports. Run with:
 *   node --import tsx --test src/lib/exportMarkdown.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Heading, Paragraph, Root } from 'mdast';
import type { ChatMessage, Quiz } from '../../shared/types';
import { chatToMarkdown, listDiagrams, quizToMarkdown } from './exportMarkdown';
import { mdastToPlainText, parseMarkdown } from './markdownAst';

// Clock times below are read in UTC; dates and times use the default locale, like the exporters.
process.env.TZ = 'UTC';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Plain text of every top-level paragraph, as the exporters would print it. */
function paragraphs(tree: Root): string[] {
  return tree.children.filter((node): node is Paragraph => node.type === 'paragraph').map((node) => mdastToPlainText(node));
}

function headings(tree: Root): string[] {
  return tree.children.filter((node): node is Heading => node.type === 'heading').map((node) => mdastToPlainText(node));
}

const QUIZ: Quiz = {
  id: 'q1',
  title: 'Cells & membranes',
  createdAt: '2026-09-21T12:00:00.000Z',
  config: { numQuestions: 4, difficulty: 'mixed', types: ['multiple_choice', 'true_false', 'short_answer'], focus: 'slides 1–10' },
  status: 'completed',
  questions: [
    {
      id: 'a',
      type: 'multiple_choice',
      topic: 'Membranes',
      difficulty: 'easy',
      question: 'What does the **cell membrane** do?',
      options: ['Makes proteins', 'Controls what enters and leaves', 'Stores DNA', '2 * 3 * 4 [ATP]'],
      correctOptionIndex: 1,
      modelAnswer: 'B. It controls what enters and leaves the cell.',
      explanation: 'The membrane is *selectively permeable*.',
      sourceRef: 'Slide 4',
      hint: 'Think of a border checkpoint.',
    },
    {
      id: 'b',
      type: 'true_false',
      topic: 'Organelles',
      difficulty: 'medium',
      question: 'Mitochondria make ATP.',
      options: ['True', 'False'],
      correctOptionIndex: 0,
      modelAnswer: 'True',
      explanation: 'Oxidative phosphorylation happens there.',
    },
    {
      id: 'c',
      type: 'short_answer',
      topic: 'Transport',
      difficulty: 'hard',
      question: 'Explain osmosis.',
      modelAnswer: '- Water moves across a membrane\n- from low to high solute concentration',
      explanation: 'Water follows the solutes.',
    },
    {
      id: 'd',
      type: 'short_answer',
      topic: 'Transport',
      difficulty: 'medium',
      question: 'What is diffusion?',
      modelAnswer: 'Net movement down a concentration gradient.',
      explanation: 'No energy needed.',
    },
  ],
  answers: [
    { questionId: 'a', answer: 'Stores DNA', selectedOptionIndex: 2, correct: false, score: 0, feedback: 'DNA lives in the nucleus.', answeredAt: '2026-09-21T12:01:00.000Z' },
    { questionId: 'b', answer: 'True', selectedOptionIndex: 0, correct: true, score: 100, feedback: 'Right!', answeredAt: '2026-09-21T12:02:00.000Z' },
    {
      questionId: 'c',
      answer: '# water moves\n  towards *more* salt',
      correct: false,
      score: 60,
      feedback: '```\nunclosed fence from a cut-off answer',
      answeredAt: '2026-09-21T12:03:00.000Z',
    },
  ],
};

describe('quizToMarkdown', () => {
  const markdown = quizToMarkdown(QUIZ, 'Kiiku');
  const tree = parseMarkdown(markdown);

  it('opens with the title, the date, the details and the score', () => {
    assert.equal(headings(tree)[0], 'Quiz — Cells & membranes', 'matches the export title, so the exporters print it once');
    assert.ok(markdown.includes(`${day(QUIZ.createdAt)} · 4 questions · mixed difficulty · written and graded by Kiiku`));
    assert.ok(markdown.includes('**Focus:** slides 1–10'));
    assert.ok(markdown.includes('**Score: 1 of 3 correct (33%)** · 1 not answered'));
  });

  it('numbers each question and tags it with topic · difficulty · type', () => {
    assert.deepEqual(headings(tree).slice(1), ['Question 1', 'Question 2', 'Question 3', 'Question 4']);
    assert.ok(markdown.includes('*Membranes · easy · Multiple choice*'));
    assert.ok(markdown.includes('*Organelles · medium · True / false*'));
    assert.ok(markdown.includes('What does the **cell membrane** do?'), 'question markdown is kept');
  });

  it('letters the options, marks the correct one ✓ and the student’s pick', () => {
    assert.ok(markdown.includes('- **A.** Makes proteins\n- **B.** Controls what enters and leaves ✓\n- **C.** Stores DNA ← *your answer*\n'));
    assert.ok(markdown.includes('- **A.** True ✓ ← *your answer*\n- **B.** False'));
    const options = tree.children.find((node) => node.type === 'list');
    assert.ok(options);
    assert.match(mdastToPlainText(options), /D\. 2 \* 3 \* 4 \[ATP\]/, 'option text is shown as written, not as markup');
  });

  it('gives the result and score, feedback, model answer, explanation, source and hint', () => {
    assert.ok(markdown.includes('**Result:** ✗ Incorrect · 0/100'));
    assert.ok(markdown.includes('**Result:** ✓ Correct · 100/100'));
    assert.ok(markdown.includes('**Result:** Partly right · 60/100'));
    assert.ok(markdown.includes('**Feedback:** DNA lives in the nucleus.'));
    assert.ok(markdown.includes('**Model answer:** B. It controls what enters and leaves the cell.'));
    assert.ok(markdown.includes('**Model answer:**\n\n- Water moves across a membrane'), 'a list goes below its label');
    assert.ok(markdown.includes('**Explanation:** The membrane is *selectively permeable*.'));
    assert.ok(markdown.includes('**Source:** Slide 4  \n**Hint:** Think of a border checkpoint.'));
    assert.ok(markdown.includes('*Not answered.*'));
  });

  it('shows a typed answer verbatim, line breaks included', () => {
    assert.ok(paragraphs(tree).includes('Your answer: # water moves\n  towards *more* salt'));
  });

  it('closes a code fence left open, so the rest of the quiz still renders', () => {
    assert.ok(paragraphs(tree).includes('Explanation: Water follows the solutes.'));
    assert.equal(headings(tree).at(-1), 'Question 4');
  });

  it('leaves the score out until something is answered', () => {
    const fresh = quizToMarkdown({ ...QUIZ, answers: [], status: 'in_progress' }, 'Kiiku');
    assert.ok(!fresh.includes('Score'));
    assert.equal((fresh.match(/\*Not answered\.\*/g) ?? []).length, 4);
  });
});

describe('chatToMarkdown', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: '# Why *is* 2*3 = 6?\n- not a list', createdAt: '2026-09-21T09:05:00.000Z' },
    { id: '2', role: 'assistant', content: 'Because **multiplication** is repeated addition:\n\n- 3 + 3 = 6', createdAt: '2026-09-21T09:06:00.000Z' },
    { id: '3', role: 'assistant', content: '   ', createdAt: '2026-09-21T09:07:00.000Z' },
    { id: '4', role: 'assistant', content: 'Here is code:\n\n```python\nprint(6)', createdAt: '2026-09-22T10:00:00.000Z' },
    { id: '5', role: 'user', content: 'Thanks!', createdAt: '2026-09-22T10:01:00.000Z' },
  ];
  const markdown = chatToMarkdown(messages, 'Kiiku', 'Biology 101');
  const tree = parseMarkdown(markdown);

  it('starts with a heading that matches the export title', () => {
    assert.ok(markdown.startsWith('# Biology 101 — chat with Kiiku\n'));
    assert.deepEqual(headings(tree), ['Biology 101 — chat with Kiiku'], "the student's '#' stays text");
  });

  it('labels each message with who wrote it and when, skipping empty ones', () => {
    assert.ok(markdown.includes(`**You** · ${time(messages[0].createdAt)}`));
    assert.ok(markdown.includes(`**Kiiku** · ${time(messages[1].createdAt)}`));
    assert.equal((markdown.match(/\*\*Kiiku\*\* · /g) ?? []).length, 2, 'the blank message is left out');
    assert.ok(markdown.indexOf('**You**') < markdown.indexOf('**Kiiku**'));
  });

  it("keeps the tutor's markdown and shows the student's text as written", () => {
    assert.ok(markdown.includes('Because **multiplication** is repeated addition:\n\n- 3 + 3 = 6'));
    assert.ok(paragraphs(tree).includes('# Why *is* 2*3 = 6?\n- not a list'));
  });

  it('puts the date above the first message of each day', () => {
    assert.equal(markdown.split(`*${day(messages[0].createdAt)}*`).length - 1, 1);
    assert.equal(markdown.split(`*${day(messages[3].createdAt)}*`).length - 1, 1);
  });

  it('closes a code fence left open, so the next message is not swallowed', () => {
    assert.ok(paragraphs(tree).includes(`You · ${time(messages[4].createdAt)}`));
    assert.ok(paragraphs(tree).includes('Thanks!'));
  });
});

describe('listDiagrams', () => {
  const guide = [
    '# Guide',
    '```mermaid\nflowchart LR\n  A["Client"] --> B["Server"]\n```',
    '*Figure 1: Notice how the client always speaks first.*',
    '```mermaid\n%%{init: {"theme": "base"}}%%\npie title Where the energy goes\n  "Heat" : 60\n```',
    '- A list with a nested diagram:\n\n  ```mermaid\n  mindmap\n    root((Cell biology))\n  ```',
    '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n```',
    '```js\nconsole.log("not a diagram")\n```',
    '```mermaid\nflowchart TD\n  A --> B\n```',
    `*${'A very long caption that keeps going '.repeat(4)}and ends here.*`,
  ].join('\n\n');

  it('names every diagram in order after its caption, else its title or first label', () => {
    const diagrams = listDiagrams(guide);
    assert.deepEqual(
      diagrams.map((d) => d.name),
      [
        'Diagram 1 — Notice how the client always speaks first',
        'Diagram 2 — Where the energy goes',
        'Diagram 3 — Cell biology',
        'Diagram 4',
        diagrams[4].name,
      ],
    );
    assert.equal(diagrams[0].code, 'flowchart LR\n  A["Client"] --> B["Server"]');
    assert.equal(diagrams.length, 5, 'only mermaid blocks count');
  });

  it('shortens a long caption at a word boundary', () => {
    const name = listDiagrams(guide)[4].name;
    assert.match(name, /^Diagram 5 — A very long caption that keeps going .+…$/);
    assert.ok(name.length <= 'Diagram 5 — '.length + 81);
  });

  it('finds nothing in a guide without diagrams', () => {
    assert.deepEqual(listDiagrams('# Just text\n\nNo diagrams here.'), []);
  });
});
