import { describe, expect, it } from 'vitest';
import { cleanFalsePositives, contextAblation, scoreUnits } from '../../src/core/evalkit/metrics.ts';
import type { EvaluationScenario, ScoringUnit } from '../../src/core/evalkit/metrics.ts';

const scenario = (id: string, kind: EvaluationScenario['kind'] = 'planted', split: EvaluationScenario['split'] = 'dev'): EvaluationScenario => ({ id, kind, split, corpus: 'synthetic-test' });
const unit = (scenarioId: string, label: string, key: readonly string[] = ['a'], locale = 'fr'): ScoringUnit => ({ scenarioId, corpus: 'synthetic-test', key, locale, label });

describe('evaluation scoring units', () => {
  it('scores rule/key/locale/scenario independently and deduplicates repeated findings', () => {
    // what_bug_this_catches: key-only scoring can count a wrong rule or another mutation as a hit.
    const scenarios = [scenario('first'), scenario('second')];
    const truth = [unit('first', 'missing_key'), unit('second', 'missing_key')];
    const prediction = unit('first', 'missing_key');
    const result = scoreUnits({ scenarios, truth, predictions: [prediction, prediction, unit('first', 'empty_translation'), unit('second', 'missing_key', ['a'], 'ja')], labels: ['missing_key', 'empty_translation'], task: 'structural', split: 'dev' });
    expect(result.rows[0]).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: { numerator: 1, denominator: 2 }, recall: { numerator: 1, denominator: 2 }, f1: 0.5 });
    expect(result.rows[1]).toMatchObject({ tp: 0, fp: 1, fn: 0 });
    expect(result.failures.filter((failure) => failure.kind === 'miss')).toHaveLength(1);
    expect(result.failures.filter((failure) => failure.kind === 'false_positive')).toHaveLength(2);
  });

  it('does not conflate dotted literal keys, nested keys or prototype-looking segments', () => {
    // what_bug_this_catches: dot-joining path arrays silently turns a wrong-key result into a TP.
    const result = scoreUnits({ scenarios: [scenario('paths')], truth: [unit('paths', 'rule', ['a.b']), unit('paths', 'rule', ['__proto__'])], predictions: [unit('paths', 'rule', ['a', 'b']), unit('paths', 'rule', ['__proto__'])], labels: ['rule'], task: 'structural', split: 'dev' });
    expect(result.rows[0]).toMatchObject({ tp: 1, fp: 1, fn: 1 });
  });

  it('separates unresolved dev extras from explicit negative controls and held-out FP', () => {
    // what_bug_this_catches: treating every dev extra as adjudication hides false alarms on clean strings.
    const scenarios = [scenario('planted'), scenario('clean', 'clean'), scenario('control', 'control'), scenario('heldout', 'planted', 'heldout')];
    const predictions = scenarios.map((item) => unit(item.id, 'fluency'));
    const dev = scoreUnits({ scenarios, truth: [], predictions, labels: ['fluency'], task: 'semantic', split: 'dev' });
    expect(dev.rows[0]).toMatchObject({ fp: 2, pendingAdjudication: 1 });
    expect(dev.adjudication[0]?.scenarioId).toBe('planted');
    const heldout = scoreUnits({ scenarios, truth: [], predictions, labels: ['fluency'], task: 'semantic', split: 'heldout' });
    expect(heldout.rows[0]).toMatchObject({ fp: 1, pendingAdjudication: 0 });
    expect(heldout.adjudication).toEqual([]);
  });

  it('keeps structural extras as FP even on dev and scores wrong semantic categories as misses', () => {
    const structural = scoreUnits({ scenarios: [scenario('s')], truth: [], predictions: [unit('s', 'rule')], labels: ['rule'], task: 'structural', split: 'dev' });
    expect(structural.rows[0]?.fp).toBe(1);
    const semantic = scoreUnits({ scenarios: [scenario('h', 'planted', 'heldout')], truth: [unit('h', 'accuracy')], predictions: [unit('h', 'style')], labels: ['accuracy', 'style'], task: 'semantic', split: 'heldout' });
    expect(semantic.rows[0]).toMatchObject({ tp: 0, fn: 1 });
    expect(semantic.rows[1]).toMatchObject({ tp: 0, fp: 1 });
  });

  it('reports zero denominators as null while a real miss remains zero recall', () => {
    const empty = scoreUnits({ scenarios: [], truth: [], predictions: [], labels: ['rule'], task: 'structural', split: 'dev' }).rows[0];
    expect(empty).toMatchObject({ precision: { value: null, denominator: 0, interval95: null }, recall: { value: null, denominator: 0, interval95: null }, f1: null });
    const missed = scoreUnits({ scenarios: [scenario('s')], truth: [unit('s', 'rule')], predictions: [], labels: ['rule'], task: 'structural', split: 'dev' }).rows[0];
    expect(missed).toMatchObject({ precision: { value: null }, recall: { value: 0, denominator: 1 }, f1: 0 });
  });

  it('rejects missing identities, wrong corpus, undeclared labels and truth on controls', () => {
    const base = { scenarios: [scenario('s', 'control')], truth: [], predictions: [] as ScoringUnit[], labels: ['rule'], task: 'structural' as const, split: 'dev' as const };
    expect(() => scoreUnits({ ...base, predictions: [unit('absent', 'rule')] })).toThrow();
    expect(() => scoreUnits({ ...base, predictions: [{ ...unit('s', 'rule'), corpus: 'wrong' }] })).toThrow();
    expect(() => scoreUnits({ ...base, predictions: [unit('s', 'undeclared')] })).toThrow();
    expect(() => scoreUnits({ ...base, truth: [unit('s', 'rule')] })).toThrow();
    expect(() => scoreUnits({ ...base, scenarios: [scenario('s'), scenario('s')] })).toThrow();
  });
});

describe('clean-set and context metrics', () => {
  it('uses reviewed strings as denominator and counts errors/warnings separately', () => {
    // what_bug_this_catches: denominator=number of findings can make a noisy clean set appear excellent.
    const error = { ...unit('clean', 'missing_key'), severity: 'error' as const };
    const warning = { ...unit('clean', 'length_risk'), severity: 'warning' as const };
    expect(cleanFalsePositives({ findings: [error, error, warning], stringCount: 4 })).toEqual({ stringCount: 4, error: { count: 1, per1000: 250 }, warning: { count: 1, per1000: 250 } });
    expect(cleanFalsePositives({ findings: [], stringCount: 0 }).error.per1000).toBeNull();
    expect(() => cleanFalsePositives({ findings: [error], stringCount: 0 })).toThrow();
  });

  it('uses matched pairs, preserving both directional disagreements and empty N/A', () => {
    const pair = { key: ['a'], locale: 'fr', category: 'accuracy', contextDependent: true };
    const result = contextAblation([
      { ...pair, scenarioId: 'both', offDetected: true, onDetected: true },
      { ...pair, scenarioId: 'off', offDetected: true, onDetected: false },
      { ...pair, scenarioId: 'on', offDetected: false, onDetected: true },
      { ...pair, scenarioId: 'neither', offDetected: false, onDetected: false },
    ]);
    expect(result).toMatchObject({ pairCount: 4, both: 1, offOnly: 1, onOnly: 1, neither: 1, delta: 0 });
    expect(result.offRecall.denominator).toBe(4);
    expect(contextAblation([])).toMatchObject({ pairCount: 0, delta: null, offRecall: { value: null } });
    const duplicate = { ...pair, scenarioId: 'same', offDetected: false, onDetected: false };
    expect(() => contextAblation([duplicate, duplicate])).toThrow();
  });
});
