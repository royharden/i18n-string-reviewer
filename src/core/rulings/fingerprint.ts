// Fingerprints and hashes that bind a ruling to the exact text it was made about (PLAN §3.5, §3.7).
// All hashing is SHA-256 via Web Crypto (shared/hash.ts), hence async. Each hash is domain-separated
// by a leading tag, so a finding id, an item fingerprint and a suggestion hash can never collide even
// though the first two cover the same fields.

import { checkVersion as l10nCheckVersion } from '../l10nchecks/runChecks.ts';
import { pathKey } from '../l10nchecks/paths.ts';
import { hashFields } from '../shared/hash.ts';

/** Version of the whole review stack bound into ids and fingerprints (rules + mask/gate + finding schema). */
export const reviewCheckVersion = `${l10nCheckVersion}+maskgate/1+cited/1`;

export interface FingerprintInput {
  readonly key: readonly string[];
  readonly locale: string;
  /** Current source text ('' when the source has no string at this key). */
  readonly source: string;
  /** Current target text ('' when the target has no string at this key). */
  readonly target: string;
  /** Deterministic rule id, or the model finding category. */
  readonly ruleOrCategory: string;
  readonly checkVersion?: string;
}

function fields(tag: string, f: FingerprintInput): string[] {
  return [tag, pathKey(f.key), f.locale, f.source, f.target, f.ruleOrCategory, f.checkVersion ?? reviewCheckVersion];
}

/** hash(path, locale, source, current target, rule/category, checkVersion) — the ruling binding. */
export async function itemFingerprint(f: FingerprintInput): Promise<string> {
  return hashFields(fields('l10n-item-fingerprint/1', f));
}

/** Finding id: sha256(key, locale, source, target, category, checkVersion) (PLAN §3.5). */
export async function findingIdFor(f: FingerprintInput): Promise<string> {
  return hashFields(fields('l10n-finding-id/1', f));
}

/** Binds an approval to one exact suggested text. */
export async function suggestionHash(fixText: string): Promise<string> {
  return hashFields(['l10n-suggestion/1', fixText]);
}

/** Map key for one string of one locale (not a hash; never leaves the browser). */
export function stringKey(key: readonly string[], locale: string): string {
  return `${locale}\u0000${pathKey(key)}`;
}
