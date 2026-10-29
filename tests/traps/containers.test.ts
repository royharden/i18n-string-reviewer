import { describe, expect, it } from 'vitest';
import { runChecks } from '../../src/core/l10nchecks/runChecks.ts';
import { sourceDoc, targetDoc } from '../l10nchecks/helpers.ts';

describe('trap: empty object alignment', () => {
  it.each([
    [{ a: 'A' }, { a: {} }, ['a']],
    [{ a: {} }, { a: 'Un' }, ['a']],
    [{ nav: { a: 'A' } }, { nav: { a: {} } }, ['nav', 'a']],
    [{ nav: { a: {} } }, { nav: { a: 'Un' } }, ['nav', 'a']],
    [{ a: 'A' }, { a: { nested: {} } }, ['a']],
    [{ a: { nested: {} } }, { a: 'Un' }, ['a']],
    [{ 'a.b': 'A' }, { 'a.b': {} }, ['a.b']],
    [{ 'a.b': {} }, { 'a.b': 'Un' }, ['a.b']],
  ] as const)('reports exactly one type mismatch for %j → %j', (source, target, path) => {
    const findings = runChecks(sourceDoc(source), targetDoc(target, 'fr'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'type_mismatch', severity: 'error', path });
  });

  it('accepts equal empty containers at root and nested/literal dotted paths', () => {
    expect(runChecks(sourceDoc({}), targetDoc({}, 'fr'))).toEqual([]);
    const content = { a: {}, nav: { empty: {} }, 'a.b': {} };
    expect(runChecks(sourceDoc(content), targetDoc(content, 'fr'))).toEqual([]);
  });

  it('does not confuse a literal dotted leaf with a nested empty object', () => {
    const findings = runChecks(sourceDoc({ 'a.b': 'A' }), targetDoc({ a: { b: {} } }, 'fr'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'missing_key', path: ['a.b'] });
    const reverse = runChecks(sourceDoc({ a: { b: {} } }), targetDoc({ 'a.b': 'Un' }, 'fr'));
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ ruleId: 'orphan_key', path: ['a.b'] });
  });

  it('retains ordinary leaf alignment next to equal empty containers', () => {
    const source = sourceDoc({ nav: { empty: {}, title: 'Save' }, required: 'Required' });
    const target = targetDoc({ nav: { empty: {}, title: 'Sauver' }, stale: 'Ancien' }, 'fr');
    expect(runChecks(source, target).map((f) => ({ ruleId: f.ruleId, path: f.path }))).toEqual([
      { ruleId: 'missing_key', path: ['required'] },
      { ruleId: 'orphan_key', path: ['stale'] },
    ]);
  });

  it('reports container clashes within/above plural families without derivative missing/category noise', () => {
    const source = sourceDoc({ items_one: 'One', items_other: 'Many' }, 'i18next');
    const findings = runChecks(source, targetDoc({ items_one: {}, items_other: 'Viele' }, 'de', 'i18next'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'type_mismatch', path: ['items_one'] });
    const nested = runChecks(
      sourceDoc({ nav: { items_one: 'One', items_other: 'Many', empty: {} } }, 'i18next'),
      targetDoc({ nav: 'Menu' }, 'fr', 'i18next'),
    );
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({ ruleId: 'type_mismatch', path: ['nav'] });
  });

  it('preserves empty sibling errors alongside a clashing category in a complete Russian family', () => {
    const source = sourceDoc({ items_one: 'One', items_other: 'Hello {{name}}' }, 'i18next');
    const target = targetDoc({ items_one: {}, items_few: '{{name}}', items_many: '{{name}}', items_other: '' }, 'ru', 'i18next');
    expect(runChecks(source, target).map((f) => ({ ruleId: f.ruleId, path: f.path }))).toEqual([
      { ruleId: 'type_mismatch', path: ['items_one'] },
      { ruleId: 'empty_translation', path: ['items_other'] },
    ]);
  });

  it.each([
    ['Hello {{name}}', 'Hallo {{other}}', 'placeholder_mismatch'],
    ['<b>Hello {{name}}</b>', 'Hallo {{name}}', 'html_tag_mismatch'],
  ] as const)('preserves independent sibling %s → %s findings', (sourceOther, targetOther, ruleId) => {
    const source = sourceDoc({ items_one: 'One', items_other: sourceOther }, 'i18next');
    const target = targetDoc({ items_one: {}, items_other: targetOther }, 'de', 'i18next');
    const findings = runChecks(source, target);
    expect(findings).toHaveLength(2);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'type_mismatch', path: ['items_one'] }),
      expect.objectContaining({ ruleId, path: ['items_other'] }),
    ]));
  });

  it('still reports genuinely missing categories beside a clash', () => {
    const source = sourceDoc({ items_one: 'One', items_other: 'Hello {{name}}' }, 'i18next');
    const target = targetDoc({ items_one: {}, items_many: '{{name}}', items_other: '' }, 'ru', 'i18next');
    const findings = runChecks(source, target);
    const missing = findings.filter((f) => f.ruleId === 'plural_category_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('_few');
    expect(missing[0]?.message).not.toContain('_one');
    expect(findings.some((f) => f.ruleId === 'empty_translation' && f.path[0] === 'items_other')).toBe(true);
  });

  it.each([{}, { nested: 'Nested' }])('preserves sibling errors when the source has a clashing %j container', (container) => {
    const source = sourceDoc({ items_one: 'One', items_other: 'Hello {{name}}', items_few: container }, 'i18next');
    const target = targetDoc({ items_one: 'Один', items_few: 'Мало', items_many: '{{name}}', items_other: '' }, 'ru', 'i18next');
    expect(runChecks(source, target).map((f) => ({ ruleId: f.ruleId, path: f.path }))).toEqual([
      { ruleId: 'type_mismatch', path: ['items_few'] },
      { ruleId: 'empty_translation', path: ['items_other'] },
    ]);
  });

  it('keeps the source other form usable as fallback when only its target form clashes', () => {
    const source = sourceDoc({ items_one: 'One', items_other: 'Hello {{name}}' }, 'i18next');
    const target = targetDoc({ items_one: 'Один', items_few: '{{other}}', items_many: '{{name}}', items_other: {} }, 'ru', 'i18next');
    const findings = runChecks(source, target);
    expect(findings).toHaveLength(2);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'type_mismatch', path: ['items_other'] }),
      expect.objectContaining({ ruleId: 'placeholder_mismatch', path: ['items_few'] }),
    ]));
  });
});
