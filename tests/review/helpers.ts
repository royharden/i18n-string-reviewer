import { maskItem } from '../../src/core/maskgate/mask.ts';
import type { Dialect } from '../../src/core/l10nchecks/types.ts';
import type { ReviewItemRecord } from '../../src/core/review/pipeline.ts';
import type { ReviewTransport } from '../../src/core/review/llm.ts';
import { z } from 'zod';
import probabilityFixture from '../../fixtures/probabilities/jev.dev.json';

export const devProbabilityFixture = z.object({
  schemaVersion: z.literal(1), partition: z.literal('dev-only-synthetic'), provenance: z.string(),
  injectionTolerancePairs: z.array(z.object({ id: z.string(), what_bug_this_catches: z.string().min(1),
    baseline: z.record(z.string(), z.number().finite().min(0).max(1)),
    augmented: z.record(z.string(), z.number().finite().min(0).max(1)), withinProposedTolerance: z.boolean(),
  }).strict()),
  cases: z.array(z.object({ id: z.string(), what_bug_this_catches: z.string().min(1),
    items: z.array(z.object({ source: z.string(), target: z.string() }).strict()),
    probabilities: z.record(z.string(), z.number().finite().min(0).max(1)),
    flaggedIndices: z.array(z.number().int().nonnegative()),
  }).strict()),
}).strict().parse(probabilityFixture);

export function record(itemId: string, source: string, target: string, opts: { readonly locale?: string; readonly sourceLocale?: string; readonly dialect?: Dialect; readonly maxLength?: number } = {}): ReviewItemRecord {
  const locale = opts.locale ?? 'fr';
  const dialect = opts.dialect ?? 'plain';
  const key = [itemId];
  return { itemId, fileName: `${locale}.json`, key, locale, dialect, sourceText: source, targetText: target,
    ...(opts.maxLength !== undefined ? { maxLength: opts.maxLength } : {}),
    mask: maskItem({ itemId, path: key, locale, sourceLocale: opts.sourceLocale ?? 'en', dialect, source, target }) };
}

/** Synthetic transport only; callers must explicitly opt into unmeasured probes. */
export function probabilitiesTransport(probabilities: Readonly<Record<string, number>>): ReviewTransport {
  return async () => ({ reviewer: 'jev', probabilities, usage: { inputTokens: 11, outputTokens: 0 }, ledgerId: 'synthetic-dev-only' });
}

export function quietProbabilities(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count * 5 }, (_, i) => [`q${i}`, 0]));
}
