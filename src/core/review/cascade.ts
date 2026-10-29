// Composition only: the exact above-threshold subset reaches the injected LLM reviewer.
// Ordinary UI does not instantiate this experimental path; both paid stages need caller-owned
// budget/consent handling. Never reuse a whole-batch LLM preview for this smaller second stage.
import { createJevScreen } from './jev.ts';
import type { JevReviewerOptions } from './jev.ts';
import { parseUsage } from '../shared/wire.ts';
import type { Reviewer, ReviewUsage } from './types.ts';

export interface CascadeReviewerOptions {
  readonly jev: JevReviewerOptions;
  readonly llm: Reviewer;
}

function sumUsage(screen: ReviewUsage, llm?: ReviewUsage): ReviewUsage {
  if (!llm) throw new Error('missing_cascade_usage');
  const validated = parseUsage(llm);
  const inputTokens = screen.inputTokens + validated.inputTokens;
  const outputTokens = screen.outputTokens + validated.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) throw new Error('invalid_cascade_usage');
  return { inputTokens, outputTokens };
}

export function createCascadeReviewer(options: CascadeReviewerOptions): Reviewer {
  if (options.llm.id !== 'llm') throw new Error('cascade_requires_llm');
  const screen = createJevScreen(options.jev);
  return {
    id: 'cascade', label: 'Jev → LLM (experimental, unmeasured)',
    async review(batch, opts) {
      const result = await screen.screen(batch, opts);
      const flagged = new Set(result.flags.map((flag) => flag.item.itemId));
      const selected = batch.filter((item) => flagged.has(item.itemId));
      if (selected.length === 0) return { rawFindings: [], usage: result.usage };
      const explained = await options.llm.review(selected, opts);
      // The injected LLM is untrusted. The central pipeline validates against the original batch,
      // while this binding additionally prevents it from claiming an item the screen did not pass.
      const raw = Array.isArray(explained.rawFindings) ? explained.rawFindings
        : (explained.rawFindings as { findings?: unknown } | null)?.findings;
      if (!Array.isArray(raw)) return { rawFindings: explained.rawFindings, usage: sumUsage(result.usage, explained.usage) };
      const findings = raw.filter((finding: unknown) => {
        if (finding === null || typeof finding !== 'object') return true; // central schema/drop counts
        const itemId = (finding as { itemId?: unknown }).itemId;
        return typeof itemId !== 'string' || flagged.has(itemId);
      });
      return { rawFindings: findings, usage: sumUsage(result.usage, explained.usage) };
    },
  };
}
