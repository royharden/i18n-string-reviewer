import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/whitespace_drift.ts';
import { checkPair } from '../helpers.ts';

describe('whitespace_drift', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('whitespace_drift');
    expect(rule.severity).toBe('warning');
  });

  it('flags leading/trailing whitespace and double-space differences', () => {
    expect(checkPair(rule, 'Save', 'Enregistrer ', 'fr')[0]?.message).toContain('trailing');
    expect(checkPair(rule, 'Save', ' Enregistrer', 'fr')[0]?.message).toContain('leading');
    expect(checkPair(rule, 'Save file', 'Enregistrer  le fichier', 'fr')[0]?.message).toContain('double space');
  });

  it('treats &nbsp;, U+00A0 and U+202F as the same character', () => {
    expect(checkPair(rule, 'Total:&nbsp;', 'Total :\u00A0', 'fr')).toEqual([]);
    expect(checkPair(rule, 'Total:\u00A0', 'Total :\u202F', 'fr')).toEqual([]);
  });

  it('does not flag matching whitespace', () => {
    expect(checkPair(rule, ' Save ', ' Enregistrer ', 'fr')).toEqual([]);
  });
});
