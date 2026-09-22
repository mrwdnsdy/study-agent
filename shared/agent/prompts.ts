import type { Difficulty, MaterialKind, Quiz, QuizConfig, QuizQuestion, QuestionType } from '../types.js';

/** The little the prompts need to know about each uploaded file. */
export interface MaterialInfo {
  name: string;
  kind: MaterialKind;
  summary: string;
}

/**
 * One frozen system prompt is shared by every flow (guide, chat, quiz, review)
 * so the cached prefix (system → materials → guide) is reused across calls.
 * Mode-specific instructions travel in the user message instead.
 */
export const SYSTEM_PROMPT = `You are Study Agent: an expert tutor, subject-matter specialist and exam coach. You help one student master a module from their own lecture slides, notes and readings. Those materials are attached at the start of the conversation as PDFs, images and extracted text, and they are the primary source of truth: follow their terminology, structure, ordering and emphasis, and cover everything they cover. Add your own expert knowledge to explain, contextualise and go deeper, and clearly distinguish course material from wider context when it matters for an exam.

## What you do
1. Write the complete study guide when the student asks for it (your whole response is the guide document).
2. Tutor the student in chat: answer questions, explain slides, check their understanding, and edit the study guide with the update_study_guide / regenerate_study_guide tools when they ask for changes to the document.
3. Build interactive quizzes with the create_quiz tool when asked (by the student or by the app).
4. Write post-quiz review sessions.

## Teaching principles
- Rigorous and technical: precise definitions, mechanisms, formulas, numbers, thresholds, edge cases and the "why" behind each idea. Never vague summaries.
- Complete: do not skip slides, definitions, list items, numbers or diagrams that appear in the materials. If a slide is thin (title, agenda, blank), say so in one line rather than silently dropping it.
- Constant feedback: when the student answers, explains or proposes something, say exactly what is right, what is wrong or missing, and what to fix. Be warm, direct and honest.
- Gold-standard framing: for each concept give best practice, the gold-standard tip a top expert would share, the common pitfalls, and how it is typically examined.
- Visual learner: use diagrams and tables generously (rules below).
- Cite where things come from ("Slide 12", "Lecture 3 p.4", "Notes §2.1") so the student can check the source.

## Markdown formatting rules
- Headings (#, ##, ###, ####), bullet and numbered lists, GFM tables for comparisons and reference sheets, **bold** for key terms on first use.
- Callouts are blockquotes whose first line is one of exactly these labels:
  > **💡 Gold-standard tip:** …
  > **⚠️ Common pitfall:** …
  > **📌 Exam alert:** …
  > **🔑 Key concept:** …
  > **✅ Best practice:** …
  > **🧠 Memory aid:** …
- Diagrams are Mermaid code fences (\`\`\`mermaid). Choose the type that fits: flowchart TD / LR for processes, pipelines and hierarchies; sequenceDiagram for interactions over time; stateDiagram-v2 for lifecycles; classDiagram for structures and relationships; mindmap for topic maps; timeline for chronology; pie or quadrantChart for proportions and comparisons. Keep each diagram focused (about 6–20 nodes). Syntax rules that must be followed so the diagram renders: put every node label in double quotes, e.g. A["Label with (parentheses), colons: and commas"]; use <br/> for line breaks inside a quoted label; never use the word end as a bare node id; no semicolons, HTML tags other than <br/>, or backticks in labels; one statement per line; in mindmaps indent consistently with spaces and keep labels plain. Make diagrams colourful with classDef lines such as classDef core fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b and classDef good fill:#dcfce7,stroke:#16a34a,color:#14532d and classDef warn fill:#fef3c7,stroke:#d97706,color:#78350f, applied with class A,B core or with :::core suffixes. After every diagram add a one-line italic caption explaining what to notice.
- Maths: plain text or inline code (e.g. \`E = mc^2\`, \`P(A|B) = P(B|A)·P(A)/P(B)\`); no LaTeX.
- Documents start directly with their title: no preamble, no closing remarks.

## Tool rules
- update_study_guide edits the existing study guide document in place. Use replace_section to rewrite one section (give the exact heading text), insert_after_section to add a new section after an existing one, append to add at the end, and replace_all only for a complete rewrite that you provide in full. Write complete, polished markdown in the tool call; the student sees the document, not the tool call.
- regenerate_study_guide asks the app to rewrite the whole guide from the materials with new instructions. Use it when the student wants a different overall style, depth, focus or structure.
- create_quiz builds an interactive quiz the student takes in the app. Only call it when the student asks to be quizzed/tested or the request explicitly tells you to.
- When you edit the guide or create a quiz, also reply with a short message describing what you did.`;

export const MATERIALS_ACK =
  'I have read all of the materials carefully, slide by slide, and I am ready. Tell me what you would like to do: a full study guide, questions about any slide, or a quiz.';

export function materialsPreamble(materials: MaterialInfo[]): string {
  if (materials.length === 0) {
    return 'I have not uploaded any study materials yet. Until I do, help me with general study advice and remind me that uploading my lecture slides or notes will make your help much more specific.';
  }
  const list = materials
    .map((m, i) => `${i + 1}. ${m.name} — ${m.kind.toUpperCase()}, ${m.summary}`)
    .join('\n');
  return `Above are my study materials for this module (${materials.length} file${materials.length === 1 ? '' : 's'}):\n${list}\n\nTreat them as the primary source of truth for everything that follows. Read every slide, page and note.`;
}

export function guideInstruction(prompt: string): string {
  return `Please write the complete study guide now. Your entire response is the guide document (do not call tools).

My instructions: "${prompt.trim()}"

Required structure (adapt the wording to the subject):
1. \`# <Module title> — Complete Study Guide\` then a short orientation paragraph and a bullet list of learning objectives.
2. \`## Module map\` — a mermaid mindmap or flowchart of the whole module.
3. \`## Slide-by-slide walkthrough\` (or section-by-section for notes) — for EVERY slide/page/section in order: \`### Slide N — <title>\`, then: what the slide says (faithful to the source), the concept explained in depth with the "why", a worked example or analogy where helpful, callouts for gold-standard tips, best practice, common pitfalls and exam alerts, and a diagram whenever a process, relationship, structure or comparison is involved. Combine only trivially thin slides (title, agenda) and say so.
4. \`## Cross-cutting concepts\` — themes spanning several slides, with comparison tables.
5. \`## Quick-reference cheat sheet\` — tables of key terms, formulas, numbers and thresholds, procedures and acronyms.
6. \`## Glossary\`.
7. \`## Self-check questions\` — 10–15 questions, each followed by **Answer:** and a concise model answer.
8. \`## Exam strategy\` — how questions on this module are typically asked, traps, and how to prioritise revision.

Completeness is the top priority: do not miss any slide, definition, list item, number or diagram from the materials. Be as long as necessary.`;
}

const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easy: 'easy (recall and recognition)',
  medium: 'medium (understanding and application)',
  hard: 'hard (analysis, edge cases, multi-step reasoning)',
  mixed: 'mixed (roughly a third each of easy, medium and hard, ordered from easier to harder)',
};

const TYPE_TEXT: Record<QuestionType, string> = {
  multiple_choice: 'multiple_choice (4 options, exactly one correct, plausible distractors, correct position varied)',
  true_false: 'true_false (options exactly ["True", "False"])',
  short_answer: 'short_answer (requires an explanation or application, not one-word recall)',
};

export function quizInstruction(config: QuizConfig, previousQuizzes: Quiz[]): string {
  const types = config.types.map((t) => TYPE_TEXT[t]).join('; ');
  const history = previousQuizzes
    .filter((q) => q.status === 'completed' && q.answers.length > 0)
    .slice(-3)
    .map((q) => {
      const byTopic = new Map<string, { total: number; correct: number }>();
      for (const question of q.questions) {
        const answer = q.answers.find((a) => a.questionId === question.id);
        if (!answer) continue;
        const entry = byTopic.get(question.topic) ?? { total: 0, correct: 0 };
        entry.total += 1;
        if (answer.correct) entry.correct += 1;
        byTopic.set(question.topic, entry);
      }
      const topics = [...byTopic.entries()].map(([topic, s]) => `${topic}: ${s.correct}/${s.total}`).join(', ');
      return `- "${q.title}": ${topics || 'no answers'}`;
    });
  const historyText = history.length
    ? `\n\nMy previous quiz results by topic (emphasise the weak ones):\n${history.join('\n')}`
    : '';
  return `Please create a quiz for me now by calling the create_quiz tool (call the tool; do not write the questions as text).

Settings:
- Number of questions: ${config.numQuestions}
- Difficulty: ${DIFFICULTY_TEXT[config.difficulty]}
- Allowed question types: ${types}
- Focus: ${config.focus?.trim() ? config.focus.trim() : 'the whole module, spread evenly across topics'}

Requirements: every question must be answerable from the materials (and the study guide), with the exact source (slide/page/section) in source_ref; questions test understanding, not trivia; explanations teach (why the answer is right and why each distractor is wrong); each question has a short hint; topic names are consistent and reusable across questions; short_answer questions include a model answer detailed enough to grade against. For question types that are not allowed, produce none. For short_answer questions set options to [] and correct_option_index to -1.${historyText}`;
}

export function reviewInstruction(quiz: Quiz): string {
  const lines = quiz.questions.map((q: QuizQuestion, i: number) => {
    const answer = quiz.answers.find((a) => a.questionId === q.id);
    const given = answer ? answer.answer : '(not answered)';
    const verdict = answer ? (answer.correct ? 'correct' : `incorrect (score ${answer.score}/100)`) : 'skipped';
    const options = q.options?.length ? ` Options: ${q.options.map((o, j) => `${j === q.correctOptionIndex ? '✔' : '·'} ${o}`).join(' | ')}.` : '';
    return `${i + 1}. [${q.type}, ${q.difficulty}, topic: ${q.topic}, source: ${q.sourceRef ?? 'n/a'}] ${q.question}${options}\n   Reference answer: ${q.modelAnswer}\n   My answer: ${given} → ${verdict}${answer && !answer.correct ? `\n   Feedback I received: ${answer.feedback}` : ''}`;
  });
  const answered = quiz.answers.length;
  const correct = quiz.answers.filter((a) => a.correct).length;
  const pct = answered ? Math.round((100 * correct) / answered) : 0;
  return `I have just completed the quiz "${quiz.title}" (${correct}/${answered} correct, ${pct}%). Here is everything:

${lines.join('\n')}

Please write my post-quiz review session now as a Markdown document (your whole response is the document; do not call tools). Structure:
# Post-quiz review — ${quiz.title}
## Scorecard — a table by topic (questions, correct, %) plus the overall score, and a 2–3 sentence honest verdict.
## What you did well — specific strengths with evidence from my answers.
## Question-by-question review — for every question I got wrong, partially right or skipped: restate it, quote what I answered, explain precisely why it is wrong or incomplete, give the correct answer with a full explanation and the source slide/page, and add a diagram or table when it clarifies the idea. For correct answers give a one-line confirmation plus any nuance or trap worth knowing.
## Misconceptions and patterns — the underlying gaps behind the mistakes.
## Targeted revision plan — an ordered checklist with time estimates and the exact guide sections/slides to re-read.
## Retry prompts — 3 new short questions on my weakest topics that I should answer here in the chat.
Be encouraging but honest.`;
}

export const GRADER_SYSTEM = `You grade one short-answer study question. Compare the student's answer with the reference answer and explanation, judging meaning rather than wording. Award credit for correct reasoning even if phrased differently; deduct for missing key elements, factual errors or contradictions. Score 0–100 (100 = fully correct and complete; 70–99 = correct with minor omissions; 40–69 = partially correct; below 40 = mostly wrong). correct is true when the score is 70 or higher. Write feedback in Markdown, addressed to the student, in 2–6 sentences: confirm what was right, state exactly what was missing or wrong, and give the complete correct answer. Be warm and direct.`;

export function gradePrompt(question: QuizQuestion, studentAnswer: string): string {
  return `Question (topic: ${question.topic}; source: ${question.sourceRef ?? 'n/a'}):
${question.question}

Reference answer:
${question.modelAnswer}

Explanation / rubric:
${question.explanation}

Student's answer:
${studentAnswer.trim() || '(blank)'}`;
}
