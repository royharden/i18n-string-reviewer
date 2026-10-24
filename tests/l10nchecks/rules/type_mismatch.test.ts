import { describe, expect, it } from 'vitest';
import { rule as missingKey } from '../../../src/core/l10nchecks/rules/missing_key.ts';
import { rule as orphanKey } from '../../../src/core/l10nchecks/rules/orphan_key.ts';
import { rule } from '../../../src/core/l10nchecks/rules/type_mismatch.ts';
import { runRule, sourceDoc, targetDoc } from '../helpers.ts';

describe('type_mismatch', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('type_mismatch');
    expect(rule.severity).toBe('error');
  });

  it('flags non-string target leaves', () => {
    const src = sourceDoc({ n: 'Count', arr: 'List', nil: 'None', b: 'Yes' });
    const f = runRule(rule, src, targetDoc({ n: 5, arr: ['a'], nil: null, b: true }, 'fr'));
    expect(f).toHaveLength(4);
    expect(f.find((x) => x.path[0] === 'n')?.message).toContain('number');
    expect(f.find((x) => x.path[0] === 'arr')?.message).toContain('array');
  });

  it('flags an object where the source has a string, once, without missing/orphan noise', () => {
    const src = sourceDoc({ a: 'A' });
    const tgt = targetDoc({ a: { b: 'x', c: 'y' } }, 'fr');
    expect(runRule(rule, src, tgt).map((x) => x.path)).toEqual([['a']]);
    expect(runRule(missingKey, src, tgt)).toEqual([]);
    expect(runRule(orphanKey, src, tgt)).toEqual([]);
  });

  it('flags a string where the source has an object', () => {
    const src = sourceDoc({ a: { b: 'B', c: 'C' } });
    const tgt = targetDoc({ a: 'flat' }, 'fr');
    expect(runRule(rule, src, tgt).map((x) => x.path)).toEqual([['a']]);
    expect(runRule(missingKey, src, tgt)).toEqual([]);
    expect(runRule(orphanKey, src, tgt)).toEqual([]);
  });

  it('does not flag string/string pairs', () => {
    expect(runRule(rule, sourceDoc({ a: 'A' }), targetDoc({ a: 'B' }, 'fr'))).toEqual([]);
  });
});
