// Reviewer contracts (PLAN §3.9).
//
// A Reviewer sees ONLY masked items (≤ 20 per batch) and returns its raw reply. Validation against the
// producing batch (cited/finding.ts), the fix gate (maskgate/gate.ts) and the invariant check happen
// in review/pipeline.ts `reviewBatch`, which is the plan's `review(batch) → {findings, dropped, gate}`
// seen from the caller. Keeping validation out of the reviewer means a hostile or buggy reviewer
// cannot skip it.

import type { DropReason, Finding, FindingCategory } from '../cited/finding.ts';
import type { GateReason, GateStats } from '../maskgate/gate.ts';
import type { MaskedItem } from '../maskgate/mask.ts';

export type { LegendEntry, MaskedItem } from '../maskgate/mask.ts';

export const MAX_BATCH_SIZE = 20;

export type ReviewerId = 'mock' | 'heuristic' | 'llm' | 'jev' | 'cascade';

export interface ReviewOptions {
  /** Mock only: 0 = recorded replies, ≥ 1 = the recorded "regenerated" alternatives. */
  readonly variant?: number;
  /** llm: include the context pack (context-on) or not (context-off). */
  readonly withContext?: boolean;
}

export interface ReviewUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReviewerReply {
  /** Untrusted: an array of raw findings, or `{findings: [...]}`. Validated by the pipeline. */
  readonly rawFindings: unknown;
  readonly usage?: ReviewUsage;
}

export interface Reviewer {
  readonly id: ReviewerId;
  /** Human label for the UI. */
  readonly label: string;
  review(batch: readonly MaskedItem[], opts?: ReviewOptions): Promise<ReviewerReply>;
}

/** A proposed fix the gate refused, for the "Gate rejections" panel. */
export interface GateRejection {
  readonly itemId: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly category: FindingCategory;
  readonly reviewer: string;
  readonly findingId: string;
  /** The proposal exactly as the reviewer sent it (masked; never contains a secret). */
  readonly proposal: string;
  readonly reasons: readonly GateReason[];
}

export interface BatchReviewResult {
  readonly findings: readonly Finding[];
  readonly dropped: number;
  readonly dropReasons: Readonly<Record<DropReason, number>>;
  readonly rejections: readonly GateRejection[];
  readonly gate: GateStats;
  readonly usage?: ReviewUsage;
}
