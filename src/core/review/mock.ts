// Mock reviewer (PLAN §3.9): replays recorded replies from fixtures/replies/*.json. Pure — the caller
// reads the files (Vite `?raw` imports in the browser, node:fs in scripts/tests) and passes the
// parsed JSON in. No network, no keys.
//
// Reply files:
//   { schemaVersion: 1, set: "demo-icu" | "demo-i18next" | "synthetic", description?, replies: [Reply] }
//   Reply = { id, locale, key: string[], note?, item?, findings: [ReplyFinding], regenerate?: [ReplyFinding] }
//   ReplyFinding = { category, severity, explanation, evidence (masked), suggestedFix? (masked),
//                    misdirect?: {itemId?, key?, locale?}, expect?: {...} }
// A reply WITHOUT `item` is bound to the demo string with that locale + key and is served by the mock
// reviewer. A reply WITH `item` is self-contained (source, target, dialect, …): used only by the
// gate/invariant tests, never served. `expect` documents what the gate and evidence check must do;
// the mock never sends it to the pipeline. `misdirect` makes the mock claim another item/key/locale
// (hostile: the finding must be dropped as not belonging to the batch).

import { z } from 'zod';
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from '../cited/finding.ts';
import { GATE_REASONS } from '../maskgate/gate.ts';
import type { MaskedItem } from '../maskgate/mask.ts';
import type { Reviewer, ReviewerReply, ReviewOptions } from './types.ts';

export const replyExpectSchema = z
  .object({
    /** The finding is dropped by batch validation (wrong item/key/locale). */
    dropped: z.boolean().optional(),
    evidence: z.enum(['supported', 'unsupported']).optional(),
    /** accepted / rejected by the gate, or not_gated (no proposal, or unsupported evidence). */
    gate: z.enum(['accepted', 'rejected', 'not_gated']).optional(),
    /** Reasons that MUST be among the gate's reasons (others may also appear). */
    reasons: z.array(z.enum(GATE_REASONS)).optional(),
    /** Accepted fixes: the exact unmasked text. */
    text: z.string().optional(),
  })
  .strict();

export const replyFindingSchema = z
  .object({
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    explanation: z.string(),
    evidence: z.string(),
    suggestedFix: z.string().optional(),
    misdirect: z
      .object({ itemId: z.string().optional(), key: z.array(z.string()).min(1).optional(), locale: z.string().optional() })
      .strict()
      .optional(),
    expect: replyExpectSchema.optional(),
  })
  .strict();

export const syntheticItemSchema = z
  .object({
    sourceLocale: z.string(),
    dialect: z.enum(['icu', 'i18next', 'plain']),
    source: z.string(),
    target: z.string(),
    maxLength: z.number().int().positive().optional(),
  })
  .strict();

export const replySchema = z
  .object({
    id: z.string().min(1),
    locale: z.string().min(1),
    key: z.array(z.string()).min(1),
    note: z.string().optional(),
    item: syntheticItemSchema.optional(),
    findings: z.array(replyFindingSchema),
    regenerate: z.array(replyFindingSchema).optional(),
  })
  .strict();

export const replyFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    set: z.string().min(1),
    description: z.string().optional(),
    replies: z.array(replySchema),
  })
  .strict();

export type ReplyFinding = z.infer<typeof replyFindingSchema>;
export type Reply = z.infer<typeof replySchema>;
export type ReplyFile = z.infer<typeof replyFileSchema>;

/** Parse one reply file's JSON value; throws with the file name and zod issues on failure. */
export function parseReplyFile(value: unknown, fileName: string): ReplyFile {
  const parsed = replyFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${fileName}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

function bindKey(locale: string, key: readonly string[]): string {
  return `${locale}\u0000${JSON.stringify(key)}`;
}

export interface MockReviewerOptions {
  /** Only replies from files of this set are served (e.g. "demo-icu"). Default: every non-synthetic file. */
  readonly set?: string;
}

/** A Reviewer that answers from recorded replies, matched by locale + (masked) key. */
export function createMockReviewer(files: readonly ReplyFile[], opts: MockReviewerOptions = {}): Reviewer {
  const index = new Map<string, Reply>();
  for (const file of files) {
    if (opts.set !== undefined ? file.set !== opts.set : file.set === 'synthetic') continue;
    for (const reply of file.replies) {
      if (reply.item !== undefined) continue;
      index.set(bindKey(reply.locale, reply.key), reply);
    }
  }
  return {
    id: 'mock',
    label: 'Mock (recorded replies)',
    review(batch: readonly MaskedItem[], reviewOpts: ReviewOptions = {}): Promise<ReviewerReply> {
      const out: Array<Record<string, unknown>> = [];
      for (const item of batch) {
        const reply = index.get(bindKey(item.locale, item.key));
        if (!reply) continue;
        const variant = reviewOpts.variant ?? 0;
        const list = variant > 0 && reply.regenerate !== undefined ? reply.regenerate : reply.findings;
        for (const f of list) {
          const raw: Record<string, unknown> = {
            itemId: f.misdirect?.itemId ?? item.itemId,
            key: f.misdirect?.key ?? [...item.key],
            locale: f.misdirect?.locale ?? item.locale,
            category: f.category,
            severity: f.severity,
            explanation: f.explanation,
            evidence: f.evidence,
          };
          if (f.suggestedFix !== undefined) raw['suggestedFix'] = f.suggestedFix;
          out.push(raw);
        }
      }
      return Promise.resolve({ rawFindings: out, usage: { inputTokens: 0, outputTokens: 0 } });
    },
  };
}
