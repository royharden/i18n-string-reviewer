import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/length_risk.ts';
import { checkPair, contextMap } from '../helpers.ts';

describe('length_risk', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('length_risk');
    expect(rule.severity).toBe('warning');
  });

  it('uses the 1.6× ratio for sources of at least 4 code points', () => {
    expect(checkPair(rule, 'abcdefghij', 'abcdefghijklmn', 'fr')).toEqual([]); // 1.4×
    expect(checkPair(rule, 'abcdefghij', 'abcdefghijklmnop', 'fr')).toEqual([]); // exactly 1.6×
    expect(checkPair(rule, 'abcdefghij', 'a'.repeat(30), 'fr')).toHaveLength(1); // 3×
    expect(checkPair(rule, 'OK', 'Accepter', 'fr')).toEqual([]); // source < 4
  });

  it('counts code points, not UTF-16 units', () => {
    expect(checkPair(rule, 'abcde', '😀'.repeat(8), 'fr')).toEqual([]); // 8 code points = 1.6×
  });

  it('treats context maxLength as authoritative', () => {
    const context = contextMap([[['k'], { maxLength: 5 }]]);
    expect(checkPair(rule, 'abcdef', 'abcdef', 'fr', { options: { context } })).toHaveLength(1);
    const roomy = contextMap([[['k'], { maxLength: 40 }]]);
    expect(checkPair(rule, 'ab cd', 'a'.repeat(30), 'fr', { options: { context: roomy } })).toEqual([]);
  });

  it('ignores markup', () => {
    expect(checkPair(rule, '<b>Save</b>', '<strong>Sauver</strong>', 'fr', { dialect: 'plain' })).toEqual([]);
  });

  it('compares the longest ICU branch per side, not the sum of branches', () => {
    // en longest branch "# files" = 7; ar has six branches, longest 8 code points → 1.14×.
    const en = '{n, plural, one {# file} other {# files}}';
    const ar = '{n, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}';
    expect(checkPair(rule, en, ar, 'ar')).toEqual([]);
    const ru = '{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}';
    expect(checkPair(rule, en, ru, 'ru')).toEqual([]);
    const long = '{n, plural, one {# fichier extrêmement long ici} many {# x} other {# y}}';
    expect(checkPair(rule, en, long, 'fr')).toHaveLength(1);
  });
});
