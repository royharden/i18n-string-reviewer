// Dialect-aware placeholder tokenizer (PLAN §3.2 "Placeholders").
//
//   icu      arguments from the formatjs AST ({name}, {n, number}, plural/select selectors)
//   i18next  {{name}}, {{name, format}}, {{- name}}, $t(key) — plus printf tokens
//   plain    {name}, {0}, {name:format} — plus printf tokens
//   printf   %s %d %f %1$s %(name)s %{name}; `%%` is a literal percent sign
//
// Longest match first at every position; escapes respected (`%%`; ICU quoting is the parser's).
// Named and indexed placeholders may be reordered freely; unindexed printf placeholders must keep
// their consumption order and conversion types. Everything else is compared as a multiset.

import type { Dialect } from './types.ts';
import { icuArguments, parseIcu } from './icu.ts';

export type PlaceholderKind =
  | 'icu'
  | 'printf'
  | 'printf_indexed'
  | 'printf_named'
  | 'ruby'
  | 'i18next'
  | 'i18next_nesting'
  | 'brace';

export interface PlaceholderToken {
  readonly kind: PlaceholderKind;
  /** Variable name, index or nested key; '' for unindexed printf. */
  readonly name: string;
  /** Conversion / format / ICU type ('' when none). */
  readonly format: string;
  /** True for unindexed printf tokens, whose order is significant. */
  readonly ordered: boolean;
  /** Comparison identity (kind + name + type). */
  readonly identity: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export interface PlaceholderScanError {
  readonly offset: number;
  readonly message: string;
}

export interface PlaceholderScan {
  readonly tokens: readonly PlaceholderToken[];
  readonly errors: readonly PlaceholderScanError[];
}

const CONV = '[sdiufFeEgGxXoaAcp@]';
const PRINTF_INDEXED = new RegExp(`%(\\d+)\\$[-+0#]*\\d*(?:\\.\\d+)?(${CONV})`, 'uy');
const PRINTF_NAMED = new RegExp(`%\\(([^()\\s]+)\\)[-+0#]*\\d*(?:\\.\\d+)?(${CONV}|r)`, 'uy');
const PRINTF_PLAIN = new RegExp(`%[-+0#]*\\d*(?:\\.\\d+)?(${CONV})`, 'uy');
const RUBY = /%\{([A-Za-z_][\w.]*)\}/uy;
const BRACE = /\{([A-Za-z_][\w.-]*|\d+)(?:\s*[,:]\s*([^{}]*?))?\s*\}/uy;

function normConv(conv: string): string {
  return conv === 'i' ? 'd' : conv;
}

function tok(
  kind: PlaceholderKind,
  name: string,
  format: string,
  ordered: boolean,
  identity: string,
  text: string,
  start: number,
  end: number,
): PlaceholderToken {
  return { kind, name, format, ordered, identity, raw: text.slice(start, end), start, end };
}

/** printf family at `i`, or null. `%%` returns a sentinel with kind 'printf' and name '%'. */
function matchPrintf(text: string, i: number): PlaceholderToken | 'percent' | null {
  if (text[i] !== '%') return null;
  if (text[i + 1] === '%') return 'percent';
  PRINTF_INDEXED.lastIndex = i;
  let m = PRINTF_INDEXED.exec(text);
  if (m) {
    const conv = normConv(m[2] ?? '');
    return tok('printf_indexed', m[1] ?? '', conv, false, `printf:${m[1]}$${conv}`, text, i, PRINTF_INDEXED.lastIndex);
  }
  PRINTF_NAMED.lastIndex = i;
  m = PRINTF_NAMED.exec(text);
  if (m) {
    const conv = normConv(m[2] ?? '');
    return tok('printf_named', m[1] ?? '', conv, false, `printf:(${m[1]})${conv}`, text, i, PRINTF_NAMED.lastIndex);
  }
  RUBY.lastIndex = i;
  m = RUBY.exec(text);
  if (m) return tok('ruby', m[1] ?? '', '', false, `ruby:${m[1]}`, text, i, RUBY.lastIndex);
  PRINTF_PLAIN.lastIndex = i;
  m = PRINTF_PLAIN.exec(text);
  if (m) {
    const conv = normConv(m[1] ?? '');
    return tok('printf', '', conv, true, `printf:${conv}`, text, i, PRINTF_PLAIN.lastIndex);
  }
  return null;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function scanI18next(text: string): PlaceholderScan {
  const tokens: PlaceholderToken[] = [];
  const errors: PlaceholderScanError[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      if (close === -1) {
        errors.push({ offset: i, message: 'unterminated "{{" interpolation' });
        i += 2;
        continue;
      }
      let inner = text.slice(i + 2, close).trim();
      const unescaped = inner.startsWith('-');
      if (unescaped) inner = inner.slice(1).trim();
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const format = comma === -1 ? '' : inner.slice(comma + 1).replace(/\s+/gu, ' ').trim();
      if (name.length === 0) {
        errors.push({ offset: i, message: 'empty "{{}}" interpolation' });
      } else {
        const identity = `i18next:${unescaped ? '-' : ''}${name}${format ? `,${format}` : ''}`;
        tokens.push(tok('i18next', name, format, false, identity, text, i, close + 2));
      }
      i = close + 2;
      continue;
    }
    if (text.startsWith('$t(', i)) {
      const close = matchParen(text, i + 2);
      if (close === -1) {
        errors.push({ offset: i, message: 'unterminated "$t(" nesting' });
        i += 3;
        continue;
      }
      const inner = text.slice(i + 3, close);
      const comma = inner.indexOf(',');
      const key = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      tokens.push(tok('i18next_nesting', key, '', false, `$t:${key}`, text, i, close + 1));
      i = close + 1;
      continue;
    }
    const p = matchPrintf(text, i);
    if (p === 'percent') {
      i += 2;
      continue;
    }
    if (p) {
      tokens.push(p);
      i = p.end;
      continue;
    }
    i++;
  }
  return { tokens, errors };
}

function scanPlain(text: string): PlaceholderScan {
  const tokens: PlaceholderToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') {
      BRACE.lastIndex = i;
      const m = BRACE.exec(text);
      if (m) {
        const name = m[1] ?? '';
        const format = (m[2] ?? '').trim();
        tokens.push(tok('brace', name, format, false, `brace:${name}${format ? `:${format}` : ''}`, text, i, BRACE.lastIndex));
        i = BRACE.lastIndex;
        continue;
      }
    } else if (c === '%') {
      const p = matchPrintf(text, i);
      if (p === 'percent') {
        i += 2;
        continue;
      }
      if (p) {
        tokens.push(p);
        i = p.end;
        continue;
      }
    }
    i++;
  }
  return { tokens, errors: [] };
}

function scanIcu(text: string): PlaceholderScan {
  const parsed = parseIcu(text);
  if (!parsed.ok) return { tokens: [], errors: [{ offset: parsed.error.offset, message: parsed.error.message }] };
  const tokens = icuArguments(parsed.ast).map((a) =>
    tok('icu', a.name, a.type, false, `icu:${a.name}:${a.type}`, text, a.start, a.end),
  );
  return { tokens, errors: [] };
}

export function tokenizePlaceholders(text: string, dialect: Dialect): PlaceholderScan {
  switch (dialect) {
    case 'icu':
      return scanIcu(text);
    case 'i18next':
      return scanI18next(text);
    case 'plain':
      return scanPlain(text);
  }
}

export interface PlaceholderDiff {
  readonly equal: boolean;
  /** Identities in the source but not the target (multiset difference). */
  readonly missing: readonly string[];
  /** Identities in the target but not the source (multiset difference). */
  readonly extra: readonly string[];
  /** Unindexed printf tokens present in equal numbers but in a different order or with swapped types. */
  readonly orderChanged: boolean;
  readonly sourceOrder: readonly string[];
  readonly targetOrder: readonly string[];
}

function multisetDiff(a: readonly string[], b: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = counts.get(x) ?? 0;
    if (n > 0) counts.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

export interface CompareOptions {
  /** Names to ignore on both sides (e.g. i18next `count` inside a plural family, like ICU `#`). */
  readonly ignoreNames?: ReadonlySet<string>;
}

export function comparePlaceholders(
  source: readonly PlaceholderToken[],
  target: readonly PlaceholderToken[],
  opts: CompareOptions = {},
): PlaceholderDiff {
  const keep = (t: PlaceholderToken): boolean => !(t.kind === 'i18next' && opts.ignoreNames?.has(t.name) === true);
  const s = source.filter(keep);
  const t = target.filter(keep);
  const sFree = s.filter((x) => !x.ordered).map((x) => x.identity);
  const tFree = t.filter((x) => !x.ordered).map((x) => x.identity);
  const sOrder = s.filter((x) => x.ordered).map((x) => x.identity);
  const tOrder = t.filter((x) => x.ordered).map((x) => x.identity);
  const missing = [...multisetDiff(sFree, tFree), ...multisetDiff(sOrder, tOrder)];
  const extra = [...multisetDiff(tFree, sFree), ...multisetDiff(tOrder, sOrder)];
  const sameOrderedMultiset = multisetDiff(sOrder, tOrder).length === 0 && multisetDiff(tOrder, sOrder).length === 0;
  const orderChanged = sameOrderedMultiset && sOrder.some((x, i) => x !== tOrder[i]);
  return {
    equal: missing.length === 0 && extra.length === 0 && !orderChanged,
    missing,
    extra,
    orderChanged,
    sourceOrder: sOrder,
    targetOrder: tOrder,
  };
}

/** Human summary of a placeholder diff for finding messages. */
export function describePlaceholderDiff(d: PlaceholderDiff): string {
  const parts: string[] = [];
  if (d.missing.length > 0) parts.push(`missing ${d.missing.join(', ')}`);
  if (d.extra.length > 0) parts.push(`unexpected ${d.extra.join(', ')}`);
  if (d.orderChanged) {
    parts.push(`unindexed printf order changed (${d.sourceOrder.join(' ')} → ${d.targetOrder.join(' ')}); use indexed %1$s forms to reorder`);
  }
  return parts.join('; ');
}
