import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignSplits,
  fmix32,
  fnv1a32,
  partitionKeys,
  splitForKey,
  splitScore,
  type SplitConfig,
} from '../../src/core/evalkit/split.ts';

interface ManifestFile {
  path: string;
  locale: string;
  dialect: string;
  role: 'source' | 'target';
  corpus: string;
}
interface Manifest {
  seed: number;
  split: { by: string; dev: number; heldout: number; rule: string };
  heldoutFrozenAt: string;
  files: ManifestFile[];
  labels: { semantic: string; semanticCorpus: string };
}
interface Label {
  id: string;
  key: string[];
  locale: string;
  split: 'dev' | 'heldout';
}

const repoRoot = new URL('../../', import.meta.url);
const readText = (rel: string): string => readFileSync(new URL(rel, repoRoot), 'utf8');
const manifest = JSON.parse(readText('fixtures/manifest.json')) as Manifest;
const config: SplitConfig = { seed: manifest.seed, dev: manifest.split.dev };
const labels: Label[] = readText(manifest.labels.semantic)
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Label);

function leafPaths(node: unknown, prefix: string[] = [], out: string[][] = []): string[][] {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) leafPaths(v, [...prefix, k], out);
  } else {
    out.push(prefix);
  }
  return out;
}

const icuFiles = manifest.files.filter((f) => f.corpus === manifest.labels.semanticCorpus);
const sourceFile = icuFiles.find((f) => f.role === 'source');
if (!sourceFile) throw new Error('manifest has no source file for the semantic corpus');
const sourceKeys = leafPaths(JSON.parse(readText(sourceFile.path)));

describe('hash primitives', () => {
  it('FNV-1a 32 matches the published test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('fmix32 is an unsigned 32-bit bijection-style mixer (0 → 0, deterministic, in range)', () => {
    expect(fmix32(0)).toBe(0);
    for (const x of [1, 2, 0xffffffff, 0x811c9dc5]) {
      const y = fmix32(x);
      expect(y).toBe(fmix32(x));
      expect(Number.isInteger(y) && y >= 0 && y <= 0xffffffff).toBe(true);
    }
    expect(fmix32(1)).not.toBe(fmix32(2));
  });
});

describe('split function', () => {
  it('is deterministic for the same key path and seed', () => {
    for (const key of sourceKeys) {
      expect(splitForKey(key, config)).toBe(splitForKey([...key], { ...config }));
      expect(splitScore(key, config.seed)).toBe(splitScore(key, config.seed));
    }
  });

  it('scores lie in [0, 1)', () => {
    for (const key of sourceKeys) {
      const s = splitScore(key, config.seed);
      expect(s >= 0 && s < 1).toBe(true);
    }
  });

  it('depends on the seed (a different seed reassigns some keys)', () => {
    const other: SplitConfig = { seed: manifest.seed + 1, dev: config.dev };
    const moved = sourceKeys.filter((k) => splitForKey(k, config) !== splitForKey(k, other));
    expect(moved.length).toBeGreaterThan(0);
  });

  it('keeps ["a.b"] and ["a","b"] distinct (key path, not dot-joined string)', () => {
    expect(splitScore(['a.b'], 1)).not.toBe(splitScore(['a', 'b'], 1));
  });

  it('rejects bad inputs', () => {
    expect(() => splitScore([], 1)).toThrow(TypeError);
    expect(() => splitForKey(['a'], { seed: 1, dev: 0 })).toThrow(RangeError);
    expect(() => splitForKey(['a'], { seed: 1, dev: 1 })).toThrow(RangeError);
  });

  it('assigns roughly the configured dev fraction of corpus keys', () => {
    const { dev, heldout } = partitionKeys(sourceKeys, config);
    const frac = dev.length / (dev.length + heldout.length);
    expect(frac).toBeGreaterThan(0.45);
    expect(frac).toBeLessThan(0.75);
  });
});

describe('split is by source key, never by locale', () => {
  it('every target locale key gets the split of the same source key', () => {
    const sourceSplit = new Map(sourceKeys.map((k) => [JSON.stringify(k), splitForKey(k, config)]));
    for (const file of icuFiles.filter((f) => f.role === 'target')) {
      const keys = leafPaths(JSON.parse(readText(file.path)));
      expect(keys.length).toBe(sourceKeys.length);
      for (const key of keys) {
        expect(sourceSplit.get(JSON.stringify(key)), `${file.locale} ${key.join('.')}`).toBe(splitForKey(key, config));
      }
    }
  });

  it('no key lands in both splits; together they cover every key', () => {
    const { dev, heldout } = partitionKeys(sourceKeys, config);
    const devIds = new Set(dev.map((k) => JSON.stringify(k)));
    for (const k of heldout) expect(devIds.has(JSON.stringify(k))).toBe(false);
    expect(dev.length + heldout.length).toBe(new Set(sourceKeys.map((k) => JSON.stringify(k))).size);
  });

  it('all labels on the same key share one split', () => {
    const byKey = new Map<string, Set<string>>();
    for (const l of labels) {
      const id = JSON.stringify(l.key);
      const set = byKey.get(id) ?? new Set<string>();
      set.add(l.split);
      byKey.set(id, set);
    }
    for (const [key, splits] of byKey) expect(splits.size, key).toBe(1);
  });
});

describe('semantic labels carry the computed split', () => {
  it('manifest pins the split rule and the freeze date', () => {
    expect(manifest.split.by).toBe('source_key');
    expect(manifest.split.dev).toBe(0.6);
    expect(manifest.split.heldout).toBe(0.4);
    expect(manifest.heldoutFrozenAt).toBe('2026-10-24');
    expect(typeof manifest.seed).toBe('number');
  });

  it("every label's split field equals splitForKey(label.key, manifest)", () => {
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.split, l.id).toBe(splitForKey(l.key, config));
  });

  it('assignSplits reproduces the stored split fields exactly', () => {
    const recomputed = assignSplits(labels, config);
    expect(recomputed.map((l) => l.split)).toEqual(labels.map((l) => l.split));
  });

  it('both splits are non-empty', () => {
    expect(labels.some((l) => l.split === 'dev')).toBe(true);
    expect(labels.some((l) => l.split === 'heldout')).toBe(true);
  });

  it('both "Post" keys are dev under the manifest seed (M3 demo uses dev keys only; see manifest.seedSelection)', () => {
    for (const key of [['feed', 'postButton'], ['feed', 'postHeading']]) {
      expect(sourceKeys.some((k) => JSON.stringify(k) === JSON.stringify(key)), key.join('.')).toBe(true);
      expect(splitForKey(key, config), key.join('.')).toBe('dev');
    }
  });
});
