import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGuideEdit, findHeading, listHeadings, wordCount } from './guideEdits.js';

const GUIDE = `# Networking — Complete Study Guide

Intro paragraph.

## Module map

\`\`\`mermaid
flowchart TD
  A["# not a heading"] --> B["B"]
\`\`\`

## Slide-by-slide walkthrough

### Slide 1 — TCP handshake

Three-way handshake text.

### Slide 2 — UDP

UDP text.

## Glossary

- **TCP**: transmission control protocol
`;

test('listHeadings ignores fenced code', () => {
  const headings = listHeadings(GUIDE);
  assert.deepEqual(
    headings.map((h) => `${h.level}:${h.text}`),
    ['1:Networking — Complete Study Guide', '2:Module map', '2:Slide-by-slide walkthrough', '3:Slide 1 — TCP handshake', '3:Slide 2 — UDP', '2:Glossary'],
  );
});

test('findHeading matches loosely', () => {
  const headings = listHeadings(GUIDE);
  assert.equal(findHeading(headings, 'slide 2')?.text, 'Slide 2 — UDP');
  assert.equal(findHeading(headings, '## Glossary')?.text, 'Glossary');
  assert.equal(findHeading(headings, 'TCP handshake')?.text, 'Slide 1 — TCP handshake');
  assert.equal(findHeading(headings, 'Nonexistent section'), null);
});

test('replace_section replaces only that section and keeps the heading', () => {
  const result = applyGuideEdit(GUIDE, 'replace_section', 'Slide 1', 'New handshake explanation.\n\n> **💡 Gold-standard tip:** SYN, SYN-ACK, ACK.');
  assert.ok(result.ok);
  assert.match(result.markdown, /### Slide 1 — TCP handshake\n\nNew handshake explanation\./);
  assert.doesNotMatch(result.markdown, /Three-way handshake text/);
  assert.match(result.markdown, /### Slide 2 — UDP\n\nUDP text\./);
  assert.match(result.markdown, /## Glossary/);
});

test('replace_section with an explicit heading in content uses it', () => {
  const result = applyGuideEdit(GUIDE, 'replace_section', 'Glossary', '## Glossary (expanded)\n\n- **UDP**: user datagram protocol');
  assert.ok(result.ok);
  assert.match(result.markdown, /## Glossary \(expanded\)/);
  assert.doesNotMatch(result.markdown, /transmission control protocol/);
});

test('insert_after_section inserts after the whole section including subsections', () => {
  const result = applyGuideEdit(GUIDE, 'insert_after_section', 'Slide-by-slide walkthrough', '## Cross-cutting concepts\n\nText.');
  assert.ok(result.ok);
  const idx = result.markdown.indexOf('## Cross-cutting concepts');
  assert.ok(idx > result.markdown.indexOf('### Slide 2 — UDP'));
  assert.ok(idx < result.markdown.indexOf('## Glossary'));
});

test('append and replace_all', () => {
  const appended = applyGuideEdit(GUIDE, 'append', '', '## Exam strategy\n\nPlan.');
  assert.ok(appended.ok);
  assert.ok(appended.markdown.trimEnd().endsWith('Plan.'));
  const replaced = applyGuideEdit(GUIDE, 'replace_all', '', '# Brand new');
  assert.equal(replaced.markdown, '# Brand new\n');
});

test('unknown heading reports available headings', () => {
  const result = applyGuideEdit(GUIDE, 'replace_section', 'Missing', 'x');
  assert.equal(result.ok, false);
  assert.match(result.message, /Available headings/);
  assert.match(result.message, /## Glossary/);
});

test('wordCount counts words', () => {
  assert.equal(wordCount('Hello world — it\'s 3 words? no, five'), 7);
});
