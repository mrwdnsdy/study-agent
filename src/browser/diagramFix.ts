/**
 * Fixes a finished document's diagrams before it is saved, so the stored guide
 * and every later export hold diagrams that render. Each mermaid block is kept
 * when it parses, else replaced by its rule-based repair, else sent to the
 * model together with the other broken ones in a single request.
 */
import { listMermaidBlocks, repairMarkdownDiagrams, repairMermaid } from '../../shared/agent/mermaidRepair';

export interface BrokenDiagram {
  code: string;
  error: string;
}

export interface FixDiagramsOptions {
  /** Corrects broken diagrams in one request (see repairDiagramsWithModel); one result per item, null when it could not. */
  repairWithModel?: (items: BrokenDiagram[]) => Promise<(string | null)[]>;
  /** The parser's error for a diagram, or null when it is valid. Defaults to mermaidError from src/lib/mermaid. */
  validate?: (code: string) => Promise<string | null>;
  /** Status line text shown while the model works. */
  onStatus?: (text: string) => void;
  /** Most diagrams sent to the model (default 8); the rest stay as they are. */
  max?: number;
}

export interface FixDiagramsResult {
  markdown: string;
  /** Diagram blocks replaced by a version that parses. */
  fixed: number;
  /** Diagram blocks that are still broken. */
  failed: number;
}

const DEFAULT_MAX = 8;

// Lazy, so importing this module (and its tests) does not load mermaid.
async function defaultValidate(code: string): Promise<string | null> {
  const { mermaidError } = await import('../lib/mermaid');
  return mermaidError(code);
}

/** The parser's error, null when valid, or undefined when validation itself failed. */
async function errorOf(validate: (code: string) => Promise<string | null>, code: string): Promise<string | null | undefined> {
  try {
    return await validate(code);
  } catch {
    return undefined;
  }
}

/** Repairs the diagrams in `markdown`. Never throws: on any failure it keeps the fixes that worked. */
export async function fixDiagramsInMarkdown(markdown: string, opts: FixDiagramsOptions = {}): Promise<FixDiagramsResult> {
  const validate = opts.validate ?? defaultValidate;
  const max = Math.max(0, Math.floor(opts.max ?? DEFAULT_MAX));
  /** Broken source → a version that parses. Identical diagrams share one entry. */
  const replacements = new Map<string, string>();
  const broken = new Map<string, string>();

  try {
    for (const { code } of listMermaidBlocks(markdown)) {
      if (replacements.has(code) || broken.has(code)) continue;
      const error = await errorOf(validate, code);
      // Valid, or impossible to check: leave the block as written.
      if (error === null || error === undefined) continue;
      const repaired = repairMermaid(code);
      if (repaired !== code && (await errorOf(validate, repaired)) === null) replacements.set(code, repaired);
      else broken.set(code, error);
    }

    const batch = [...broken].slice(0, max).map(([code, error]) => ({ code, error }));
    if (batch.length > 0 && opts.repairWithModel) {
      opts.onStatus?.(`Tidying up ${batch.length} diagram${batch.length === 1 ? '' : 's'}…`);
      try {
        const results = await opts.repairWithModel(batch.map((item) => ({ ...item })));
        for (const [index, item] of batch.entries()) {
          const candidate = results[index];
          if (typeof candidate !== 'string' || !candidate.trim()) continue;
          // The model's code gets the same rule-based second chance as the original.
          for (const option of [candidate, repairMermaid(candidate)]) {
            if ((await errorOf(validate, option)) === null) {
              replacements.set(item.code, option);
              break;
            }
          }
        }
      } catch {
        // The model is optional polish: keep the local fixes.
      }
    }
  } catch {
    // Unexpected failure while checking: apply whatever was fixed so far.
  }

  let fixed = 0;
  let failed = 0;
  try {
    const output = repairMarkdownDiagrams(markdown, (code) => {
      const next = replacements.get(code);
      if (next !== undefined) {
        fixed++;
        return next;
      }
      if (broken.has(code)) failed++;
      return null;
    });
    return { markdown: output, fixed, failed };
  } catch {
    return { markdown, fixed: 0, failed: broken.size };
  }
}
