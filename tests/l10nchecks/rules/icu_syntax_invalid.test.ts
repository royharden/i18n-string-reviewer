import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/icu_syntax_invalid.ts';
import { checkPair } from '../helpers.ts';

describe('icu_syntax_invalid', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('icu_syntax_invalid');
    expect(rule.severity).toBe('error');
  });

  it('flags a target that does not parse', () => {
    const f = checkPair(rule, '{count} items', '{count éléments', 'fr');
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('ICU syntax error');
  });

  it('does not flag valid targets or a missing other branch', () => {
    expect(checkPair(rule, '{count} items', '{count} éléments', 'fr')).toEqual([]);
    expect(checkPair(rule, '{n, plural, one {#} other {#}}', '{n, plural, one {#}}', 'fr')).toEqual([]);
  });

  it('only applies to the ICU dialect', () => {
    expect(checkPair(rule, '{count} items', '{count éléments', 'fr', { dialect: 'plain' })).toEqual([]);
  });

  it('does not repeat a broken source per target', () => {
    expect(checkPair(rule, '{a', '{b', 'fr')).toEqual([]);
  });
});
