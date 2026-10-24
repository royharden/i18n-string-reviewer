import { describe, expect, it } from 'vitest';
import { comparePlaceholders, tokenizePlaceholders } from '../../src/core/l10nchecks/placeholders.ts';
import type { Dialect } from '../../src/core/l10nchecks/types.ts';

const ids = (text: string, dialect: Dialect): string[] => tokenizePlaceholders(text, dialect).tokens.map((t) => t.identity);

describe('tokenizer: printf (plain and i18next)', () => {
  it('recognises indexed, named, ruby and unindexed forms; %% is literal', () => {
    expect(ids('%1$s %2$d %(name)s %{user} %s %5.2f 100%%', 'plain')).toEqual([
      'printf:1$s',
      'printf:2$d',
      'printf:(name)s',
      'ruby:user',
      'printf:s',
      'printf:f',
    ]);
  });

  it('marks only unindexed printf tokens as ordered', () => {
    const toks = tokenizePlaceholders('%1$s %s %(n)d %d', 'plain').tokens;
    expect(toks.map((t) => t.ordered)).toEqual([false, true, false, true]);
  });

  it('does not treat a bare percent sign as a placeholder', () => {
    expect(ids('50% off, 20 % more', 'plain')).toEqual([]);
  });

  it('normalises %i to %d', () => {
    expect(ids('%i', 'plain')).toEqual(['printf:d']);
  });
});

describe('tokenizer: plain braces', () => {
  it('reads {name}, {0} and {name:format}', () => {
    expect(ids('Hi {name}, item {0}, due {date:short}', 'plain')).toEqual(['brace:name', 'brace:0', 'brace:date:short']);
  });
});

describe('tokenizer: i18next', () => {
  it('reads interpolation, formats, unescaped and nesting (longest match first)', () => {
    expect(ids('{{count}} of {{ total , number }} — $t(nav.board) {{- html}}', 'i18next')).toEqual([
      'i18next:count',
      'i18next:total,number',
      '$t:nav.board',
      'i18next:-html',
    ]);
  });

  it('does not read single braces as i18next placeholders', () => {
    expect(ids('{name}', 'i18next')).toEqual([]);
  });

  it('reports an unterminated interpolation', () => {
    const r = tokenizePlaceholders('Hello {{name', 'i18next');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain('unterminated');
  });

  it('handles $t( with options containing parentheses', () => {
    expect(ids('$t(key, {"x": "(a)"}) done', 'i18next')).toEqual(['$t:key']);
  });
});

describe('tokenizer: ICU (from the AST)', () => {
  it('lists arguments with their types', () => {
    expect(ids('{count, plural, one {# item by {name}} other {# items}} {d, date, short}', 'icu')).toEqual([
      'icu:count:plural',
      'icu:name:string',
      'icu:d:date',
    ]);
  });

  it('reports a parse error instead of tokens', () => {
    const r = tokenizePlaceholders('{broken', 'icu');
    expect(r.tokens).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  it('respects apostrophe quoting', () => {
    expect(ids("Liste d'{name}", 'icu')).toEqual([]);
  });
});

describe('comparePlaceholders', () => {
  const cmp = (s: string, t: string, d: Dialect = 'plain') =>
    comparePlaceholders(tokenizePlaceholders(s, d).tokens, tokenizePlaceholders(t, d).tokens);

  it('allows indexed and named placeholders to reorder', () => {
    expect(cmp('%1$s of %2$s', '%2$s sur %1$s').equal).toBe(true);
    expect(cmp('{a} {b}', '{b} {a}').equal).toBe(true);
  });

  it('requires unindexed printf order and types', () => {
    const d = cmp('%s has %d', '%d a %s');
    expect(d.equal).toBe(false);
    expect(d.orderChanged).toBe(true);
    expect(d.missing).toEqual([]);
  });

  it('reports missing and extra as a multiset', () => {
    const d = cmp('{a} {a} {b}', '{a} {c}');
    expect(d.missing.sort()).toEqual(['brace:a', 'brace:b']);
    expect(d.extra).toEqual(['brace:c']);
  });

  it('can ignore a name (i18next plural count)', () => {
    const s = tokenizePlaceholders('One item', 'i18next').tokens;
    const t = tokenizePlaceholders('{{count}} élément', 'i18next').tokens;
    expect(comparePlaceholders(s, t).equal).toBe(false);
    expect(comparePlaceholders(s, t, { ignoreNames: new Set(['count']) }).equal).toBe(true);
  });
});
