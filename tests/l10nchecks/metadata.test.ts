import { describe, expect, it } from 'vitest';
import { MAX_FIELD_CHARS, parseContextFile, parseGlossaryFile } from '../../src/core/l10nchecks/metadata.ts';
import { DEFAULT_LIMITS } from '../../src/core/l10nchecks/parse.ts';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import { enc } from './helpers.ts';

const codes = (issues: ReadonlyArray<{ code: string }>): string[] => issues.map((i) => i.code);

describe('context.json', () => {
  it('loads entries keyed by display path (dotted or JSON array)', () => {
    const r = parseContextFile(
      enc('{"nav.post": {"screen": "Feed", "note": "noun", "maxLength": 12}, "[\\"a.b\\"]": {"description": "dotted key"}}'),
      'context.json',
    );
    expect(r.issues).toEqual([]);
    expect(r.rejected).toBe(false);
    expect(r.context.get(pathKey(['nav', 'post']))).toEqual({ screen: 'Feed', note: 'noun', maxLength: 12 });
    expect(r.context.get(pathKey(['a.b']))).toEqual({ description: 'dotted key' });
    expect(r.context.has(pathKey(['a', 'b']))).toBe(false);
  });

  it('reports an invalid key path and keeps the other entries', () => {
    const r = parseContextFile(enc('{"a..b": {"note": "x"}, "ok": {"note": "y"}}'), 'context.json');
    expect(codes(r.issues)).toEqual(['metadata_invalid_path']);
    expect(r.issues[0]?.message).toContain('"a..b"');
    expect(r.context.size).toBe(1);
  });

  it('validates fields with zod and names the entry', () => {
    const long = 'x'.repeat(MAX_FIELD_CHARS + 1);
    const r = parseContextFile(
      enc(JSON.stringify({ neg: { maxLength: -1 }, frac: { maxLength: 1.5 }, long: { note: long }, type: { screen: 3 }, good: { maxLength: 4 } })),
      'context.json',
    );
    const bad = r.issues.filter((i) => i.code === 'metadata_invalid_entry').map((i) => i.path?.[0]);
    expect(bad.sort()).toEqual(['frac', 'long', 'neg', 'type']);
    expect(r.context.get(pathKey(['good']))).toEqual({ maxLength: 4 });
  });

  it('rejects duplicate entries and duplicate fields', () => {
    const r = parseContextFile(enc('{"a": {"note": "1"}, "a": {"note": "2"}, "b": {"note": "x", "note": "y"}}'), 'context.json');
    expect(codes(r.issues)).toEqual(['duplicate_key', 'duplicate_key']);
    expect(r.context.size).toBe(0);
  });

  it('drops unknown fields instead of copying them', () => {
    const r = parseContextFile(enc('{"a": {"note": "n", "__proto__": {"x": 1}, "extra": true}}'), 'context.json');
    const entry = r.context.get(pathKey(['a']));
    expect(entry).toEqual({ note: 'n' });
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('rejects a non-object root, bad JSON and too many entries', () => {
    expect(parseContextFile(enc('[]'), 'c.json').rejected).toBe(true);
    expect(parseContextFile(new Uint8Array([0xff]), 'c.json').rejected).toBe(true);
    const many = parseContextFile(enc('{"a": {}, "b": {}, "c": {}}'), 'c.json', { ...DEFAULT_LIMITS, maxKeys: 2 });
    expect(many.rejected).toBe(true);
    expect(codes(many.issues)).toContain('metadata_too_many_entries');
  });
});

describe('glossary.json', () => {
  it('loads entries; translations become a null-prototype record keyed by canonical locale', () => {
    const r = parseGlossaryFile(
      enc('[{"term": "TaskBoard", "doNotTranslate": true}, {"term": "card", "translations": {"fr": "carte", "PT-br": "cartão"}, "note": "kanban card"}]'),
      'glossary.json',
    );
    expect(r.issues).toEqual([]);
    expect(r.glossary).toHaveLength(2);
    expect(r.glossary[0]).toEqual({ term: 'TaskBoard', doNotTranslate: true });
    const t = r.glossary[1]?.translations;
    expect(t).toBeDefined();
    expect(Object.getPrototypeOf(t)).toBeNull();
    expect(t?.['fr']).toBe('carte');
    expect(t?.['pt-BR']).toBe('cartão');
  });

  it('reports a bad entry by its position and keeps the rest', () => {
    const r = parseGlossaryFile(enc('[{"note": "no term"}, {"term": ""}, {"term": "ok"}]'), 'glossary.json');
    expect(r.issues.map((i) => i.message.slice(0, 17))).toEqual(['glossary entry #1', 'glossary entry #2']);
    expect(r.glossary.map((g) => g.term)).toEqual(['ok']);
  });

  it('ignores an invalid translation locale with a warning (including __proto__)', () => {
    const r = parseGlossaryFile(enc('[{"term": "x", "translations": {"__proto__": "y", "fr": "z"}}]'), 'glossary.json');
    expect(r.issues.map((i) => i.severity)).toEqual(['warning']);
    expect(r.glossary[0]?.translations?.['fr']).toBe('z');
    expect(Object.prototype.hasOwnProperty.call(r.glossary[0]?.translations ?? {}, '__proto__')).toBe(false);
  });

  it('rejects a non-array root and too many entries', () => {
    expect(parseGlossaryFile(enc('{"term": "x"}'), 'g.json').rejected).toBe(true);
    const many = parseGlossaryFile(enc('[{"term":"a"},{"term":"b"},{"term":"c"}]'), 'g.json', { ...DEFAULT_LIMITS, maxKeys: 2 });
    expect(many.rejected).toBe(true);
  });

  it('rejects a duplicated field inside an entry', () => {
    const r = parseGlossaryFile(enc('[{"term": "a", "term": "b"}]'), 'g.json');
    expect(codes(r.issues)).toEqual(['duplicate_key']);
    expect(r.glossary).toEqual([]);
  });
});
