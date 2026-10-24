// Key paths are arrays of segments. Map keys are JSON-encoded arrays, so `["a.b"]` and
// `["a","b"]` never collide and `__proto__` is just another string.

import type { PathKey } from './types.ts';

export function pathKey(segments: readonly string[]): PathKey {
  return JSON.stringify(segments) as PathKey;
}

export function segmentsFromKey(key: PathKey): string[] {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string')) {
    throw new TypeError(`not a path key: ${key}`);
  }
  return parsed as string[];
}

/** A segment that can be shown dot-joined without ambiguity. */
export function isSimpleSegment(segment: string): boolean {
  return segment.length > 0 && !/[.[\]"\\\s]/u.test(segment);
}

/**
 * Human display form. All-simple paths are dot-joined (`nav.post`); any other path is shown as
 * its JSON array (`["a.b"]`, `["", "x"]`). A dot-joined form never starts with `[`, so the two
 * forms cannot be confused and `parseDisplayPath(displayPath(p))` round-trips.
 */
export function displayPath(segments: readonly string[]): string {
  if (segments.length > 0 && segments.every(isSimpleSegment)) return segments.join('.');
  return JSON.stringify(segments);
}

/** Inverse of `displayPath`. Returns null for text that is not a valid display path. */
export function parseDisplayPath(text: string): string[] | null {
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((s) => typeof s !== 'string')) return null;
    return parsed as string[];
  }
  if (text.length === 0) return null;
  const parts = text.split('.');
  if (!parts.every(isSimpleSegment)) return null;
  return parts;
}

/** True when `prefix` is a proper prefix of `path`. */
export function isProperPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length >= path.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== path[i]) return false;
  return true;
}

/** Path keys of every proper ancestor of `path` (length 1 .. n-1). */
export function ancestorKeys(path: readonly string[]): PathKey[] {
  const out: PathKey[] = [];
  for (let n = 1; n < path.length; n++) out.push(pathKey(path.slice(0, n)));
  return out;
}

export function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}
