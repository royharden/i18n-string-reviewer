// Shape checks for the M2 evaluation fixtures (PLAN §4 M2 acceptance). Pure file inspection:
// no l10nchecks code is involved, so these hold even before the rule engine exists.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface ManifestFile {
  path: string;
  locale: string;
  dialect: string;
  role: 'source' | 'target';
  corpus: string;
}
interface Manifest {
  seed: number;
  files: ManifestFile[];
  context: string;
  glossary: string;
  labels: { semantic: string; semanticCorpus: string };
  split: { by: string; dev: number; heldout: number; rule: string };
  seedSelection: {
    date: string;
    selectedSeed: number;
    seedsTried: { loggedSeedBySeed: boolean; knownWindow: [number, number]; conservativeEnvelope: [number, number] };
    criteriaUsed: string[];
    notLookedAt: string;
  };
  heldoutFrozenAt: string;
  freeze: string;
  license: string;
  authorship: string;
}
interface ContextEntry {
  screen?: string;
  note?: string;
  description?: string;
  maxLength?: number;
}
interface Label {
  id: string;
  key: string[];
  locale: string;
  category: string;
  severity: string;
  contextDependent: boolean;
  plantedTarget: string;
  what_bug_this_catches: string;
  author: string;
  split: string;
}

const repoRoot = new URL('../../', import.meta.url);
const readText = (rel: string): string => readFileSync(new URL(rel, repoRoot), 'utf8');
const readJson = (rel: string): unknown => JSON.parse(readText(rel));
const manifest = readJson('fixtures/manifest.json') as Manifest;

function leaves(node: unknown, prefix: string[] = [], out = new Map<string, unknown>()): Map<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) leaves(v, [...prefix, k], out);
  } else {
    out.set(JSON.stringify(prefix), node);
  }
  return out;
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/** i18next: group plural-suffix families under their base key. */
function baseKeys(keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const k of keys) {
    const path = JSON.parse(k) as string[];
    const last = path[path.length - 1] ?? '';
    out.add(JSON.stringify([...path.slice(0, -1), last.replace(PLURAL_SUFFIX, '')]));
  }
  return out;
}

/** Branch selectors of every top-level `{arg, plural|selectordinal, ...}` block, per block. */
function pluralBlocks(text: string): Array<{ type: string; selectors: string[] }> {
  const blocks: Array<{ type: string; selectors: string[] }> = [];
  const re = /\{\s*\w+\s*,\s*(plural|selectordinal)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index + m[0].length;
    const selectors: string[] = [];
    for (;;) {
      while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] === '}' || i >= text.length) break;
      const start = i;
      while (i < text.length && !/[\s{]/.test(text[i] ?? '')) i++;
      selectors.push(text.slice(start, i));
      while (/\s/.test(text[i] ?? '')) i++;
      let depth = 0;
      do {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
      } while (depth > 0 && i < text.length);
    }
    blocks.push({ type: m[1] ?? '', selectors });
  }
  return blocks;
}

describe('manifest', () => {
  it('declares seed, split rule, freeze date and licence', () => {
    expect(Number.isInteger(manifest.seed)).toBe(true);
    expect(manifest.split).toMatchObject({ by: 'source_key', dev: 0.6, heldout: 0.4 });
    expect(manifest.split.rule.length).toBeGreaterThan(0);
    expect(manifest.heldoutFrozenAt).toBe('2026-10-24');
    expect(manifest.freeze).toContain('before any reviewer, prompt or threshold exists');
    expect(manifest.license).toBe('MIT');
    expect(manifest.authorship).toMatch(/agent-authored/);
  });

  it('discloses how the seed was selected (range, criteria, nothing model- or rule-derived)', () => {
    const sel = manifest.seedSelection;
    expect(sel.date).toBe('2026-10-24');
    expect(sel.selectedSeed).toBe(manifest.seed);
    const [lo, hi] = sel.seedsTried.conservativeEnvelope;
    expect(lo <= manifest.seed && manifest.seed <= hi).toBe(true);
    expect(sel.criteriaUsed.length).toBeGreaterThanOrEqual(2);
    expect(sel.criteriaUsed.join(' ')).toContain('feed.postButton');
    expect(sel.criteriaUsed.join(' ')).toContain('feed.postHeading');
    expect(sel.notLookedAt).toContain('never at any model or rule result');
    expect(manifest.freeze).toContain('seedSelection');
  });

  it('pins locale and dialect for every file, and every file parses', () => {
    for (const f of manifest.files) {
      expect(f.locale.length).toBeGreaterThan(0);
      expect(['icu', 'i18next', 'plain']).toContain(f.dialect);
      expect(() => readJson(f.path)).not.toThrow();
    }
    expect(() => readJson(manifest.context)).not.toThrow();
    expect(() => readJson(manifest.glossary)).not.toThrow();
  });
});

describe('ICU corpus', () => {
  const files = manifest.files.filter((f) => f.corpus === 'taskboard-icu');
  const source = files.find((f) => f.role === 'source');
  if (!source) throw new Error('no ICU source');
  const en = leaves(readJson(source.path));

  it('has 90–110 English leaf keys', () => {
    expect(en.size).toBeGreaterThanOrEqual(90);
    expect(en.size).toBeLessThanOrEqual(110);
  });

  it.each(files.filter((f) => f.role === 'target').map((f): [string, ManifestFile] => [f.locale, f]))(
    '%s has exactly the source key set and the locale plural categories',
    (locale, file) => {
      const t = leaves(readJson(file.path));
      expect([...t.keys()].sort()).toEqual([...en.keys()].sort());
      const cardinal = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.slice().sort();
      const ordinal = new Intl.PluralRules(locale, { type: 'ordinal' }).resolvedOptions().pluralCategories.slice().sort();
      for (const [key, value] of t) {
        expect(typeof value, key).toBe('string');
        expect((value as string).trim().length, key).toBeGreaterThan(0);
        for (const block of pluralBlocks(value as string)) {
          const cats = block.selectors.filter((s) => !s.startsWith('=')).sort();
          expect(cats, `${locale} ${key}`).toEqual(block.type === 'plural' ? cardinal : ordinal);
        }
      }
    },
  );

  it('ru, ar and ja plurals use their CLDR category sets', () => {
    const cats = (file: string): string[] => {
      const out = new Set<string>();
      for (const v of leaves(readJson(file)).values())
        for (const b of pluralBlocks(v as string)) if (b.type === 'plural') b.selectors.forEach((s) => out.add(s));
      return [...out].filter((s) => !s.startsWith('=')).sort();
    };
    expect(cats('fixtures/corpus/ru.json')).toEqual(['few', 'many', 'one', 'other']);
    expect(cats('fixtures/corpus/ar.json')).toEqual(['few', 'many', 'one', 'other', 'two', 'zero']);
    expect(cats('fixtures/corpus/ja.json')).toEqual(['other']);
  });
});

describe('i18next corpus', () => {
  const files = manifest.files.filter((f) => f.corpus === 'taskboard-i18next');
  const source = files.find((f) => f.role === 'source');
  if (!source) throw new Error('no i18next source');
  const enBases = baseKeys(leaves(readJson(source.path)).keys());

  it.each(files.filter((f) => f.role === 'target').map((f): [string, ManifestFile] => [f.locale, f]))(
    '%s has the source key set modulo plural-suffix families',
    (_locale, file) => {
      expect([...baseKeys(leaves(readJson(file.path)).keys())].sort()).toEqual([...enBases].sort());
    },
  );
});

describe('semantic labels', () => {
  const labels = readText(manifest.labels.semantic)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Label);
  const corpusFiles = manifest.files.filter((f) => f.corpus === manifest.labels.semanticCorpus);
  const byLocale = new Map(corpusFiles.map((f) => [f.locale, leaves(readJson(f.path))]));

  it('has at least 55 labels, at least 30 context-dependent', () => {
    expect(labels.length).toBeGreaterThanOrEqual(55);
    expect(labels.filter((l) => l.contextDependent).length).toBeGreaterThanOrEqual(30);
  });

  it('every label is complete and points at a real target string it changes', () => {
    const ids = new Set<string>();
    for (const l of labels) {
      expect(ids.has(l.id), l.id).toBe(false);
      ids.add(l.id);
      expect(['accuracy', 'fluency', 'terminology', 'style', 'context_mismatch']).toContain(l.category);
      expect(['minor', 'major', 'critical']).toContain(l.severity);
      expect(typeof l.contextDependent).toBe('boolean');
      expect(l.what_bug_this_catches.trim().length, l.id).toBeGreaterThan(0);
      expect(l.author.length).toBeGreaterThan(0);
      expect(['dev', 'heldout']).toContain(l.split);
      expect(l.locale).not.toBe('en');
      const clean = byLocale.get(l.locale)?.get(JSON.stringify(l.key));
      expect(typeof clean, `${l.id} key`).toBe('string');
      expect(l.plantedTarget, l.id).not.toBe(clean);
    }
  });

  it('covers fr, ru, ar and ja', () => {
    expect(new Set(labels.map((l) => l.locale))).toEqual(new Set(['fr', 'ru', 'ar', 'ja']));
  });

  it('every context-dependent label has a context.json entry whose maxLength admits clean and planted targets', () => {
    // A context-dependent label is only scoreable if the reviewer can be given the context that
    // disambiguates it; context.json is keyed by the dot-joined display key path.
    const context = readJson(manifest.context) as Record<string, ContextEntry>;
    const contextDependent = labels.filter((l) => l.contextDependent);
    expect(contextDependent.length).toBeGreaterThanOrEqual(30);
    const codePoints = (s: string): number => [...s].length;
    for (const l of contextDependent) {
      const display = l.key.join('.');
      expect(Object.hasOwn(context, display), `${l.id}: no context.json entry for ${display}`).toBe(true);
      const entry = context[display] ?? {};
      expect(`${entry.note ?? ''}${entry.description ?? ''}`.trim().length, `${l.id} context text`).toBeGreaterThan(0);
      if (entry.maxLength === undefined) continue;
      // The planted error must be semantic only: it must not also trip length_risk via maxLength.
      expect(codePoints(l.plantedTarget), `${l.id} planted vs maxLength`).toBeLessThanOrEqual(entry.maxLength);
      for (const [locale, leafMap] of byLocale) {
        const clean = leafMap.get(JSON.stringify(l.key));
        if (typeof clean !== 'string') continue;
        expect(codePoints(clean), `${locale} ${display} clean vs maxLength`).toBeLessThanOrEqual(entry.maxLength);
      }
    }
  });
});
