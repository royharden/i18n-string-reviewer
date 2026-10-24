// Deterministic dev / held-out split by SOURCE KEY (never by locale).
//
// Rule (also written in fixtures/manifest.json `split.rule`):
//   score = fmix32( FNV-1a-32( JSON.stringify(keyPath) + "\u0000" + String(seed) ) ) / 2^32
//   split = score < devFraction ? "dev" : "heldout"
//
// FNV-1a alone mixes trailing characters poorly (seeds 20261060 and 20261061 would give almost
// the same split, because a one-unit change in the last code unit moves the top bits by ~0.4 %),
// so the MurmurHash3 32-bit finaliser (fmix32) is applied for avalanche. The hash runs over
// UTF-16 code units of the input string, so it is pure, synchronous and identical in the
// browser, Node and Deno (no crypto, no TextEncoder, no Node imports).
// Because only the key path and the seed enter the hash, every locale's copy of a key — and
// every label planted on that key — lands in the same split, so no key can leak across splits.

export type Split = 'dev' | 'heldout';

export interface SplitConfig {
  /** Seed recorded in fixtures/manifest.json. */
  seed: string | number;
  /** Fraction of source keys assigned to dev (manifest: 0.6). */
  dev: number;
}

export const SPLIT_RULE_DESCRIPTION =
  'score = fmix32(FNV-1a-32(JSON.stringify(keyPath) + "\\u0000" + String(seed))) / 2^32 over UTF-16 code units; ' +
  'dev when score < dev fraction, else heldout. Key-based: all locales and labels of a source key share its split.';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-16 code units of `input`; returns an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** MurmurHash3 32-bit finaliser: full avalanche over an unsigned 32-bit integer. */
export function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function assertKeyPath(keyPath: readonly string[]): void {
  if (!Array.isArray(keyPath) || keyPath.length === 0 || keyPath.some((s) => typeof s !== 'string')) {
    throw new TypeError('split: keyPath must be a non-empty array of strings');
  }
}

function assertFraction(dev: number): void {
  if (!(typeof dev === 'number' && Number.isFinite(dev) && dev > 0 && dev < 1)) {
    throw new RangeError('split: dev fraction must be a number strictly between 0 and 1');
  }
}

/** Uniform score in [0, 1) for a source key path under a seed. */
export function splitScore(keyPath: readonly string[], seed: string | number): number {
  assertKeyPath(keyPath);
  return fmix32(fnv1a32(`${JSON.stringify(keyPath)}\u0000${String(seed)}`)) / 0x1_0000_0000;
}

/** Split for one source key path. Locale is deliberately not an input. */
export function splitForKey(keyPath: readonly string[], config: SplitConfig): Split {
  assertFraction(config.dev);
  return splitScore(keyPath, config.seed) < config.dev ? 'dev' : 'heldout';
}

/** Returns a copy of each item with its `split` field recomputed from `item.key`. */
export function assignSplits<T extends { key: readonly string[] }>(
  items: readonly T[],
  config: SplitConfig,
): Array<T & { split: Split }> {
  return items.map((item) => ({ ...item, split: splitForKey(item.key, config) }));
}

/** Partition distinct key paths into dev and held-out (input order preserved, duplicates removed). */
export function partitionKeys(
  keyPaths: readonly (readonly string[])[],
  config: SplitConfig,
): { dev: string[][]; heldout: string[][] } {
  const seen = new Set<string>();
  const dev: string[][] = [];
  const heldout: string[][] = [];
  for (const keyPath of keyPaths) {
    const id = JSON.stringify(keyPath);
    if (seen.has(id)) continue;
    seen.add(id);
    (splitForKey(keyPath, config) === 'dev' ? dev : heldout).push([...keyPath]);
  }
  return { dev, heldout };
}
