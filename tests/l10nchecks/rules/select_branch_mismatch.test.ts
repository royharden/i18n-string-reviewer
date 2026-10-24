import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/select_branch_mismatch.ts';
import { checkPair } from '../helpers.ts';

const SRC = '{g, select, female {She} male {He} other {They}}';

describe('select_branch_mismatch', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('select_branch_mismatch');
    expect(rule.severity).toBe('error');
  });

  it('flags a dropped branch', () => {
    const f = checkPair(rule, SRC, '{g, select, male {Il} other {Iel}}', 'fr');
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('female');
  });

  it('flags an invented branch', () => {
    expect(checkPair(rule, SRC, '{g, select, female {Elle} male {Il} neuter {Iel} other {Iel}}', 'fr')).toHaveLength(1);
  });

  it('does not flag identical keys or plural branch differences', () => {
    expect(checkPair(rule, SRC, '{g, select, other {Iel} male {Il} female {Elle}}', 'fr')).toEqual([]);
    expect(checkPair(rule, '{n, plural, one {#} other {#}}', '{n, plural, one {#} few {#} many {#} other {#}}', 'ru')).toEqual([]);
  });
});
