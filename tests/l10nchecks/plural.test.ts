// Plural data comes from the runtime's CLDR (D5). Expectations below are CLDR 38+.
import { describe, expect, it } from 'vitest';
import { checkPluralBranches, parsePluralSuffix, pluralCategories } from '../../src/core/l10nchecks/plural.ts';

describe('pluralCategories', () => {
  it('returns cardinal categories in canonical order', () => {
    expect(pluralCategories('en', 'cardinal')).toEqual(['one', 'other']);
    expect(pluralCategories('ru', 'cardinal')).toEqual(['one', 'few', 'many', 'other']);
    expect(pluralCategories('ar', 'cardinal')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    expect(pluralCategories('ja', 'cardinal')).toEqual(['other']);
    expect(pluralCategories('fr', 'cardinal')).toEqual(['one', 'many', 'other']);
  });

  it('returns ordinal categories', () => {
    expect(pluralCategories('en', 'ordinal')).toEqual(['one', 'two', 'few', 'other']);
    expect(pluralCategories('fr', 'ordinal')).toEqual(['one', 'other']);
    expect(pluralCategories('ja', 'ordinal')).toEqual(['other']);
  });
});

describe('checkPluralBranches', () => {
  it('reports categories the locale needs', () => {
    expect(checkPluralBranches(['one', 'other'], 'ru', 'cardinal')).toEqual({ missing: ['few', 'many'], extra: [] });
  });

  it('never lets =N satisfy a category and always requires other', () => {
    expect(checkPluralBranches(['=0', 'one'], 'en', 'cardinal').missing).toEqual(['other']);
    expect(checkPluralBranches(['=0', '=1'], 'ja', 'cardinal').missing).toEqual(['other']);
  });

  it('reports categories the locale never selects; =N is never extra', () => {
    expect(checkPluralBranches(['=1', 'one', 'other'], 'ja', 'cardinal')).toEqual({ missing: [], extra: ['one'] });
  });

  it('allows i18next _zero everywhere when asked', () => {
    expect(checkPluralBranches(['zero', 'other'], 'ja', 'cardinal', { allowZero: true }).extra).toEqual([]);
    expect(checkPluralBranches(['zero', 'other'], 'ja', 'cardinal').extra).toEqual(['zero']);
  });
});

describe('parsePluralSuffix', () => {
  it('splits i18next v4 suffixes', () => {
    expect(parsePluralSuffix('items_one')).toEqual({ base: 'items', type: 'cardinal', category: 'one' });
    expect(parsePluralSuffix('rank_ordinal_few')).toEqual({ base: 'rank', type: 'ordinal', category: 'few' });
    expect(parsePluralSuffix('a_b_other')).toEqual({ base: 'a_b', type: 'cardinal', category: 'other' });
    expect(parsePluralSuffix('button')).toBeNull();
    expect(parsePluralSuffix('_other')).toBeNull();
  });
});
