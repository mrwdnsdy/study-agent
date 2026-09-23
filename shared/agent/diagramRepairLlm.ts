/**
 * Last-resort fixer for diagrams that neither parse nor survive the rule-based
 * repair (mermaidRepair.ts): a single request asks the grading model to
 * correct all of them at once, following the same rules as the guide prompt.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AgentContext } from './core.js';
import { contentText, extractJsonObject } from './llm.js';
import { MERMAID_RULES } from './prompts.js';

const DiagramFixes = z.object({
  diagrams: z.array(z.object({ index: z.number().int(), code: z.string() })),
});

export const DIAGRAM_FIXER_SYSTEM = `You are an expert in Mermaid 12 diagram syntax. You receive Mermaid diagrams that fail to parse, each with the parser's error. Correct each one so that it parses: keep its diagram type, its meaning and its labels, and change only what the syntax needs. Return the corrected Mermaid code only: no code fences, no caption and no commentary.

Follow these rules:
${MERMAID_RULES}`;

export interface BrokenDiagram {
  code: string;
  error: string;
}

function fixerPrompt(items: readonly BrokenDiagram[]): string {
  const diagrams = items
    .map((item, index) => `<diagram index="${index}">\n<error>${item.error}</error>\n<code>\n${item.code}\n</code>\n</diagram>`)
    .join('\n\n');
  return `Fix these ${items.length} Mermaid diagram${items.length === 1 ? '' : 's'}. Reply with only a JSON object {"diagrams": [{"index": <the diagram's index>, "code": "<the corrected Mermaid code>"}]} with one entry per diagram.\n\n${diagrams}`;
}

/** The model's corrections by index; null when the reply is not the requested JSON. */
function parseFixes(text: string): Map<number, string> | null {
  // Structured output is plain JSON; try it whole first, since fences inside a code value would confuse extraction.
  for (const candidate of [text.trim(), extractJsonObject(text)]) {
    if (!candidate) continue;
    try {
      const result = DiagramFixes.safeParse(JSON.parse(candidate));
      if (!result.success) continue;
      const fixes = new Map<number, string>();
      for (const { index, code } of result.data.diagrams) if (!fixes.has(index)) fixes.set(index, code);
      return fixes;
    } catch {
      // Not JSON: try the next candidate.
    }
  }
  return null;
}

/** Models sometimes wrap the code in a fence despite being asked not to. */
function unfence(code: string): string {
  return code
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:`{3,}|~{3,})[^\n]*\n/, '')
    .replace(/\n[ \t]*(?:`{3,}|~{3,})\s*$/, '')
    .trim();
}

/**
 * Ask the grading model to correct broken diagrams, in one request. Returns
 * one entry per item: the corrected code, or null when the model gave none.
 * Throws only when the request itself fails; the caller validates the codes.
 */
export async function repairDiagramsWithModel(
  ctx: AgentContext,
  items: readonly BrokenDiagram[],
  signal?: AbortSignal,
): Promise<(string | null)[]> {
  if (items.length === 0) return [];
  const schema = z.toJSONSchema(DiagramFixes) as Record<string, unknown>;
  delete schema.$schema;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: fixerPrompt(items) }];
  const response = await ctx.llm.stream(
    {
      model: ctx.models.grading,
      system: DIAGRAM_FIXER_SYSTEM,
      messages,
      maxTokens: 8000,
      effort: 'medium',
      outputSchema: { name: 'diagrams', schema },
    },
    {},
    signal,
  );
  const fixes = response.stop_reason === 'refusal' ? null : parseFixes(contentText(response.content));
  return items.map((_, index) => {
    const code = fixes?.get(index);
    return code && unfence(code) ? unfence(code) : null;
  });
}
