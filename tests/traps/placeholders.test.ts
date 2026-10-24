// PLAN §1.4 step 2 — placeholder traps, through the full runChecks pass.
import { describe, expect, it } from 'vitest';
import { checkAll, errorsOf, ruleIds } from '../l10nchecks/helpers.ts';

describe('trap: placeholders', () => {
  it('{name} → {nombre} (fr, ICU) is placeholder_mismatch', () => {
    expect(ruleIds(checkAll('{name} posted a comment', '{nombre} a publié un commentaire', 'fr'))).toContain('placeholder_mismatch');
  });

  it('%2$s … %1$s reorder is not a finding', () => {
    const f = checkAll('Uploaded %1$s of %2$s files', '%2$s fichiers : %1$s envoyés', 'fr', { dialect: 'i18next' });
    expect(ruleIds(f)).not.toContain('placeholder_mismatch');
    expect(errorsOf(f)).toEqual([]);
  });

  it('unindexed %s %d → %d %s is placeholder_mismatch', () => {
    const f = checkAll('Edited by %s, %d times', '%d fois, modifié par %s', 'fr', { dialect: 'plain' });
    expect(ruleIds(f)).toContain('placeholder_mismatch');
  });

  it("French d'{count} (ICU apostrophe quoting) is placeholder_mismatch", () => {
    // `'{` starts an ICU quoted literal, so the argument silently disappears (D3: parser behaviour).
    const f = checkAll('Out of {count}', "Plus d'{count}", 'fr');
    expect(ruleIds(f)).toContain('placeholder_mismatch');
    expect(ruleIds(f)).not.toContain('icu_syntax_invalid');
  });
});
