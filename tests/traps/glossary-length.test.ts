// PLAN §1.4 step 2 — identical brand / OK strings and the length ratio.
import { describe, expect, it } from 'vitest';
import { runChecks } from '../../src/core/l10nchecks/runChecks.ts';
import type { GlossaryEntry } from '../../src/core/l10nchecks/types.ts';
import { checkAll, ruleIds, sourceDoc, targetDoc } from '../l10nchecks/helpers.ts';

const glossary: GlossaryEntry[] = [
  { term: 'TaskBoard', doNotTranslate: true },
  { term: 'OK', doNotTranslate: true },
];

describe('trap: identical strings', () => {
  it('brand and OK identical → no untranslated_identical (glossary doNotTranslate)', () => {
    const f = runChecks(sourceDoc({ brand: 'TaskBoard', ok: 'OK' }), targetDoc({ brand: 'TaskBoard', ok: 'OK' }, 'fr'), { glossary });
    expect(ruleIds(f)).not.toContain('untranslated_identical');
    expect(ruleIds(f)).not.toContain('glossary_violation');
  });

  it('an ordinary identical string is still flagged', () => {
    expect(ruleIds(checkAll('Settings', 'Settings', 'fr', { options: { glossary } }))).toContain('untranslated_identical');
  });
});

describe('trap: length', () => {
  it('1.4× growth → no length_risk; 3× → length_risk', () => {
    expect(ruleIds(checkAll('Save changes', 'Sauver changements'.slice(0, 16), 'fr'))).not.toContain('length_risk'); // 12 → 16 (1.33×)
    expect(ruleIds(checkAll('abcdefghij', 'abcdefghijklmn', 'fr'))).not.toContain('length_risk'); // 1.4×
    expect(ruleIds(checkAll('abcdefghij', 'x'.repeat(30), 'fr'))).toContain('length_risk'); // 3×
  });
});
