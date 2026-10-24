import { describe, expect, it } from 'vitest';
import {
  comparableIcuPaths,
  diffIcuStructures,
  icuArguments,
  icuDisplayLength,
  icuPathSignature,
  icuStructure,
  parseIcu,
} from '../../src/core/l10nchecks/icu.ts';
import type { IcuAst } from '../../src/core/l10nchecks/icu.ts';

function ast(text: string): IcuAst {
  const r = parseIcu(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.ast;
}
const sig = (text: string): readonly string[] => {
  const s = icuPathSignature(text);
  if (s === null) throw new Error(`does not parse: ${text}`);
  return s;
};
const enc = (...steps: string[]): string => JSON.stringify(steps);
const diff = (a: string, b: string) => diffIcuStructures(icuStructure(ast(a)), icuStructure(ast(b)));

describe('parseIcu', () => {
  it('parses valid messages and reports syntax errors with a kind and offset', () => {
    expect(parseIcu('Hello {name}').ok).toBe(true);
    const bad = parseIcu('{count, plural, one {x}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.kind).toMatch(/^[A-Z_]+$/);
      expect(bad.error.message).toContain('ICU syntax error');
    }
  });

  it('does not require `other` (that is a plural_category_missing finding)', () => {
    expect(parseIcu('{n, plural, =0 {none}}').ok).toBe(true);
  });

  it('treats markup as text (tags handled by our tokenizer)', () => {
    expect(parseIcu('<a href="https://x.test">{name}</a> <br>').ok).toBe(true);
  });

  it('applies ICU apostrophe quoting', () => {
    expect(icuArguments(ast("Plus d'{count}"))).toEqual([]);
    expect(icuArguments(ast("It's {name}")).map((a) => a.name)).toEqual(['name']);
  });
});

describe('icuPathSignature', () => {
  it('records argument types and styles', () => {
    expect(sig('{n, number, percent}')).toEqual([enc('number:n:percent')]);
    expect(sig('{n}')).toEqual([enc('arg:n')]);
  });

  it('distinguishes the same argument multiset in a different tree', () => {
    const a = sig('{a} <b>{b}</b>');
    const b = sig('<b>{a}</b> {b}');
    expect(a).not.toEqual(b);
    expect(a).toContain(enc('tag:b', 'arg:b'));
    expect(b).toContain(enc('tag:b', 'arg:a'));
  });

  it('distinguishes plural from selectordinal and records offset', () => {
    expect(sig('{n, plural, other {x}}')).toContain(enc('plural:n:cardinal:offset=0'));
    expect(sig('{n, selectordinal, other {x}}')).toContain(enc('plural:n:ordinal:offset=0'));
    expect(sig('{n, plural, offset:1 one {x} other {y}}')).toContain(enc('plural:n:cardinal:offset=1'));
  });

  it('keeps exact selectors and # placement per branch', () => {
    const s = sig('{n, plural, =0 {none} one {# file} other {# files}}');
    expect(s).toContain(enc('plural:n:cardinal:offset=0', 'case:=0'));
    expect(s).toContain(enc('plural:n:cardinal:offset=0', 'case:one', '#'));
    expect(s).not.toContain(enc('plural:n:cardinal:offset=0', 'case:=0', '#'));
    expect(sig('{n, plural, one {file} other {# files}}')).not.toEqual(sig('{n, plural, one {# file} other {# files}}'));
  });

  it.each(['{n}', '{n, number}', '{n, number, integer}'])('keeps plural self-reference %s in the strict gate signature', (reference) => {
    const text = `{n, plural, one {file} other {${reference} files}}`;
    const s = sig(text);
    const step = reference === '{n}' ? 'arg:n' : `number:n:${reference === '{n, number}' ? '' : 'integer'}`;
    expect(s).toContain(enc('plural:n:cardinal:offset=0', 'case:other', step));
    expect(s).not.toEqual(sig('{n, plural, one {file} other {# files}}'));
    expect(s).not.toEqual(sig('{n, plural, one {file} other {files}}'));
  });

  it('is a multiset (repeated arguments count)', () => {
    expect(sig('{a} {a}')).toEqual([enc('arg:a'), enc('arg:a')]);
  });

  it('includes href values exactly and attribute names only otherwise', () => {
    expect(sig('<a href="/x" class="c">go</a>')).toEqual([enc('tag:a class href="/x"')]);
  });

  it('returns null for unparseable text', () => {
    expect(icuPathSignature('{oops')).toBeNull();
  });
});

describe('icuStructure', () => {
  it('lists plural nodes with selectors and nesting depth', () => {
    const s = icuStructure(ast('{g, select, male {{n, plural, one {#} other {#}}} other {z}}'));
    expect(s.choiceDepth).toBe(2);
    expect(s.plurals).toHaveLength(1);
    expect(s.plurals[0]?.selectors).toEqual(['one', 'other']);
    expect(s.selects[0]?.keys).toEqual(['male', 'other']);
  });

  it('reports unbalanced markup per scope', () => {
    expect(icuStructure(ast('<b>{name} joined')).tagIssues).toHaveLength(1);
    expect(icuStructure(ast('<b>{name}</b> joined')).tagIssues).toHaveLength(0);
  });

  it('recovers a select key literally named __proto__ (D3)', () => {
    expect(icuStructure(ast('{g, select, __proto__ {a} other {b}}')).selects[0]?.keys).toContain('__proto__');
  });
});

describe('comparable paths and diff', () => {
  it('collapses plural branches and ignores # for source/target comparison', () => {
    const en = comparableIcuPaths(icuStructure(ast('{n, plural, one {# file} other {# files}}')));
    const ar = comparableIcuPaths(icuStructure(ast('{n, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}')));
    expect([...ar].sort()).toEqual([...en].sort());
  });

  it.each(['{n}', '{n, number}', '{n, number, integer}'])('ignores plural self-reference %s in either comparison direction', (reference) => {
    const explicit = `{n, plural, one {file} other {${reference} files}}`;
    for (const other of ['{n, plural, one {file} other {# files}}', '{n, plural, one {file} other {files}}']) {
      expect(diff(explicit, other)).toEqual({ placeholder: [], select: [], tags: [] });
      expect(diff(other, explicit)).toEqual({ placeholder: [], select: [], tags: [] });
    }
  });

  it('resolves self-references through select/tag scopes and preserves ordinal behavior', () => {
    const explicit = '{n, selectordinal, other {{g, select, other {<b>{n, number}</b>}}}}';
    const pound = '{n, selectordinal, other {{g, select, other {<b>#</b>}}}}';
    expect(diff(explicit, pound)).toEqual({ placeholder: [], select: [], tags: [] });
    expect(diff(pound, explicit)).toEqual({ placeholder: [], select: [], tags: [] });
    expect(sig(explicit)).not.toEqual(sig(pound));
  });

  it('uses the nearest plural: inner self-references are optional, outer/unrelated references are not', () => {
    const explicit = '{n, plural, other {{m, plural, other {{m, number} / {n} / {owner}}}}}';
    const pound = '{n, plural, other {{m, plural, other {# / {n} / {owner}}}}}';
    expect(diff(explicit, pound)).toEqual({ placeholder: [], select: [], tags: [] });
    expect(diff(pound, explicit)).toEqual({ placeholder: [], select: [], tags: [] });
    for (const changed of [
      '{n, plural, other {{m, plural, other {# / {owner}}}}}',
      '{n, plural, other {{m, plural, other {# / {n}}}}}',
    ]) {
      expect(diff(explicit, changed).placeholder).toHaveLength(1);
      expect(diff(changed, explicit).placeholder).toHaveLength(1);
    }
  });

  it('keeps root references, date arguments and references to a sibling plural compared', () => {
    for (const [a, b] of [
      ['{n, number} {n, plural, other {#}}', '{n, plural, other {#}}'],
      ['{n, plural, other {{n, date}}}', '{n, plural, other {#}}'],
      ['{n, plural, other {{m}}} {m, plural, other {#}}', '{n, plural, other {#}} {m, plural, other {#}}'],
    ] as const) {
      expect(diff(a, b).placeholder).toHaveLength(1);
      expect(diff(b, a).placeholder).toHaveLength(1);
    }
  });

  it('classifies argument, select and tag differences separately', () => {
    expect(diff('{name} posted', '{nombre} a publié').placeholder).toHaveLength(2);
    const sel = diff('{g, select, male {a} female {b} other {c}}', '{g, select, male {a} other {c}}');
    expect(sel.select).toHaveLength(1);
    expect(sel.select[0]).toContain('branch "female"');
    expect(sel.placeholder).toEqual([]);
    const tag = diff('<b>{name}</b> joined', '{name} a rejoint');
    expect(tag.tags).toHaveLength(1);
    expect(tag.placeholder).toEqual([]);
    expect(diff('<a href="https://x.test">{n}</a>', '<a href="https://y.test">{n}</a>').tags.length).toBeGreaterThan(0);
  });

  it('reports a renamed plural argument once, not once per descendant', () => {
    const d = diff('{n, plural, one {# {x}} other {# {x}}}', '{m, plural, one {# {x}} other {# {x}}}');
    expect(d.placeholder).toHaveLength(2); // missing {n, plural}, unexpected {m, plural}
  });

  it('does not report reordering of arguments or tags', () => {
    const d = diff('<b>{a}</b> and {b}', '{b} et <b>{a}</b>');
    expect(d).toEqual({ placeholder: [], select: [], tags: [] });
  });

  it('reports a tag that moved to a different argument', () => {
    expect(diff('<b>{a}</b> {b}', '<b>{b}</b> {a}').tags.length).toBeGreaterThan(0);
  });
});

describe('icuDisplayLength', () => {
  it('measures the longest branch, not the sum of branches', () => {
    expect(icuDisplayLength(ast('{n, plural, one {# item} other {# items}}'))).toBe(7);
    expect(icuDisplayLength(ast('<b>Save</b>'))).toBe(4);
  });
});
