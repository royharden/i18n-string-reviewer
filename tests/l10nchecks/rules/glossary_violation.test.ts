import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/glossary_violation.ts';
import type { GlossaryEntry } from '../../../src/core/l10nchecks/types.ts';
import { checkPair } from '../helpers.ts';

const glossary: GlossaryEntry[] = [
  { term: 'card', translations: { fr: 'carte', ru: 'карточ' } },
  { term: 'TaskBoard', doNotTranslate: true },
];
const options = { glossary };

describe('glossary_violation', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('glossary_violation');
    expect(rule.severity).toBe('warning');
  });

  it('flags a missing approved translation', () => {
    const f = checkPair(rule, 'Move card', 'Déplacer la fiche', 'fr', { options });
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('carte');
  });

  it('accepts the approved translation, case-insensitively and as a stem', () => {
    expect(checkPair(rule, 'Move card', 'Déplacer la Carte', 'fr', { options })).toEqual([]);
    expect(checkPair(rule, 'Move card', 'Переместить карточку', 'ru', { options })).toEqual([]);
  });

  it('falls back from region to language', () => {
    expect(checkPair(rule, 'Move card', 'Déplacer la fiche', 'fr-CA', { options })).toHaveLength(1);
  });

  it('flags an altered do-not-translate term', () => {
    expect(checkPair(rule, 'Open TaskBoard', 'Ouvrir Tableau', 'fr', { options })).toHaveLength(1);
    expect(checkPair(rule, 'Open TaskBoard', 'Ouvrir TaskBoard', 'fr', { options })).toEqual([]);
  });

  it('matches whole words only and needs a glossary', () => {
    expect(checkPair(rule, 'Discard changes', 'Abandonner', 'fr', { options })).toEqual([]);
    expect(checkPair(rule, 'Move card', 'Déplacer la fiche', 'fr')).toEqual([]);
  });
});
