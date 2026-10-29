import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/html_tag_mismatch.ts';
import { checkPair } from '../helpers.ts';

describe('html_tag_mismatch', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('html_tag_mismatch');
    expect(rule.severity).toBe('error');
  });

  describe('icu', () => {
    it('flags a dropped tag', () => {
      expect(checkPair(rule, '<b>{name}</b> joined', '{name} a rejoint', 'fr')).toHaveLength(1);
    });

    it('allows reordering', () => {
      expect(checkPair(rule, '<b>{name}</b> joined', 'A rejoint : <b>{name}</b>', 'fr')).toEqual([]);
    });

    it('flags a changed href and unbalanced markup', () => {
      expect(checkPair(rule, '<a href="/help">Help</a>', '<a href="/aide">Aide</a>', 'fr')).toHaveLength(1);
      expect(checkPair(rule, '<b>{name}</b> joined', '<b>{name} a rejoint', 'fr')[0]?.message).toContain('never closed');
    });
  });

  describe('plain / i18next', () => {
    it('flags a changed href, a dropped numbered tag and unbalanced tags', () => {
      expect(checkPair(rule, '<a href="/help">Help</a>', '<a href="/aide">Aide</a>', 'fr', { dialect: 'plain' })).toHaveLength(1);
      expect(checkPair(rule, '<0>{{name}}</0> joined', '{{name}} a rejoint', 'fr', { dialect: 'i18next' })).toHaveLength(1);
      expect(checkPair(rule, '<b>Bold</b>', '<b>Gras', 'fr', { dialect: 'plain' })).toHaveLength(1);
    });

    it('treats <br> and <br/> alike and allows sibling reordering', () => {
      expect(checkPair(rule, 'Line<br>two', 'Ligne<br/>deux', 'fr', { dialect: 'plain' })).toEqual([]);
      expect(checkPair(rule, '<b>A</b> <i>B</i>', '<i>B</i> <b>A</b>', 'fr', { dialect: 'plain' })).toEqual([]);
    });
  });
});
