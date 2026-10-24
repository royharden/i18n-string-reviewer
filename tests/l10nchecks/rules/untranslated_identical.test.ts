import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/untranslated_identical.ts';
import type { GlossaryEntry } from '../../../src/core/l10nchecks/types.ts';
import { checkPair } from '../helpers.ts';

const glossary: GlossaryEntry[] = [
  { term: 'TaskBoard', doNotTranslate: true },
  { term: 'OK', doNotTranslate: true },
];

describe('untranslated_identical', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('untranslated_identical');
    expect(rule.severity).toBe('warning');
  });

  it('flags a target identical to the source', () => {
    expect(checkPair(rule, 'Settings', 'Settings', 'fr')).toHaveLength(1);
  });

  it('ignores do-not-translate terms, placeholders and digits', () => {
    const options = { glossary };
    expect(checkPair(rule, 'TaskBoard', 'TaskBoard', 'fr', { options })).toEqual([]);
    expect(checkPair(rule, 'OK', 'OK', 'fr', { options })).toEqual([]);
    expect(checkPair(rule, '{count}', '{count}', 'fr')).toEqual([]);
    expect(checkPair(rule, '404', '404', 'fr')).toEqual([]);
  });

  it('still flags identical text around a do-not-translate term', () => {
    expect(checkPair(rule, 'Welcome to TaskBoard', 'Welcome to TaskBoard', 'fr', { options: { glossary } })).toHaveLength(1);
  });

  it('skips same-language targets and translated strings', () => {
    expect(checkPair(rule, 'Colour', 'Colour', 'en-GB', { sourceLocale: 'en' })).toEqual([]);
    expect(checkPair(rule, 'Settings', 'Paramètres', 'fr')).toEqual([]);
  });
});
