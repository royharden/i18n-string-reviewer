import { describe, expect, it } from 'vitest';
import { detectDialect } from '../../src/core/l10nchecks/dialect.ts';
import { suggestLocaleFromFileName, validateLocale } from '../../src/core/l10nchecks/locale.ts';
import { displayPath, parseDisplayPath, pathKey, segmentsFromKey } from '../../src/core/l10nchecks/paths.ts';
import { makeDoc } from './helpers.ts';

describe('paths', () => {
  it('distinguishes a dotted segment from nesting', () => {
    expect(pathKey(['a.b'])).not.toBe(pathKey(['a', 'b']));
    expect(displayPath(['a', 'b'])).toBe('a.b');
    expect(displayPath(['a.b'])).toBe('["a.b"]');
    expect(displayPath(['', 'x'])).toBe('["","x"]');
  });

  it('round-trips display paths and keys', () => {
    for (const p of [['nav', 'post'], ['a.b'], ['__proto__'], ['x', 'with space'], ['é', 'ü']]) {
      expect(parseDisplayPath(displayPath(p))).toEqual(p);
      expect(segmentsFromKey(pathKey(p))).toEqual(p);
    }
  });

  it('rejects malformed display paths', () => {
    expect(parseDisplayPath('')).toBeNull();
    expect(parseDisplayPath('a..b')).toBeNull();
    expect(parseDisplayPath('[1, 2]')).toBeNull();
    expect(parseDisplayPath('[not json')).toBeNull();
  });
});

describe('locale', () => {
  it('validates and canonicalises supported locales', () => {
    expect(validateLocale('fr')).toEqual({ ok: true, canonical: 'fr' });
    expect(validateLocale('pt-br')).toEqual({ ok: true, canonical: 'pt-BR' });
    expect(validateLocale('xx')).toMatchObject({ ok: false, code: 'unsupported_locale' });
    expect(validateLocale('en_US')).toMatchObject({ ok: false, code: 'invalid_locale' });
    expect(validateLocale('')).toMatchObject({ ok: false, code: 'invalid_locale' });
  });

  it('suggests a locale from common file-name shapes', () => {
    expect(suggestLocaleFromFileName('fr.json')).toBe('fr');
    expect(suggestLocaleFromFileName('pt_BR.json')).toBe('pt-BR');
    expect(suggestLocaleFromFileName('messages.ja.json')).toBe('ja');
    expect(suggestLocaleFromFileName('locales/ru/common.json')).toBe('ru');
    expect(suggestLocaleFromFileName('C:\\proj\\i18n\\ar\\strings.json')).toBe('ar');
    expect(suggestLocaleFromFileName('strings.json')).toBeNull();
  });
});

describe('detectDialect', () => {
  it('detects ICU from ICU-only constructs', () => {
    const doc = makeDoc({ a: 'Hello {name}', b: '{n, plural, one {# file} other {# files}}' }, 'en');
    expect(detectDialect(doc).dialect).toBe('icu');
  });

  it('detects i18next from {{…}}, $t( or plural suffixes', () => {
    expect(detectDialect(makeDoc({ a: 'Hi {{name}}' }, 'en')).dialect).toBe('i18next');
    expect(detectDialect(makeDoc({ a: 'Open $t(nav.board)' }, 'en')).dialect).toBe('i18next');
    expect(detectDialect(makeDoc({ items_one: 'One item', items_other: 'Items' }, 'en')).dialect).toBe('i18next');
  });

  it('falls back to plain', () => {
    const s = detectDialect(makeDoc({ a: 'Hello {name}, %s' }, 'en'));
    expect(s.dialect).toBe('plain');
    expect(s.reason).toContain('no dialect-specific');
  });
});
