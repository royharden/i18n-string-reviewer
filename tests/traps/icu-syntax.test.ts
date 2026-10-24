// PLAN §1.4 step 2 — broken brace, and a broken SOURCE string reported once.
import { describe, expect, it } from 'vitest';
import { checkSourceDocument, runAllChecks } from '../../src/core/l10nchecks/runChecks.ts';
import { checkAll, ruleIds, sourceDoc, targetDoc } from '../l10nchecks/helpers.ts';

describe('trap: ICU syntax', () => {
  it('broken brace in the target → icu_syntax_invalid only', () => {
    const f = checkAll('You have {count} new messages', 'Vous avez {count nouveaux messages', 'fr');
    expect(ruleIds(f)).toContain('icu_syntax_invalid');
    expect(ruleIds(f)).not.toContain('placeholder_mismatch');
  });

  it('a broken source string is one source issue, not N target errors', () => {
    const src = sourceDoc({ k: 'You have {count new messages' });
    const targets = [targetDoc({ k: 'Vous avez {count}' }, 'fr'), targetDoc({ k: 'У вас {count}' }, 'ru'), targetDoc({ k: '{count}件' }, 'ja')];
    const all = runAllChecks(src, targets);
    expect(all.source.filter((f) => f.ruleId === 'icu_syntax_invalid')).toHaveLength(1);
    expect(all.source[0]?.subject).toBe('source');
    for (const findings of all.byTarget.values()) expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(checkSourceDocument(src)).toHaveLength(1);
  });
});
