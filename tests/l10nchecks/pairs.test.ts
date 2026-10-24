import { describe, expect, it } from 'vitest';
import { alignDocuments } from '../../src/core/l10nchecks/pairs.ts';
import { sourceDoc, targetDoc } from './helpers.ts';

describe('i18next family alignment', () => {
  it('keeps a lone English _other key ordinary even when target siblings exist', () => {
    const source = sourceDoc({ label_other: 'Other {{count}}' }, 'i18next');
    const target = targetDoc({ label_one: 'Un', label_other: 'Autre {{count}}' }, 'fr', 'i18next');
    const aligned = alignDocuments(source, target);
    expect(aligned.families).toEqual([]);
    expect(aligned.pairs.map((p) => p.family)).toEqual([null]);
    expect(aligned.orphans.map((e) => e.path)).toEqual([['label_one']]);
    expect(alignDocuments(source, targetDoc({ label_one: 'Un' }, 'fr', 'i18next')).missing.map((e) => e.path)).toEqual([['label_other']]);
  });

  it('requires a string category sibling of the same base, parent and cardinal type', () => {
    const source = sourceDoc({
      nav: { label_other: 'Other', label_one: 1, label_ordinal_one: 'First', unrelated_one: 'One' },
      elsewhere: { label_one: 'One' },
    }, 'i18next');
    expect(alignDocuments(source, targetDoc({ nav: { label_other: 'Autre' } }, 'fr', 'i18next')).families).toEqual([]);
  });

  it('aligns a real English cardinal family with an other-only Japanese target', () => {
    const source = sourceDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'i18next');
    const aligned = alignDocuments(source, targetDoc({ items_other: '{{count}}件' }, 'ja', 'i18next'));
    expect(aligned.families).toHaveLength(1);
    expect(aligned.missing).toEqual([]);
    expect(aligned.orphans).toEqual([]);
    expect(aligned.pairs[0]?.family?.type).toBe('cardinal');
  });

  it('accepts an other-only Japanese source family, using its other for English siblings', () => {
    const source = sourceDoc({ items_other: '{{count}}件' }, 'i18next', 'ja');
    const aligned = alignDocuments(source, targetDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'en', 'i18next'));
    expect(aligned.families).toHaveLength(1);
    expect(aligned.pairs).toHaveLength(2);
    expect(aligned.pairs.every((p) => p.sourcePath[0] === 'items_other' && p.family?.type === 'cardinal')).toBe(true);
    expect(aligned.orphans).toEqual([]);
  });

  it('preserves explicit ordinal families even with only an ordinal_other source member', () => {
    const source = sourceDoc({ rank_ordinal_other: '{{count}}th' }, 'i18next');
    const aligned = alignDocuments(source, targetDoc({ rank_ordinal_one: '{{count}}er', rank_ordinal_other: '{{count}}e' }, 'fr', 'i18next'));
    expect(aligned.families).toHaveLength(1);
    expect(aligned.families[0]?.type).toBe('ordinal');
    expect(aligned.pairs).toHaveLength(2);
    expect(aligned.orphans).toEqual([]);
  });
});
