// Experimental Noul screening. No provider or secret discovery: callers inject a budgeted transport.
// The default is disabled. Probe opt-in permits construction/dev evaluation, never quality claims.
import { z } from 'zod';
import thresholdDefaults from '../../../config/thresholds.json';
import type { RawModelFinding } from '../cited/finding.ts';
import { MAX_TEXT_FIELD } from '../cited/finding.ts';
import { safeCut } from '../context/pack.ts';
import { JEV_QUESTIONS } from '../shared/prompt.ts';
import { parseReviewRequest, parseReviewResponse } from '../shared/wire.ts';
import type { ReviewResponse } from '../shared/wire.ts';
import type { ReviewTransport } from './llm.ts';
import type { MaskedItem, Reviewer, ReviewOptions, ReviewUsage } from './types.ts';

export type JevQuestion = (typeof JEV_QUESTIONS)[number];
const probability = z.number().finite().min(0).max(1);
export const jevThresholdConfigSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  status: z.literal('provisional-unmeasured'),
  enabledLocales: z.array(z.string().min(1)).max(0),
  thresholds: z.object({ mistranslated: probability, omits_source_content: probability,
    adds_content_not_in_source: probability, wrong_sense_for_context: probability, wrong_register: probability }).strict(),
  devProbe: z.object({ pairsPerLocale: z.number().int().min(30), absoluteRecallFloor: probability,
    injectionToleranceMaxDelta: z.number().finite().min(0).lt(1), status: z.literal('provisional-unmeasured'), note: z.string().min(1) }).strict(),
  defaultInclusion: z.string().min(1),
}).strict();
export type JevThresholdConfig = z.infer<typeof jevThresholdConfigSchema>;
export const DEFAULT_JEV_THRESHOLDS: JevThresholdConfig = jevThresholdConfigSchema.parse(thresholdDefaults);

export interface JevReviewerOptions {
  readonly transport: ReviewTransport;
  readonly config?: unknown;
  /** Deliberate dev/construction opt-in only; never supplied by the ordinary UI. */
  readonly allowUnmeasuredProbe?: boolean;
  readonly requestForBatch?: (batch: readonly MaskedItem[], withContext: boolean) => { readonly requestId: string; readonly attempt: number };
  readonly onResponse?: (response: ReviewResponse) => void;
}
export interface JevFlag {
  readonly item: MaskedItem;
  readonly question: JevQuestion;
  readonly probability: number;
  readonly threshold: number;
}
export interface JevScreenResult {
  readonly flags: readonly JevFlag[];
  readonly usage: ReviewUsage;
}
export interface JevScreen {
  readonly configVersion: string;
  screen(batch: readonly MaskedItem[], opts?: ReviewOptions): Promise<JevScreenResult>;
}

/** Requires the exact complete question set for this batch, not merely plausible q<number> keys. */
export function validateJevProbabilities(value: Readonly<Record<string, number>>, itemCount: number): void {
  const count = itemCount * JEV_QUESTIONS.length;
  if (!Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > 20 || Object.keys(value).length !== count) throw new Error('invalid_jev_probabilities');
  for (let i = 0; i < count; i++) {
    const p = value[`q${i}`];
    if (!Object.hasOwn(value, `q${i}`) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('invalid_jev_probabilities');
  }
}

/** Dev-probe arithmetic only. Caller must supply actual paired, comparable model observations
 * to evaluate robustness; builder-authored probability fixtures establish no model property. */
export function compareInjectionProbeProbabilities(baseline: Readonly<Record<string, number>>, augmented: Readonly<Record<string, number>>, itemCount: number, proposedMaxDelta: number): { readonly maxDelta: number; readonly withinProposedTolerance: boolean } {
  if (!Number.isFinite(proposedMaxDelta) || proposedMaxDelta < 0 || proposedMaxDelta >= 1) throw new Error('invalid_injection_tolerance');
  validateJevProbabilities(baseline, itemCount);
  validateJevProbabilities(augmented, itemCount);
  let maxDelta = 0;
  for (let i = 0; i < itemCount * JEV_QUESTIONS.length; i++) maxDelta = Math.max(maxDelta, Math.abs(baseline[`q${i}`]! - augmented[`q${i}`]!));
  return { maxDelta, withinProposedTolerance: maxDelta <= proposedMaxDelta };
}

export function createJevScreen(options: JevReviewerOptions): JevScreen {
  const config = jevThresholdConfigSchema.parse(options.config ?? thresholdDefaults);
  return {
    configVersion: config.version,
    async screen(batch, opts = {}) {
      if (options.allowUnmeasuredProbe !== true) throw new Error('jev_unmeasured_disabled');
      const withContext = opts.withContext ?? true;
      const identity = options.requestForBatch?.(batch, withContext) ?? { requestId: crypto.randomUUID(), attempt: 1 };
      const request = parseReviewRequest({ ...identity, schemaVersion: 1, reviewer: 'jev', withContext, items: batch });
      if (new Set(request.items.map((item) => item.itemId)).size !== request.items.length) throw new Error('duplicate_jev_item');
      const response = parseReviewResponse(await options.transport(request));
      if (response.reviewer !== 'jev') throw new Error('invalid_review_response');
      validateJevProbabilities(response.probabilities, batch.length);
      options.onResponse?.(response);
      const flags: JevFlag[] = [];
      batch.forEach((item, index) => JEV_QUESTIONS.forEach((question, dimension) => {
        const p = response.probabilities[`q${index * JEV_QUESTIONS.length + dimension}`]!;
        const threshold = config.thresholds[question];
        if (p > threshold) flags.push({ item, question, probability: p, threshold });
      }));
      return { flags, usage: response.usage };
    },
  };
}

const CATEGORY: Readonly<Record<JevQuestion, RawModelFinding['category']>> = {
  mistranslated: 'accuracy', omits_source_content: 'accuracy', adds_content_not_in_source: 'accuracy',
  wrong_sense_for_context: 'context_mismatch', wrong_register: 'style',
};

export function createJevReviewer(options: JevReviewerOptions): Reviewer {
  const screen = createJevScreen(options);
  return {
    id: 'jev', label: 'Jev (experimental, unmeasured screen; no fixes)',
    async review(batch, opts) {
      const result = await screen.screen(batch, opts);
      // One finding per item/category; keep all triggered dimensions in the explanation.
      const groups = new Map<string, JevFlag[]>();
      for (const flag of result.flags) {
        const key = JSON.stringify([flag.item.itemId, CATEGORY[flag.question]]);
        const group = groups.get(key) ?? [];
        group.push(flag); groups.set(key, group);
      }
      const findings: RawModelFinding[] = [...groups.values()].map((group) => {
        const first = group[0]!;
        return { itemId: first.item.itemId, key: [...first.item.key], locale: first.item.locale,
          category: CATEGORY[first.question], severity: 'minor', evidence: safeCut(first.item.target, MAX_TEXT_FIELD),
          explanation: `Experimental Jev screen (${screen.configVersion}; unmeasured): ${group.map((flag) => `${flag.question}=${flag.probability.toFixed(3)} > ${flag.threshold}`).join(', ')}. Probability flags require human review; no fix is generated.` };
      });
      return { rawFindings: findings, usage: result.usage };
    },
  };
}
