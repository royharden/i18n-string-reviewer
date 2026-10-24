// Finding schema and code validation (PLAN §3.5) — a TypeScript port of the `cited` idea: every
// model claim must cite evidence that exists, exactly once, in the string it is about.
//
// validateModelFindings(raw, batch):
//   - drops (and counts) items whose itemId is not in THE BATCH THAT PRODUCED THEM, or whose key or
//     locale disagree with that batch item (a model cannot redirect a finding to another string);
//   - evidence (masked) must be a substring of the masked target at a unique offset, and, restored,
//     a substring of the original target at a unique offset; otherwise `unsupported`;
//   - evidence touching a ⟦Rn⟧ token (whole or partial) → `unsupported`;
//   - an `unsupported` finding never carries an approvable fix (its proposal is discarded).
// Proposals of supported findings are returned masked; the pipeline runs them through the gate.

import { z } from 'zod';
import type { DeterministicFinding, RuleId } from '../l10nchecks/types.ts';
import type { MaskedItem, RestoreMap } from '../maskgate/mask.ts';
import { scanTokens, unmask } from '../maskgate/mask.ts';
import { findingIdFor } from '../rulings/fingerprint.ts';

export const FINDING_CATEGORIES = ['accuracy', 'fluency', 'terminology', 'style', 'context_mismatch'] as const;
export const FINDING_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const MAX_TEXT_FIELD = 4000;

export const findingSchema = z
  .object({
    id: z.string().min(1),
    key: z.array(z.string()).min(1),
    locale: z.string().min(1),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    explanation: z.string(),
    /** Static: the rule's evidence text. Model: restored evidence when supported, the raw masked claim otherwise. */
    evidence: z.string(),
    evidenceStatus: z.enum(['supported', 'unsupported']),
    /** Offset of `evidence` in the original target (UTF-16), when it occurs there exactly once. */
    evidenceOffset: z.number().int().nonnegative().optional(),
    /** Unmasked, gate-accepted fix text. Only present when the gate accepted the proposal. */
    suggestedFix: z.string().optional(),
    /** The same fix in the target's token space, kept so export can re-run the gate. */
    suggestedFixMasked: z.string().optional(),
    suggestionHash: z.string().optional(),
    source: z.enum(['static', 'model']),
    reviewer: z.string().min(1),
    itemId: z.string().min(1),
    /** Deterministic findings: the rule id (also the fingerprint's rule/category field). */
    ruleId: z.string().optional(),
    /** Deterministic findings: error / warning (sorting and the "errors first" view). */
    level: z.enum(['error', 'warning']).optional(),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

/** What a reviewer returns for one finding (masked text). Unknown fields are stripped. */
export const rawModelFindingSchema = z.object({
  itemId: z.string().min(1).max(200),
  key: z.array(z.string().max(2000)).min(1).max(64),
  locale: z.string().min(1).max(64),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  explanation: z.string().max(MAX_TEXT_FIELD),
  evidence: z.string().max(MAX_TEXT_FIELD),
  suggestedFix: z.string().max(MAX_TEXT_FIELD).optional(),
});

export type RawModelFinding = z.infer<typeof rawModelFindingSchema>;

/** One item of the batch that was sent to the reviewer, with what only the browser knows. */
export interface BatchItem {
  readonly masked: MaskedItem;
  /** Target restore map (maskItem). */
  readonly restore: RestoreMap;
  /** Original (unmasked) key path. */
  readonly key: readonly string[];
  readonly sourceText: string;
  readonly targetText: string;
}

export type DropReason = 'malformed_reply' | 'schema' | 'not_in_batch' | 'key_mismatch' | 'locale_mismatch';

export interface ValidatedFinding {
  readonly finding: Finding;
  /** Masked proposal of a SUPPORTED finding, still to be gated. */
  readonly proposalMasked?: string;
  readonly item: BatchItem;
}

export interface ModelValidation {
  readonly findings: readonly ValidatedFinding[];
  readonly dropped: number;
  readonly dropReasons: Readonly<Record<DropReason, number>>;
}

export interface EvidenceCheck {
  readonly status: 'supported' | 'unsupported';
  /** Restored evidence when supported; the claim as given otherwise. */
  readonly evidence: string;
  readonly offset?: number;
  readonly why?: 'empty' | 'secret' | 'not_in_masked_target' | 'ambiguous_masked' | 'unmask_failed' | 'not_in_target' | 'ambiguous_target';
}

/** Index of the single occurrence of `needle` in `hay`, -1 when absent, -2 when it occurs more than once. */
export function uniqueIndexOf(hay: string, needle: string): number {
  const i = hay.indexOf(needle);
  if (i === -1) return -1;
  return hay.indexOf(needle, i + 1) === -1 ? i : -2;
}

export function checkEvidence(evidenceMasked: string, maskedTarget: string, restore: RestoreMap, originalTarget: string): EvidenceCheck {
  const no = (why: NonNullable<EvidenceCheck['why']>): EvidenceCheck => ({ status: 'unsupported', evidence: evidenceMasked, why });
  if (evidenceMasked.trim().length === 0) return no('empty');
  if (scanTokens(evidenceMasked).tokens.some((t) => t.kind === 'R')) return no('secret');
  const i = uniqueIndexOf(maskedTarget, evidenceMasked);
  if (i === -1) return no('not_in_masked_target');
  if (i === -2) return no('ambiguous_masked');
  if (scanTokens(maskedTarget).tokens.some((t) => t.kind === 'R' && i < t.end && t.start < i + evidenceMasked.length)) return no('secret');
  // Partial tokens ("R1⟧", "⟦P") are stray delimiters: unmask fails, so they are unsupported too.
  const um = unmask(evidenceMasked, restore);
  if (!um.ok) return no('unmask_failed');
  const j = uniqueIndexOf(originalTarget, um.text);
  if (j === -1) return no('not_in_target');
  if (j === -2) return no('ambiguous_target');
  return { status: 'supported', evidence: um.text, offset: j };
}

function emptyDrops(): Record<DropReason, number> {
  return { malformed_reply: 0, schema: 0, not_in_batch: 0, key_mismatch: 0, locale_mismatch: 0 };
}

const sameKey = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/** Validate a reviewer's raw reply against the batch that produced it. */
export async function validateModelFindings(raw: unknown, batch: readonly BatchItem[], reviewer: string, source: Finding['source'] = 'model'): Promise<ModelValidation> {
  const dropReasons = emptyDrops();
  const list: unknown = Array.isArray(raw) ? raw : (raw as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) {
    dropReasons.malformed_reply++;
    return { findings: [], dropped: 1, dropReasons };
  }
  const byId = new Map<string, BatchItem>();
  for (const item of batch) byId.set(item.masked.itemId, item);
  const out: ValidatedFinding[] = [];
  for (const entry of list) {
    const parsed = rawModelFindingSchema.safeParse(entry);
    if (!parsed.success) {
      dropReasons.schema++;
      continue;
    }
    const f = parsed.data;
    const item = byId.get(f.itemId);
    if (!item) {
      dropReasons.not_in_batch++;
      continue;
    }
    if (!sameKey(f.key, item.masked.key)) {
      dropReasons.key_mismatch++;
      continue;
    }
    if (f.locale !== item.masked.locale) {
      dropReasons.locale_mismatch++;
      continue;
    }
    const ev = checkEvidence(f.evidence, item.masked.target, item.restore, item.targetText);
    const id = await findingIdFor({ key: item.key, locale: item.masked.locale, source: item.sourceText, target: item.targetText, ruleOrCategory: f.category });
    const finding: Finding = {
      id,
      key: [...item.key],
      locale: item.masked.locale,
      category: f.category,
      severity: f.severity,
      explanation: f.explanation,
      evidence: ev.evidence,
      evidenceStatus: ev.status,
      ...(ev.offset !== undefined ? { evidenceOffset: ev.offset } : {}),
      source,
      reviewer,
      itemId: item.masked.itemId,
    };
    const proposal = ev.status === 'supported' && f.suggestedFix !== undefined ? f.suggestedFix : undefined;
    out.push(proposal !== undefined ? { finding, proposalMasked: proposal, item } : { finding, item });
  }
  const dropped = Object.values(dropReasons).reduce((a, b) => a + b, 0);
  return { findings: out, dropped, dropReasons };
}

// --- deterministic findings in the same shape ---

const CATEGORY_OF_RULE: Readonly<Record<RuleId, FindingCategory>> = {
  missing_key: 'accuracy',
  empty_translation: 'accuracy',
  type_mismatch: 'accuracy',
  placeholder_mismatch: 'accuracy',
  icu_syntax_invalid: 'accuracy',
  plural_category_missing: 'accuracy',
  select_branch_mismatch: 'accuracy',
  html_tag_mismatch: 'accuracy',
  orphan_key: 'style',
  untranslated_identical: 'accuracy',
  plural_category_extra: 'fluency',
  number_drift: 'accuracy',
  length_risk: 'fluency',
  whitespace_drift: 'fluency',
  bidi_control_chars: 'fluency',
  glossary_violation: 'terminology',
  injection_like_text: 'style',
};

export function categoryOfRule(ruleId: RuleId): FindingCategory {
  return CATEGORY_OF_RULE[ruleId];
}

export interface StaticFindingContext {
  readonly itemId: string;
  readonly sourceText: string;
  readonly targetText: string;
}

/** Convert one deterministic finding. Static findings are authoritative: always `supported`. */
export async function staticFinding(df: DeterministicFinding, ctx: StaticFindingContext): Promise<Finding> {
  const id = await findingIdFor({ key: df.path, locale: df.locale, source: ctx.sourceText, target: ctx.targetText, ruleOrCategory: df.ruleId });
  const evidence = df.evidence ?? '';
  const offset = evidence.length > 0 ? uniqueIndexOf(ctx.targetText, evidence) : -1;
  return {
    id,
    key: [...df.path],
    locale: df.locale,
    category: categoryOfRule(df.ruleId),
    severity: df.severity === 'error' ? 'major' : 'minor',
    explanation: df.message,
    evidence,
    evidenceStatus: 'supported',
    ...(offset >= 0 ? { evidenceOffset: offset } : {}),
    source: 'static',
    reviewer: 'l10nchecks',
    itemId: ctx.itemId,
    ruleId: df.ruleId,
    level: df.severity,
  };
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { critical: 0, major: 1, minor: 2 };

/** Errors first: deterministic errors, then model findings by severity, then warnings; stable within. */
export function findingRank(f: Finding): number {
  if (f.source === 'static') return f.level === 'error' ? 0 : 3;
  return f.severity === 'minor' ? 2 : 1;
}

export function sortFindingsForReview(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const r = findingRank(a) - findingRank(b);
    if (r !== 0) return r;
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
    const ka = JSON.stringify(a.key);
    const kb = JSON.stringify(b.key);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ca = a.ruleId ?? a.category;
    const cb = b.ruleId ?? b.category;
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
}
