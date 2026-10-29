import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/orphan_key.ts';
import { runRule, sourceDoc, targetDoc } from '../helpers.ts';

describe('orphan_key', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('orphan_key');
    expect(rule.severity).toBe('warning');
  });

  it('flags a target key the source does not have', () => {
    const f = runRule(rule, sourceDoc({ a: 'A' }), targetDoc({ a: 'x', old: { b: 'y' } }, 'fr'));
    expect(f.map((x) => x.path)).toEqual([['old', 'b']]);
  });

  it('does not flag extra plural forms of a source family', () => {
    const src = sourceDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'i18next');
    const tgt = targetDoc({ items_one: 'a', items_few: 'b', items_many: 'c', items_other: 'd' }, 'ru', 'i18next');
    expect(runRule(rule, src, tgt)).toEqual([]);
  });

  it('does not flag matching keys', () => {
    expect(runRule(rule, sourceDoc({ a: 'A' }), targetDoc({ a: 'x' }, 'fr'))).toEqual([]);
  });
});
