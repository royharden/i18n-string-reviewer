// PLAN §1.4 step 2 — plural traps, through the full runChecks pass.
import { describe, expect, it } from 'vitest';
import { checkAll, errorsOf, ruleIds, sourceDoc, targetDoc } from '../l10nchecks/helpers.ts';
import { runChecks } from '../../src/core/l10nchecks/runChecks.ts';

const EN = '{n, plural, one {# file} other {# files}}';

describe('trap: plurals', () => {
  it('ru missing few → plural_category_missing', () => {
    const f = checkAll(EN, '{n, plural, one {# файл} many {# файлов} other {# файла}}', 'ru');
    const missing = f.filter((x) => x.ruleId === 'plural_category_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('few');
  });

  it('ja extra one → plural_category_extra (warning) and nothing missing', () => {
    const f = checkAll(EN, '{n, plural, one {# 件のファイル} other {# 件のファイル}}', 'ja');
    const extra = f.filter((x) => x.ruleId === 'plural_category_extra');
    expect(extra).toHaveLength(1);
    expect(extra[0]?.severity).toBe('warning');
    expect(ruleIds(f)).not.toContain('plural_category_missing');
  });

  it('ar missing categories → plural_category_missing', () => {
    const f = checkAll(EN, '{n, plural, one {ملف واحد} other {# ملفات}}', 'ar');
    const missing = f.find((x) => x.ruleId === 'plural_category_missing');
    expect(missing?.message).toContain('zero');
    expect(missing?.message).toContain('two');
  });

  it('=0 without other → plural_category_missing (other required), not a syntax error', () => {
    const src = '{n, plural, =0 {No files} one {# file} other {# files}}';
    const f = checkAll(src, '{n, plural, =0 {Aucun fichier} one {# fichier} many {# de fichiers}}', 'fr');
    expect(f.find((x) => x.ruleId === 'plural_category_missing')?.message).toContain('other');
    expect(ruleIds(f)).not.toContain('icu_syntax_invalid');
  });

  it('a target branch without # (ar one/two spelled out) is not an error', () => {
    const ar = '{n, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}';
    expect(errorsOf(checkAll(EN, ar, 'ar'))).toEqual([]);
  });

  it('allows the plural number to be expressed by its own argument/number in either direction', () => {
    for (const reference of ['{n}', '{n, number}']) {
      const explicit = `{n, plural, one {file} other {${reference} files}}`;
      expect(errorsOf(checkAll(EN, explicit, 'en'))).toEqual([]);
      expect(errorsOf(checkAll(explicit, EN, 'en'))).toEqual([]);
    }
  });

  it('keeps a lone _other label ordinary, including its count placeholder', () => {
    const source = sourceDoc({ label_other: 'Other {{count}}' }, 'i18next');
    const good = runChecks(source, targetDoc({ label_other: 'Autre {{count}}' }, 'fr', 'i18next'));
    expect(errorsOf(good)).toEqual([]);
    const bad = runChecks(source, targetDoc({ label_other: 'Autre' }, 'fr', 'i18next'));
    expect(ruleIds(bad)).toContain('placeholder_mismatch');
    expect(ruleIds(bad)).not.toContain('plural_category_missing');
  });
});
