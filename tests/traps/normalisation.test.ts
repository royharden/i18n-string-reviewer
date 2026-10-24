// PLAN §1.4 step 2 — number formatting and non-breaking-space traps.
import { describe, expect, it } from 'vitest';
import { checkAll, ruleIds } from '../l10nchecks/helpers.ts';

describe('trap: numbers', () => {
  it('1,000 vs 1 000 (fr, NNBSP) / 1.000 (de) / 1 000 (ru, NBSP) → no number_drift', () => {
    expect(ruleIds(checkAll('Up to 1,000 tasks', 'Jusqu’à 1\u202F000 tâches', 'fr'))).not.toContain('number_drift');
    expect(ruleIds(checkAll('Up to 1,000 tasks', 'Bis zu 1.000 Aufgaben', 'de'))).not.toContain('number_drift');
    expect(ruleIds(checkAll('Up to 1,000 tasks', 'До 1\u00A0000 задач', 'ru'))).not.toContain('number_drift');
  });

  it('a changed value still drifts', () => {
    expect(ruleIds(checkAll('Up to 1,000 tasks', 'Jusqu’à 100 tâches', 'fr'))).toContain('number_drift');
  });
});

describe('trap: non-breaking spaces', () => {
  it('&nbsp; vs U+00A0 → no whitespace_drift', () => {
    expect(ruleIds(checkAll('Due:&nbsp;', 'Échéance :\u00A0', 'fr'))).not.toContain('whitespace_drift');
    expect(ruleIds(checkAll('&nbsp;Due', '\u00A0Échéance', 'fr'))).not.toContain('whitespace_drift');
  });
});
