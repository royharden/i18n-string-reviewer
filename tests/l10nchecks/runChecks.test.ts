import { describe, expect, it } from 'vitest';
import { RULE_IDS, RULES } from '../../src/core/l10nchecks/rules/index.ts';
import { checkVersion, runChecks } from '../../src/core/l10nchecks/runChecks.ts';
import { ERROR_RULE_IDS, WARNING_RULE_IDS } from '../../src/core/l10nchecks/types.ts';
import { makeDoc, sourceDoc, targetDoc } from './helpers.ts';

describe('rule registry', () => {
  it('registers exactly the 17 rule ids of PLAN §1.1, each once', () => {
    expect(RULES).toHaveLength(17);
    expect(new Set(RULES.map((r) => r.id))).toEqual(new Set(RULE_IDS));
    expect([...ERROR_RULE_IDS].sort()).toEqual(
      [
        'empty_translation',
        'html_tag_mismatch',
        'icu_syntax_invalid',
        'missing_key',
        'placeholder_mismatch',
        'plural_category_missing',
        'select_branch_mismatch',
        'type_mismatch',
      ].sort(),
    );
    expect(WARNING_RULE_IDS).toHaveLength(9);
  });

  it('gives each rule the severity of its group', () => {
    for (const r of RULES) {
      expect(r.severity).toBe((ERROR_RULE_IDS as readonly string[]).includes(r.id) ? 'error' : 'warning');
    }
  });
});

describe('runChecks', () => {
  it('exports a check version', () => {
    expect(checkVersion).toMatch(/^l10nchecks\/\d+\.\d+\.\d+$/);
  });

  it('sorts errors first, then by path', () => {
    const f = runChecks(sourceDoc({ a: 'Settings', b: 'Hello {name}' }), targetDoc({ a: 'Settings', b: 'Bonjour', z: 'extra' }, 'fr'));
    const sev = f.map((x) => x.severity);
    expect(sev.indexOf('warning')).toBeGreaterThan(sev.lastIndexOf('error'));
    expect(f[0]?.ruleId).toBe('placeholder_mismatch');
  });

  it('returns nothing for a rejected document', () => {
    const rejected = { ...makeDoc({ a: 'x' }, 'fr'), rejected: true };
    expect(runChecks(sourceDoc({ a: 'A' }), rejected)).toEqual([]);
  });
});
