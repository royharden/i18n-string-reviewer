import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/empty_translation.ts';
import { checkPair } from '../helpers.ts';

describe('empty_translation', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('empty_translation');
    expect(rule.severity).toBe('error');
  });

  it('flags empty and whitespace-only targets', () => {
    expect(checkPair(rule, 'Save', '', 'fr')).toHaveLength(1);
    expect(checkPair(rule, 'Save', '  \u00A0', 'fr')).toHaveLength(1);
  });

  it('does not flag a translated string or an empty source', () => {
    expect(checkPair(rule, 'Save', 'Enregistrer', 'fr')).toEqual([]);
    expect(checkPair(rule, '', '', 'fr')).toEqual([]);
  });
});
