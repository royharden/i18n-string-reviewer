import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/number_drift.ts';
import { checkPair, runRule, sourceDoc, targetDoc } from '../helpers.ts';

describe('number_drift', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('number_drift');
    expect(rule.severity).toBe('warning');
  });

  it('flags a changed number', () => {
    const f = checkPair(rule, 'Keep 5 files', 'Garder 6 fichiers', 'fr');
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toContain('6');
  });

  it('accepts locale formatting of the same value', () => {
    expect(checkPair(rule, 'Up to 1,000 users', 'Jusqu’à 1\u202F000 utilisateurs', 'fr')).toEqual([]);
    expect(checkPair(rule, 'Up to 1,000 users', 'Bis zu 1.000 Nutzer', 'de')).toEqual([]);
    expect(checkPair(rule, 'Up to 1,000 users', 'حتى ١٬٠٠٠ مستخدم', 'ar')).toEqual([]);
    expect(checkPair(rule, 'Up to 1.5 GB', 'Jusqu’à 1,5 Go', 'fr')).toEqual([]);
  });

  it('ignores digits inside placeholders and ICU syntax', () => {
    expect(checkPair(rule, '{n, plural, =0 {None} one {# file} other {# files}}', '{n, plural, =0 {Aucun} one {# fichier} many {# de fichiers} other {# fichiers}}', 'fr')).toEqual([]);
    expect(checkPair(rule, 'File %1$s of %2$s', 'Fichier %1$s sur %2$s', 'fr', { dialect: 'plain' })).toEqual([]);
  });

  it('compares sets for plural/select messages', () => {
    expect(checkPair(rule, 'Top {n, plural, one {10 item} other {10 items}}', 'Топ {n, plural, one {10 элемент} few {10 элемента} many {10 элементов} other {10 элемента}}', 'ru')).toEqual([]);
  });

  it('only flags numbers absent from every source form in an i18next family', () => {
    const src = sourceDoc({ items_one: '1 item', items_other: '{{count}} items' }, 'i18next');
    expect(runRule(rule, src, targetDoc({ items_one: '{{count}} élément', items_many: 'x', items_other: '{{count}} éléments' }, 'fr', 'i18next'))).toEqual([]);
    expect(runRule(rule, src, targetDoc({ items_one: '2 éléments', items_many: 'x', items_other: 'y' }, 'fr', 'i18next'))).toHaveLength(1);
  });
});
