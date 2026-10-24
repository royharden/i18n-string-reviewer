// Set-based scoring. Scenario identity prevents two isolated mutations/semantic labels on the
// same string from collapsing together. Within a scenario the unit is (key, locale, rule/category).
import type { Severity } from '../l10nchecks/types.ts';
import type { Split } from './split.ts';
import { wilson95 } from './wilson.ts';
import type { WilsonInterval } from './wilson.ts';

export interface EvaluationScenario {
  readonly id: string;
  readonly corpus: string;
  readonly split: Split;
  readonly kind: 'planted' | 'control' | 'clean';
}

export interface ScoringUnit {
  readonly scenarioId: string;
  readonly corpus: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly label: string;
}

export interface Rate {
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly interval95: WilsonInterval | null;
}

export interface ScoreRow {
  readonly label: string;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly pendingAdjudication: number;
  readonly precision: Rate;
  readonly recall: Rate;
  readonly f1: number | null;
}

export interface ScoringFailure extends ScoringUnit {
  readonly kind: 'false_positive' | 'miss' | 'adjudication';
  readonly reason: string;
}

export interface ScoreResult {
  readonly task: 'structural' | 'semantic';
  readonly split: Split;
  readonly rows: readonly ScoreRow[];
  readonly failures: readonly ScoringFailure[];
  readonly adjudication: readonly ScoringFailure[];
}

export interface ScoreInput {
  readonly scenarios: readonly EvaluationScenario[];
  readonly truth: readonly ScoringUnit[];
  readonly predictions: readonly ScoringUnit[];
  readonly labels: readonly string[];
  readonly task: 'structural' | 'semantic';
  readonly split: Split;
}

export function binomialRate(numerator: number, denominator: number): Rate {
  const interval95 = wilson95(numerator, denominator);
  return { value: denominator === 0 ? null : numerator / denominator, numerator, denominator, interval95 };
}

/** JSON array encoding preserves literal dotted keys, empty segments, and __proto__. */
export function scoringUnitId(unit: ScoringUnit): string {
  return JSON.stringify([unit.scenarioId, unit.corpus, unit.key, unit.locale, unit.label]);
}

function validateUnit(unit: ScoringUnit): void {
  if (!unit.scenarioId || !unit.corpus || !unit.locale || !unit.label || !Array.isArray(unit.key) || unit.key.length === 0 || unit.key.some((s) => typeof s !== 'string')) {
    throw new TypeError('metrics: a scoring unit needs scenario, corpus, path segments, locale and label');
  }
}

function compareUnits(a: ScoringUnit, b: ScoringUnit): number {
  const x = scoringUnitId(a);
  const y = scoringUnitId(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Structural truth comes from the declared mutation operator, never detector output.
 * Unplanted semantic findings on dev planted strings await adjudication. Explicit controls
 * and clean strings are already negative truth in both splits. Held-out extras always count FP.
 */
export function scoreUnits(input: ScoreInput): ScoreResult {
  const scenarios = new Map<string, EvaluationScenario>();
  for (const scenario of input.scenarios) {
    if (!scenario.id || !scenario.corpus || scenarios.has(scenario.id)) throw new TypeError('metrics: scenario ids must be nonempty and unique');
    if (!['dev', 'heldout'].includes(scenario.split) || !['planted', 'control', 'clean'].includes(scenario.kind)) throw new TypeError('metrics: invalid scenario');
    scenarios.set(scenario.id, scenario);
  }
  if (new Set(input.labels).size !== input.labels.length || input.labels.some((label) => !label)) throw new TypeError('metrics: labels must be nonempty and unique');
  const labels = new Set(input.labels);
  const collect = (units: readonly ScoringUnit[], isTruth: boolean): Map<string, ScoringUnit> => {
    const out = new Map<string, ScoringUnit>();
    for (const unit of units) {
      validateUnit(unit);
      const scenario = scenarios.get(unit.scenarioId);
      if (!scenario || scenario.corpus !== unit.corpus) throw new TypeError('metrics: unit has an unknown scenario or mismatched corpus');
      if (!labels.has(unit.label)) throw new TypeError(`metrics: undeclared label ${unit.label}`);
      if (isTruth && scenario.kind !== 'planted') throw new TypeError('metrics: negative controls cannot carry positive truth');
      if (scenario.split === input.split) out.set(scoringUnitId(unit), unit);
    }
    return out;
  };
  const truth = collect(input.truth, true);
  const predictions = collect(input.predictions, false);
  const counts = new Map(input.labels.map((label): [string, { tp: number; fp: number; fn: number; pendingAdjudication: number }] => [label, { tp: 0, fp: 0, fn: 0, pendingAdjudication: 0 }]));
  const failures: ScoringFailure[] = [];
  const adjudication: ScoringFailure[] = [];
  for (const [id, unit] of truth) {
    const count = counts.get(unit.label)!;
    if (predictions.has(id)) count.tp++;
    else {
      count.fn++;
      failures.push({ ...unit, kind: 'miss', reason: 'Expected rule/category was not reported for this string.' });
    }
  }
  for (const [id, unit] of predictions) {
    if (truth.has(id)) continue;
    const count = counts.get(unit.label)!;
    const scenario = scenarios.get(unit.scenarioId)!;
    if (input.task === 'semantic' && input.split === 'dev' && scenario.kind === 'planted') {
      count.pendingAdjudication++;
      adjudication.push({ ...unit, kind: 'adjudication', reason: 'Unplanted dev semantic finding; unresolved, excluded from precision pending adjudication.' });
    } else {
      count.fp++;
      failures.push({ ...unit, kind: 'false_positive', reason: scenario.kind === 'planted' ? 'Finding is absent from the planted truth for this scenario.' : 'Finding on an explicit clean string or negative control.' });
    }
  }
  const rows = input.labels.map((label): ScoreRow => {
    const count = counts.get(label)!;
    const denominator = 2 * count.tp + count.fp + count.fn;
    return {
      label, ...count,
      precision: binomialRate(count.tp, count.tp + count.fp),
      recall: binomialRate(count.tp, count.tp + count.fn),
      f1: denominator === 0 ? null : (2 * count.tp) / denominator,
    };
  });
  failures.sort(compareUnits);
  adjudication.sort(compareUnits);
  return { task: input.task, split: input.split, rows, failures, adjudication };
}

export interface CleanFpResult {
  readonly stringCount: number;
  readonly error: { readonly count: number; readonly per1000: number | null };
  readonly warning: { readonly count: number; readonly per1000: number | null };
}

export function cleanFalsePositives(input: { readonly findings: readonly (ScoringUnit & { readonly severity: Severity })[]; readonly stringCount: number }): CleanFpResult {
  if (!Number.isSafeInteger(input.stringCount) || input.stringCount < 0) throw new RangeError('metrics: clean string count must be a nonnegative safe integer');
  const errors = new Set<string>();
  const warnings = new Set<string>();
  for (const finding of input.findings) {
    validateUnit(finding);
    if (finding.severity !== 'error' && finding.severity !== 'warning') throw new TypeError('metrics: unknown severity');
    (finding.severity === 'error' ? errors : warnings).add(scoringUnitId(finding));
  }
  if (input.stringCount === 0 && (errors.size > 0 || warnings.size > 0)) throw new RangeError('metrics: clean findings require a nonzero string denominator');
  const rate = (count: number): { count: number; per1000: number | null } => ({ count, per1000: input.stringCount === 0 ? null : (count * 1000) / input.stringCount });
  return { stringCount: input.stringCount, error: rate(errors.size), warning: rate(warnings.size) };
}

export interface ContextPair {
  readonly scenarioId: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly category: string;
  readonly contextDependent: boolean;
  readonly offDetected: boolean;
  readonly onDetected: boolean;
}

export interface ContextAblationResult {
  readonly pairCount: number;
  readonly contextDependentPairs: number;
  readonly both: number;
  readonly offOnly: number;
  readonly onOnly: number;
  readonly neither: number;
  readonly offRecall: Rate;
  readonly onRecall: Rate;
  readonly delta: number | null;
}

/** Matched planted-string outcomes, never a comparison of unrelated aggregate samples. */
export function contextAblation(pairs: readonly ContextPair[]): ContextAblationResult {
  let both = 0, offOnly = 0, onOnly = 0, neither = 0, contextDependentPairs = 0;
  const seen = new Set<string>();
  for (const pair of pairs) {
    const id = JSON.stringify([pair.scenarioId, pair.key, pair.locale, pair.category]);
    if (seen.has(id)) throw new TypeError('metrics: duplicate matched context pair');
    seen.add(id);
    if (pair.contextDependent) contextDependentPairs++;
    if (pair.offDetected && pair.onDetected) both++;
    else if (pair.offDetected) offOnly++;
    else if (pair.onDetected) onOnly++;
    else neither++;
  }
  const offRecall = binomialRate(both + offOnly, pairs.length);
  const onRecall = binomialRate(both + onOnly, pairs.length);
  return { pairCount: pairs.length, contextDependentPairs, both, offOnly, onOnly, neither, offRecall, onRecall, delta: pairs.length === 0 ? null : (onOnly - offOnly) / pairs.length };
}
