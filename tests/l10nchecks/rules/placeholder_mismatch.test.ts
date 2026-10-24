import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/placeholder_mismatch.ts';
import { checkPair, runRule, sourceDoc, targetDoc } from '../helpers.ts';

describe('placeholder_mismatch', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('placeholder_mismatch');
    expect(rule.severity).toBe('error');
  });

  describe('icu', () => {
    it('flags a renamed argument', () => {
      const f = checkPair(rule, '{name} posted', '{nombre} a publié', 'fr');
      expect(f).toHaveLength(1);
      expect(f[0]?.message).toContain('{name}');
    });

    it('flags a changed argument type', () => {
      expect(checkPair(rule, '{count, number} items', '{count} éléments', 'fr')).toHaveLength(1);
    });

    it('allows reordering and a dropped # in a plural branch', () => {
      expect(checkPair(rule, '{name} posted', 'Publié par {name}', 'fr')).toEqual([]);
      expect(checkPair(rule, '{n, plural, one {# file} other {# files}}', '{n, plural, one {un fichier} many {# de fichiers} other {# fichiers}}', 'fr')).toEqual([]);
    });

    it('skips keys whose source is broken (one source issue, not N target errors)', () => {
      expect(checkPair(rule, '{broken', '{nombre}', 'fr')).toEqual([]);
    });
  });

  describe('plain / i18next', () => {
    it('flags a dropped brace placeholder', () => {
      expect(checkPair(rule, 'Hello {name}', 'Bonjour', 'fr', { dialect: 'plain' })).toHaveLength(1);
    });

    it('allows indexed printf reordering', () => {
      expect(checkPair(rule, 'Uploaded %1$s of %2$s', '%2$s : %1$s envoyés', 'fr', { dialect: 'i18next' })).toEqual([]);
    });

    it('flags unindexed printf order/type changes', () => {
      const f = checkPair(rule, 'Edited by %s, %d times', '%d fois modifié par %s', 'fr', { dialect: 'i18next' });
      expect(f).toHaveLength(1);
      expect(f[0]?.message).toContain('order');
    });

    it('flags an unterminated interpolation', () => {
      expect(checkPair(rule, 'Hi {{name}}', 'Salut {{name', 'fr', { dialect: 'i18next' })[0]?.message).toContain('unterminated');
    });

    it('lets {{count}} come and go inside an i18next plural family', () => {
      const src = sourceDoc({ items_one: 'One item', items_other: '{{count}} items' }, 'i18next');
      const tgt = targetDoc({ items_one: '{{count}} élément', items_many: '{{count}} d’éléments', items_other: '{{count}} éléments' }, 'fr', 'i18next');
      expect(runRule(rule, src, tgt)).toEqual([]);
    });

    it('still flags other variables inside a family', () => {
      const src = sourceDoc({ items_one: '{{count}} item in {{list}}', items_other: '{{count}} items in {{list}}' }, 'i18next');
      const tgt = targetDoc({ items_one: '{{count}} élément', items_many: '{{count}} d’éléments dans {{list}}', items_other: '{{count}} éléments dans {{list}}' }, 'fr', 'i18next');
      expect(runRule(rule, src, tgt).map((f) => f.path)).toEqual([['items_one']]);
    });
  });
});
