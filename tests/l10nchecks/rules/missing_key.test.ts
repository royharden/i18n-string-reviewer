import { describe, expect, it } from 'vitest';
import { rule } from '../../../src/core/l10nchecks/rules/missing_key.ts';
import { runRule, sourceDoc, targetDoc } from '../helpers.ts';

describe('missing_key', () => {
  it('is an error rule with the stable id', () => {
    expect(rule.id).toBe('missing_key');
    expect(rule.severity).toBe('error');
  });

  it('flags a source key absent from the target', () => {
    const f = runRule(rule, sourceDoc({ a: 'A', nav: { b: 'B' } }), targetDoc({ a: 'x' }, 'fr'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ ruleId: 'missing_key', severity: 'error', path: ['nav', 'b'], locale: 'fr', subject: 'target' });
  });

  it('does not flag when every key is present', () => {
    expect(runRule(rule, sourceDoc({ a: 'A', b: 'B' }), targetDoc({ b: 'y', a: 'x' }, 'fr'))).toEqual([]);
  });

  it('groups i18next plural families before comparing', () => {
    const src = sourceDoc({ items_one: '{{count}} item', items_other: '{{count}} items' }, 'i18next');
    expect(runRule(rule, src, targetDoc({ items_other: '{{count}}件' }, 'ja', 'i18next'))).toEqual([]);
    const f = runRule(rule, src, targetDoc({}, 'ja', 'i18next'));
    expect(f.map((x) => x.path)).toEqual([['items_other']]);
  });

  it('reports an object/string clash as type_mismatch, not missing', () => {
    expect(runRule(rule, sourceDoc({ a: 'A' }), targetDoc({ a: { b: 'x' } }, 'fr'))).toEqual([]);
  });
});
