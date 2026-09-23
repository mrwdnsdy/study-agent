/**
 * Markdown for what the tutor makes besides the study guide and the reviews
 * (which already are markdown): a quiz with its answers, and the chat. The
 * exporters (Word, HTML, printable view, Google Drive) then treat them like
 * any other document. Also names the guide's diagrams for "Save all to Drive".
 * Pure: no DOM, so it runs under node:test.
 */
import type { Parent, RootContent } from 'mdast';
import { QUESTION_TYPE_LABELS, type ChatMessage, type Quiz, type QuizAnswer, type QuizQuestion } from '../../shared/types';
import { isMermaidCode, mdastToPlainText, parseMarkdown } from './markdownAst';

const LETTERS = 'ABCDEFGHIJ';
/** Characters that start inline markup anywhere in a line (and & for entities). */
const INLINE_MARKUP = /[\\`*_[\]<>~|&]/g;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Escapes inline markup so a single-line text renders exactly as written (titles, options, labels). */
function escapeInline(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(INLINE_MARKUP, '\\$&');
}

/**
 * Text the app shows verbatim (typed answers, the student's chat messages) as markdown that renders
 * the same: markup escaped, line breaks kept, and leading indentation kept as no-break spaces so it
 * cannot turn into a code block.
 */
function plainTextToMarkdown(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map(escapeLine)
        .filter((line) => line.trim())
        .join('  \n'),
    )
    .filter(Boolean)
    .join('\n\n');
}

function escapeLine(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
  const body = line
    .slice(indent.length)
    .trimEnd()
    .replace(INLINE_MARKUP, '\\$&')
    // Block syntax only counts at the start of a line: headings, list items, rules, setext underlines.
    .replace(/^([#+=-])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
  return ' '.repeat(indent.replace(/\t/g, '    ').length) + body;
}

/** Closes a code fence left open (e.g. by an answer cut short) so it cannot swallow what follows. */
function closeFences(markdown: string): string {
  let open: string | null = null;
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = null;
  }
  return open ? `${markdown}\n${open}` : markdown;
}

/** "**Label:** text" when the markdown opens with plain text, else the label on its own line above it. */
function labelled(label: string, markdown: string): string {
  const body = closeFences(markdown.trim());
  const opensWithBlock = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||<|\s{4})/.test(body);
  return opensWithBlock ? `**${label}:**\n\n${body}` : `**${label}:** ${body}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

/** The option the student picked: the recorded index, else the option whose text they sent. */
function chosenOption(question: QuizQuestion, answer: QuizAnswer | undefined): number | undefined {
  if (!answer) return undefined;
  if (answer.selectedOptionIndex !== undefined) return answer.selectedOptionIndex;
  const text = answer.answer.trim();
  const index = text ? (question.options ?? []).findIndex((option) => option.trim() === text) : -1;
  return index >= 0 ? index : undefined;
}

function resultLabel(answer: QuizAnswer, skipped: boolean): string {
  if (answer.correct) return '✓ Correct';
  if (skipped) return 'Skipped';
  return answer.score > 0 ? 'Partly right' : '✗ Incorrect';
}

function questionMarkdown(question: QuizQuestion, answer: QuizAnswer | undefined, number: number): string[] {
  const out = [`## Question ${number}`];
  const tags = [escapeInline(question.topic), question.difficulty, QUESTION_TYPE_LABELS[question.type]].filter(Boolean);
  out.push(`*${tags.join(' · ')}*`);
  out.push(closeFences(question.question.trim()));

  const isChoice = question.type !== 'short_answer' && (question.options?.length ?? 0) > 0;
  const chosen = chosenOption(question, answer);
  if (isChoice) {
    out.push(
      (question.options ?? [])
        .map((option, index) => {
          const marks = [index === question.correctOptionIndex ? '✓' : '', index === chosen ? '← *your answer*' : ''].filter(Boolean);
          return `- **${LETTERS[index] ?? index + 1}.** ${escapeInline(option)}${marks.length ? ` ${marks.join(' ')}` : ''}`;
        })
        .join('\n'),
    );
  }

  if (answer) {
    const skipped = isChoice ? chosen === undefined : !answer.answer.trim();
    if (!isChoice) out.push(labelled('Your answer', skipped ? '*(skipped)*' : plainTextToMarkdown(answer.answer)));
    out.push(`**Result:** ${resultLabel(answer, skipped)} · ${answer.score}/100`);
    if (answer.feedback.trim()) out.push(labelled('Feedback', answer.feedback));
  } else {
    out.push('*Not answered.*');
  }
  if (question.modelAnswer.trim()) out.push(labelled('Model answer', question.modelAnswer));
  if (question.explanation.trim()) out.push(labelled('Explanation', question.explanation));
  const notes = [
    question.sourceRef?.trim() ? `**Source:** ${escapeInline(question.sourceRef)}` : '',
    question.hint?.trim() ? `**Hint:** ${escapeInline(question.hint)}` : '',
  ].filter(Boolean);
  if (notes.length) out.push(notes.join('  \n'));
  return out;
}

/**
 * A quiz as a document: the title, the date and the score (once anything is answered), then every
 * question with its options (the correct one marked ✓, the student's pick marked), the student's
 * answer, the result and score, the feedback, the model answer, the explanation, the source and
 * the hint. The heading matches the export title "Quiz — <title>", so the exporters show it once.
 */
export function quizToMarkdown(quiz: Quiz, agentName: string): string {
  const total = quiz.questions.length;
  const out = [`# Quiz — ${escapeInline(quiz.title)}`];
  const meta = [formatDate(quiz.createdAt), plural(total, 'question'), `${quiz.config.difficulty} difficulty`, `written and graded by ${escapeInline(agentName)}`];
  out.push(meta.filter(Boolean).join(' · '));
  if (quiz.config.focus?.trim()) out.push(`**Focus:** ${escapeInline(quiz.config.focus)}`);

  const answers = quiz.answers.filter((answer) => quiz.questions.some((question) => question.id === answer.questionId));
  if (answers.length > 0) {
    const correct = answers.filter((answer) => answer.correct).length;
    const unanswered = total - answers.length;
    const score = `**Score: ${correct} of ${answers.length} correct (${Math.round((100 * correct) / answers.length)}%)**`;
    out.push(unanswered > 0 ? `${score} · ${unanswered} not answered` : score);
  }

  quiz.questions.forEach((question, index) => {
    const answer = answers.find((a) => a.questionId === question.id);
    out.push(...questionMarkdown(question, answer, index + 1));
  });
  return `${out.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * The chat as a document: a heading, then each message under "**You** · time" or
 * "**<agentName>** · time", with the date above the first message of each day. Empty messages are
 * left out. The heading matches the export title "<session> — chat with <agentName>".
 */
export function chatToMarkdown(messages: ChatMessage[], agentName: string, sessionTitle: string): string {
  const out = [`# ${escapeInline(sessionTitle)} — chat with ${escapeInline(agentName)}`];
  let day = '';
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    const date = formatDate(message.createdAt);
    if (date && date !== day) {
      out.push(`*${date}*`);
      day = date;
    }
    const time = formatTime(message.createdAt);
    out.push(`**${message.role === 'user' ? 'You' : escapeInline(agentName)}**${time ? ` · ${time}` : ''}`);
    // The app shows the student's messages verbatim and the tutor's as markdown; keep it that way.
    out.push(message.role === 'user' ? plainTextToMarkdown(content) : closeFences(content));
  }
  return `${out.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

export interface GuideDiagram {
  /** Mermaid source. */
  code: string;
  /** "Diagram N — caption", numbered in document order. */
  name: string;
}

/** Shortens a label for a file name: tags and line breaks out, at most about 80 characters. */
function tidyLabel(text: string): string {
  const clean = text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.:;,]+$/, '');
  if (clean.length <= 80) return clean;
  const cut = clean.slice(0, 80);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s.:;,–—-]+$/, '')}…`;
}

/** The italic line the guide puts after each diagram ("*Notice how …*"), without a "Figure 2:" prefix. */
function captionOf(node: RootContent | undefined): string {
  if (node?.type !== 'paragraph' || node.children[0]?.type !== 'emphasis') return '';
  return tidyLabel(mdastToPlainText(node).replace(/^(?:figure|fig\.|diagram|caption)\s*\d*\s*[:.–—-]\s*/i, ''));
}

/** A diagram's title, else its first quoted or bracketed label. */
function firstLabel(code: string): string {
  const source = code.replace(/^\s*%%.*$/gm, ''); // %%{init: …}%% directives and %% comments
  const title = /^\s*(?:pie\s+(?:showData\s+)?)?title\s*:?\s+(.+)$/im.exec(source)?.[1];
  const quoted = /"([^"\n]*[\p{L}\p{N}][^"\n]*)"/u.exec(source)?.[1];
  const bracketed = /[[({]+\s*([^[\](){}"\n]*[\p{L}\p{N}][^[\](){}"\n]*?)\s*[\])}]+/u.exec(source)?.[1];
  return tidyLabel(title ?? quoted ?? bracketed ?? '');
}

/**
 * The guide's mermaid diagrams in document order, each named "Diagram N — …" after the italic
 * caption that follows it (the guide prompt asks for one under every diagram), else after the
 * diagram's title or first label, else just "Diagram N".
 */
export function listDiagrams(markdown: string): GuideDiagram[] {
  const diagrams: GuideDiagram[] = [];
  const visit = (parent: Parent): void => {
    parent.children.forEach((node, index) => {
      if (node.type === 'code' && isMermaidCode(node)) {
        const number = diagrams.length + 1;
        const label = captionOf(parent.children[index + 1]) || firstLabel(node.value);
        diagrams.push({ code: node.value, name: label ? `Diagram ${number} — ${label}` : `Diagram ${number}` });
      } else if ('children' in node) {
        visit(node);
      }
    });
  };
  visit(parseMarkdown(markdown));
  return diagrams;
}
