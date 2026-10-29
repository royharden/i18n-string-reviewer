import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/bidi_control_chars.ts';
import { checkPair } from '../helpers.ts';

describe('bidi_control_chars', () => {
  it('is a warning rule with the stable id', () => {
    expect(rule.id).toBe('bidi_control_chars');
    expect(rule.severity).toBe('warning');
  });

  it('flags controls added by the target', () => {
    const f = checkPair(rule, 'Hello {name}', 'مرحبا \u200F{name}', 'ar');
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toBe('U+200F');
    expect(checkPair(rule, 'a', '\u202Eb\u2066c\u2069', 'ar')[0]?.evidence).toBe('U+202E, U+2066, U+2069');
  });

  it('does not flag controls already in the source, or none at all', () => {
    expect(checkPair(rule, '\u200Eabc', '\u200Eأبج', 'ar')).toEqual([]);
    expect(checkPair(rule, 'Hello', 'مرحبا', 'ar')).toEqual([]);
  });
});
