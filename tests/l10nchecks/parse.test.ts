import { describe, expect, it } from 'vitest';
import { parseContextFile } from '../../src/core/l10nchecks/metadata.ts';
import {
  DEFAULT_LIMITS,
  buildValidationReport,
  formatValidationReport,
  maxBracketDepth,
  parseLocale,
} from '../../src/core/l10nchecks/parse.ts';
import type { ParseLocaleOptions } from '../../src/core/l10nchecks/parse.ts';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import { enc } from './helpers.ts';

const opts = (over: Partial<ParseLocaleOptions> = {}): ParseLocaleOptions => ({
  fileName: 'fr.json',
  locale: 'fr',
  dialect: 'icu',
  role: 'target',
  ...over,
});

const codes = (issues: ReadonlyArray<{ code: string }>): string[] => issues.map((i) => i.code);

describe('parseLocale: happy path', () => {
  it('keys nested and flat leaves by segment arrays in a Map', () => {
    const { doc, issues } = parseLocale(enc('{"nav": {"post": "Publier"}, "a.b": "x"}'), opts());
    expect(issues).toEqual([]);
    expect(doc.rejected).toBe(false);
    expect(doc.eligible).toEqual({ review: true, export: true });
    expect(doc.entries).toBeInstanceOf(Map);
    expect(doc.entries.get(pathKey(['nav', 'post']))?.value).toBe('Publier');
    expect(doc.entries.get(pathKey(['a.b']))?.value).toBe('x');
    expect(doc.entries.has(pathKey(['a', 'b']))).toBe(false);
  });

  it('records value offsets into the decoded text (for patching)', () => {
    const { doc } = parseLocale(enc('{"a": "bé"}'), opts());
    const e = doc.entries.get(pathKey(['a']));
    expect(e).toBeDefined();
    expect(doc.text.slice(e!.offset, e!.offset + e!.length)).toBe('"bé"');
  });

  it('canonicalises the confirmed locale', () => {
    const { doc } = parseLocale(enc('{}'), opts({ locale: 'EN-us' }));
    expect(doc.locale).toBe('en-US');
  });

  it('retains empty/nested containers separately without changing leaf caps or value offsets', () => {
    const text = '{"empty":{},"nav":{"empty":{},"title":"bé"}}';
    const { doc, issues } = parseLocale(enc(text), opts({ limits: { ...DEFAULT_LIMITS, maxKeys: 1 } }));
    expect(issues).toEqual([]);
    expect(doc.containers).toBeInstanceOf(Map);
    expect([...doc.containers!.keys()]).toEqual([pathKey(['empty']), pathKey(['nav']), pathKey(['nav', 'empty'])]);
    expect(doc.entries.size).toBe(1);
    const leaf = doc.entries.get(pathKey(['nav', 'title']))!;
    expect(doc.text.slice(leaf.offset, leaf.offset + leaf.length)).toBe('"bé"');
    expect(doc.containers?.has(pathKey(['nav', 'title']))).toBe(false);
    const rejected = parseLocale(enc('{"empty":{},"a":"A","b":"B"}'), opts({ limits: { ...DEFAULT_LIMITS, maxKeys: 1 } }));
    expect(rejected.doc.rejected).toBe(true);
    expect(rejected.doc.entries.size).toBe(0);
    expect(rejected.doc.containers?.size).toBe(0);
  });
});

describe('parseLocale: encoding and caps', () => {
  it('strips and records a UTF-8 BOM; offsets refer to the stripped text', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":"b"}')]);
    const { doc, issues } = parseLocale(bytes, opts());
    expect(doc.bom).toBe(true);
    expect(doc.text).toBe('{"a":"b"}');
    expect(codes(issues)).toEqual(['bom_stripped']);
    expect(issues[0]?.severity).toBe('info');
    const e = doc.entries.get(pathKey(['a']))!;
    expect(doc.text.slice(e.offset, e.offset + e.length)).toBe('"b"');
  });

  it('rejects malformed UTF-8 (fatal decoder)', () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    const { doc, issues } = parseLocale(bytes, opts());
    expect(doc.rejected).toBe(true);
    expect(doc.entries.size).toBe(0);
    expect(codes(issues)).toContain('invalid_utf8');
  });

  it('rejects files over 2 MB before decoding', () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x20);
    const { doc, issues } = parseLocale(bytes, opts());
    expect(doc.rejected).toBe(true);
    expect(codes(issues)).toEqual(['file_too_large']);
  });

  it('accepts depth 32 and rejects depth 33', () => {
    const nest = (n: number): string => `${'{"k":'.repeat(n)}"v"${'}'.repeat(n)}`;
    expect(maxBracketDepth(nest(32))).toBe(32);
    const ok = parseLocale(enc(nest(32)), opts());
    expect(ok.doc.rejected).toBe(false);
    expect([...ok.doc.entries.values()][0]?.path.length).toBe(32);
    const deep = parseLocale(enc(nest(33)), opts());
    expect(deep.doc.rejected).toBe(true);
    expect(codes(deep.issues)).toContain('too_deep');
  });

  it('ignores brackets inside strings when measuring depth', () => {
    expect(maxBracketDepth('{"a": "[[[[{{{{\\"]]"}')).toBe(1);
  });

  it('rejects more than 5,000 keys', () => {
    const obj = (n: number): string => `{${Array.from({ length: n }, (_, i) => `"k${i}":"v"`).join(',')}}`;
    expect(parseLocale(enc(obj(5000)), opts()).doc.rejected).toBe(false);
    const big = parseLocale(enc(obj(5001)), opts());
    expect(big.doc.rejected).toBe(true);
    expect(codes(big.issues)).toContain('too_many_keys');
  });

  it('honours custom limits', () => {
    const r = parseLocale(enc('{"a":"1","b":"2","c":"3","d":"4"}'), opts({ limits: { ...DEFAULT_LIMITS, maxKeys: 3 } }));
    expect(r.doc.rejected).toBe(true);
  });
});

describe('parseLocale: strict JSON', () => {
  it('reports comments as syntax errors and makes the file ineligible', () => {
    const { doc, issues } = parseLocale(enc('{"a": "x" /* note */}'), opts());
    expect(codes(issues)).toContain('json_syntax');
    expect(doc.rejected).toBe(false);
    expect(doc.eligible).toEqual({ review: false, export: false });
    expect(doc.entries.get(pathKey(['a']))?.value).toBe('x');
  });

  it('reports trailing commas as syntax errors', () => {
    const { doc, issues } = parseLocale(enc('{"a": "x",}'), opts());
    expect(codes(issues)).toContain('json_syntax');
    expect(issues.find((i) => i.code === 'json_syntax')?.message).toMatch(/line 1, column \d+/);
    expect(doc.eligible.export).toBe(false);
  });

  it('rejects a top-level value that is not an object', () => {
    const { doc, issues } = parseLocale(enc('["a"]'), opts());
    expect(doc.rejected).toBe(true);
    expect(codes(issues)).toContain('not_an_object');
  });

  it('duplicate key → error naming the path, all occurrences dropped, file ineligible', () => {
    const { doc, issues } = parseLocale(enc('{"nav": {"post": "A", "post": "B", "ok": "OK"}}'), opts());
    const dup = issues.find((i) => i.code === 'duplicate_key');
    expect(dup?.path).toEqual(['nav', 'post']);
    expect(dup?.message).toContain('nav.post');
    expect(doc.entries.has(pathKey(['nav', 'post']))).toBe(false);
    expect(doc.entries.get(pathKey(['nav', 'ok']))?.value).toBe('OK');
    expect(doc.eligible).toEqual({ review: false, export: false });
    expect(doc.rejected).toBe(false);
  });

  it('does not expose duplicate containers or their descendants as usable structural data', () => {
    const { doc, issues } = parseLocale(enc('{"a":{"nested":{}},"a":{},"ok":{}}'), opts());
    expect(codes(issues)).toContain('duplicate_key');
    expect([...doc.containers!.keys()]).toEqual([pathKey(['ok'])]);
    expect(doc.eligible).toEqual({ review: false, export: false });
  });

  it('does not use containers from a partial syntax-error tree', () => {
    const { doc, issues } = parseLocale(enc('{"empty":{},}'), opts());
    expect(codes(issues)).toContain('json_syntax');
    expect(doc.containers?.size).toBe(0);
    expect(doc.eligible).toEqual({ review: false, export: false });
  });
});

describe('parseLocale: keys are data', () => {
  it('treats __proto__ as an ordinary key and never touches Object.prototype', () => {
    const { doc, issues } = parseLocale(enc('{"__proto__": "x", "a": {"__proto__": {"polluted": "yes"}}}'), opts());
    expect(issues).toEqual([]);
    expect(doc.entries.get(pathKey(['__proto__']))?.value).toBe('x');
    expect(doc.entries.get(pathKey(['a', '__proto__', 'polluted']))?.value).toBe('yes');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps a dotted key and a nested path distinct', () => {
    const { doc, issues } = parseLocale(enc('{"a.b": "flat", "c": {"d": "nested"}}'), opts());
    expect(issues).toEqual([]);
    expect(doc.entries.get(pathKey(['a.b']))?.value).toBe('flat');
    expect(doc.entries.get(pathKey(['c', 'd']))?.value).toBe('nested');
  });

  it('keeps literal dotted container paths segment-keyed and excludes same-file path ambiguity', () => {
    const distinct = parseLocale(enc('{"a.b":{},"a":{"c":{}}}'), opts());
    expect(distinct.issues).toEqual([]);
    expect(distinct.doc.containers?.get(pathKey(['a.b']))).toEqual(['a.b']);
    expect(distinct.doc.containers?.has(pathKey(['a', 'b']))).toBe(false);
    const ambiguous = parseLocale(enc('{"a.b":{"child":{}},"a":{"b":{}}}'), opts());
    expect(codes(ambiguous.issues)).toContain('path_conflict');
    expect(ambiguous.doc.containers?.has(pathKey(['a.b']))).toBe(false);
    expect(ambiguous.doc.containers?.has(pathKey(['a.b', 'child']))).toBe(false);
    expect(ambiguous.doc.containers?.has(pathKey(['a', 'b']))).toBe(false);
    expect(ambiguous.doc.eligible).toEqual({ review: false, export: false });
  });

  it('flags a dotted key that collides with a nested path when split on "."', () => {
    const { doc, issues } = parseLocale(enc('{"a.b": "flat", "a": {"b": "nested"}}'), opts());
    expect(doc.entries.size).toBe(2);
    const conflict = issues.find((i) => i.code === 'path_conflict');
    expect(conflict?.message).toContain('["a.b"]');
    expect(conflict?.message).toContain('a.b');
    expect(doc.eligible).toEqual({ review: false, export: false });
  });

  it('source non-string leaves are import issues; target ones are kept for type_mismatch', () => {
    const src = parseLocale(enc('{"n": 5, "s": "ok"}'), opts({ role: 'source', locale: 'en' }));
    expect(codes(src.issues)).toEqual(['non_string_leaf']);
    expect(src.issues[0]?.path).toEqual(['n']);
    expect(src.doc.eligible.review).toBe(true);
    const tgt = parseLocale(enc('{"n": 5}'), opts());
    expect(tgt.issues).toEqual([]);
    expect(tgt.doc.entries.get(pathKey(['n']))).toMatchObject({ kind: 'other', valueType: 'number', value: 5 });
  });

  it('copies array leaves with null-prototype objects', () => {
    const { doc } = parseLocale(enc('{"arr": [{"__proto__": 1}]}'), opts());
    const e = doc.entries.get(pathKey(['arr']))!;
    expect(e.valueType).toBe('array');
    const first = (e.value as unknown[])[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(first, '__proto__')).toBe(true);
  });
});

describe('parseLocale: locale validation', () => {
  it('rejects a locale Intl.PluralRules does not support (no silent fallback)', () => {
    const { doc, issues } = parseLocale(enc('{"a": "b"}'), opts({ locale: 'xx' }));
    expect(doc.rejected).toBe(true);
    expect(codes(issues)).toContain('unsupported_locale');
  });

  it('rejects a malformed tag', () => {
    const { doc, issues } = parseLocale(enc('{"a": "b"}'), opts({ locale: 'not a locale!' }));
    expect(doc.rejected).toBe(true);
    expect(codes(issues)).toContain('invalid_locale');
  });
});

describe('validation report', () => {
  it('names every unparseable file, key and metadata entry', () => {
    const broken = parseLocale(enc('{"nav": {"post": "A", "post": "B"}, "x": "y",}'), opts({ fileName: 'fr-broken.json' }));
    const bad = parseLocale(new Uint8Array([0x7b, 0xff, 0x7d]), opts({ fileName: 'bad.json' }));
    const ctx = parseContextFile(enc('{"a..b": {"note": "x"}, "ok": {"maxLength": -1}}'), 'context.json');
    const report = buildValidationReport([
      {
        fileName: 'fr-broken.json',
        kind: 'locale',
        role: 'target',
        locale: broken.doc.locale,
        issues: broken.issues,
        rejected: broken.doc.rejected,
        eligible: broken.doc.eligible.export,
      },
      { fileName: 'bad.json', kind: 'locale', role: 'target', locale: 'fr', issues: bad.issues, rejected: bad.doc.rejected, eligible: false },
      { fileName: 'context.json', kind: 'context', issues: ctx.issues, rejected: ctx.rejected },
    ]);
    expect(report.files.map((f) => f.status)).toEqual(['ineligible', 'rejected', 'warnings']);
    const text = formatValidationReport(report);
    expect(text).toContain('fr-broken.json');
    expect(text).toContain('INELIGIBLE');
    expect(text).toContain('duplicate_key [nav.post]');
    expect(text).toContain('json_syntax');
    expect(text).toContain('bad.json');
    expect(text).toContain('REJECTED');
    expect(text).toContain('invalid_utf8');
    expect(text).toContain('metadata_invalid_path');
    expect(text).toContain('"a..b"');
    expect(text).toContain('metadata_invalid_entry [ok]');
    expect(report.errorCount).toBeGreaterThanOrEqual(5);
  });
});
