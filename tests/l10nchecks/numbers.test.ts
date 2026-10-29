import { describe, expect, it } from 'vitest';
import { asciiDigits, compareNumbers, extractNumbers } from '../../src/core/l10nchecks/numbers.ts';

describe('asciiDigits', () => {
  it('maps Arabic-Indic and Persian digits', () => {
    expect(asciiDigits('١٢٣ / ۴۵۶')).toBe('123 / 456');
  });
});

describe('extractNumbers', () => {
  it('reads grouping per locale', () => {
    expect(extractNumbers('1,000 users', 'en')).toEqual(['1000']);
    expect(extractNumbers('1\u202F000 utilisateurs', 'fr')).toEqual(['1000']);
    expect(extractNumbers('1\u00A0000 пользователей', 'ru')).toEqual(['1000']);
    expect(extractNumbers('1 000 users', 'fr')).toEqual(['1000']);
    expect(extractNumbers('1.000 Nutzer', 'de')).toEqual(['1000']);
    expect(extractNumbers('1,000,000', 'en')).toEqual(['1000000']);
    expect(extractNumbers('١٬٠٠٠ مستخدم', 'ar')).toEqual(['1000']);
  });

  it('reads decimals per locale', () => {
    expect(extractNumbers('1.5 GB', 'en')).toEqual(['1.5']);
    expect(extractNumbers('1,5 Go', 'fr')).toEqual(['1.5']);
    expect(extractNumbers('1,234.5', 'en')).toEqual(['1234.5']);
    expect(extractNumbers('1.234,5', 'de')).toEqual(['1234.5']);
    expect(extractNumbers('٢٫٥', 'ar')).toEqual(['2.5']);
    expect(extractNumbers('2.50', 'en')).toEqual(['2.5']);
  });

  it('splits runs that are not grouped numbers', () => {
    expect(extractNumbers('Step 1 of 3', 'en')).toEqual(['1', '3']);
    expect(extractNumbers('10:30 on 2026-10-24', 'en')).toEqual(['10', '30', '2026', '10', '24']);
  });
});

describe('compareNumbers', () => {
  it('treats locale formatting differences as equal', () => {
    expect(compareNumbers('1,000 users', 'en', '1 000 utilisateurs', 'fr').equal).toBe(true);
    expect(compareNumbers('1,000 users', 'en', '1.000 Nutzer', 'de').equal).toBe(true);
    expect(compareNumbers('Pay 5 of 10', 'en', 'Payer 10 sur 5', 'fr').equal).toBe(true);
  });

  it('reports changed values', () => {
    const r = compareNumbers('5 files', 'en', '6 fichiers', 'fr');
    expect(r.equal).toBe(false);
    expect(r.source).toEqual(['5']);
    expect(r.target).toEqual(['6']);
  });

  it('compares sets when asked (plural branches)', () => {
    expect(compareNumbers('10 10', 'en', '10', 'ru', { asSets: true }).equal).toBe(true);
    expect(compareNumbers('10 10', 'en', '10', 'ru').equal).toBe(false);
  });
});
