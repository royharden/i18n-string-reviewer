import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/plural_category_missing.ts';
import { checkPair, runRule, sourceDoc, targetDoc } from '../helpers.ts';

const EN = '{n, plural, one {# file} other {# files}}';

describe('plural_category_missing', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('plural_category_missing');
    expect(rule.severity).toBe('error');
  });

  it('flags a category the target locale needs (ru few)', () => {
    const f = checkPair(rule, EN, '{n, plural, one {# файл} many {# файлов} other {# файла}}', 'ru');
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('few');
  });

  it('does not flag a complete branch set', () => {
    expect(checkPair(rule, EN, '{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}', 'ru')).toEqual([]);
    expect(checkPair(rule, EN, '{n, plural, other {# 件}}', 'ja')).toEqual([]);
  });

  it('requires other even with exact branches', () => {
    expect(checkPair(rule, EN, '{n, plural, =0 {なし}}', 'ja')[0]?.message).toContain('other');
  });

  it('checks nested plurals', () => {
    const src = '{g, select, other {{n, plural, one {#} other {#}}}}';
    expect(checkPair(rule, src, '{g, select, other {{n, plural, one {#} many {#} other {#}}}}', 'ru')).toHaveLength(1);
  });

  it('checks selectordinal against ordinal categories', () => {
    const src = '{p, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect(checkPair(rule, src, '{p, selectordinal, one {#er} other {#e}}', 'fr')).toEqual([]);
    expect(checkPair(rule, src, '{p, selectordinal, other {#e}}', 'fr')).toHaveLength(1);
  });

  it('checks i18next plural families', () => {
    const src = sourceDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'i18next');
    const f = runRule(rule, src, targetDoc({ items_one: '{{count}} элемент', items_other: '{{count}} элемента' }, 'ru', 'i18next'));
    expect(f).toHaveLength(1);
    expect(f[0]?.path).toEqual(['items_other']);
    expect(f[0]?.message).toContain('_few');
    expect(f[0]?.message).toContain('_many');
  });
});
