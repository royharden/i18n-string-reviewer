import { describe, expect, it } from 'vitest';
import { buildTagTree, canonicalTagForm, compareTagTrees, scanTags } from '../../src/core/l10nchecks/tags.ts';

const same = (a: string, b: string): boolean => compareTagTrees(buildTagTree(a), buildTagTree(b)).equal;

describe('scanTags', () => {
  it('finds open, close and self-closing tags, including numeric and attribute forms', () => {
    const toks = scanTags('<b>x</b> <a href="/h" target=_blank>y</a> <br/> <0>z</0>');
    expect(toks.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'open:b',
      'close:b',
      'open:a',
      'close:a',
      'self:br',
      'open:0',
      'close:0',
    ]);
    expect(toks[2]?.attrs).toEqual([
      { name: 'href', value: '/h' },
      { name: 'target', value: '_blank' },
    ]);
  });

  it('ignores text that only looks like markup', () => {
    expect(scanTags('a < b and 3<4, <<not a tag')).toEqual([]);
  });
});

describe('buildTagTree', () => {
  it('builds nesting and reports no errors for balanced markup', () => {
    const tree = buildTagTree('<b><i>x</i></b>');
    expect(tree.errors).toEqual([]);
    expect(canonicalTagForm(tree.children)).toBe('(<b>(<i>))');
  });

  it('reports unclosed and stray closing tags', () => {
    expect(buildTagTree('<b>bold').errors.map((e) => e.kind)).toEqual(['unclosed']);
    expect(buildTagTree('text</i>').errors.map((e) => e.kind)).toEqual(['stray_close']);
    expect(buildTagTree('<b><i>x</b>').errors.map((e) => e.kind)).toEqual(['unclosed']);
  });

  it('treats <br> as void but <link>…</link> as a normal pair', () => {
    expect(buildTagTree('a<br>b').errors).toEqual([]);
    expect(buildTagTree('<link>Sign in</link>').errors).toEqual([]);
  });
});

describe('compareTagTrees', () => {
  it('treats <br> and <br/> as the same tag', () => {
    expect(same('a<br>b', 'a<br/>b')).toBe(true);
  });

  it('lets sibling order change', () => {
    expect(same('<b>Name</b> and <i>date</i>', '<i>date</i> et <b>nom</b>')).toBe(true);
  });

  it('detects nesting changes', () => {
    expect(same('<b><i>x</i></b>', '<b>x</b><i>y</i>')).toBe(false);
  });

  it('compares href/src values exactly and other attributes by name only', () => {
    expect(same('<a href="/help">Help</a>', '<a href="/aide">Aide</a>')).toBe(false);
    expect(same('<img src="a.png">', '<img src="b.png">')).toBe(false);
    expect(same('<span class="x">a</span>', '<span class="y">b</span>')).toBe(true);
    expect(same('<span class="x">a</span>', '<span id="x">b</span>')).toBe(false);
  });

  it('detects a dropped or renamed tag', () => {
    expect(same('<0>{{name}}</0> joined', '{{name}} a rejoint')).toBe(false);
    expect(same('<b>x</b>', '<strong>x</strong>')).toBe(false);
  });
});
