import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/plural_category_extra.ts';
import { checkPair, runRule, sourceDoc, targetDoc } from '../helpers.ts';

const EN = '{n, plural, one {# file} other {# files}}';

describe('plural_category_extra', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('plural_category_extra');
    expect(rule.severity).toBe('warning');
  });

  it('flags a category the locale never selects (ja one)', () => {
    const f = checkPair(rule, EN, '{n, plural, one {# 件} other {# 件}}', 'ja');
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('one');
  });

  it('never treats =N as extra', () => {
    expect(checkPair(rule, EN, '{n, plural, =1 {一件} other {# 件}}', 'ja')).toEqual([]);
  });

  it('checks i18next families and allows _zero', () => {
    const src = sourceDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'i18next');
    expect(runRule(rule, src, targetDoc({ items_one: '{{count}}件', items_other: '{{count}}件' }, 'ja', 'i18next'))).toHaveLength(1);
    expect(runRule(rule, src, targetDoc({ items_zero: 'なし', items_other: '{{count}}件' }, 'ja', 'i18next'))).toEqual([]);
  });
});
