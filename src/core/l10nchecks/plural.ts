// Plural categories per locale from Intl.PluralRules (CLDR data shipped with the runtime; D5).
// Rules: `=N` exact selectors never satisfy a category; `other` is always required.

import type { PluralCategory, PluralType } from './types.ts';

export const CATEGORY_ORDER: readonly PluralCategory[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

const cache = new Map<string, readonly PluralCategory[]>();

function sortCategories(cats: Iterable<string>): PluralCategory[] {
  const set = new Set(cats);
  return CATEGORY_ORDER.filter((c) => set.has(c));
}

/** Categories `Intl.PluralRules(locale, {type})` can select, in canonical order. Always includes `other`. */
export function pluralCategories(locale: string, type: PluralType): readonly PluralCategory[] {
  const key = `${type}\u0000${locale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const resolved = new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories as readonly string[];
  const cats = sortCategories([...resolved, 'other']);
  cache.set(key, cats);
  return cats;
}

export function isPluralCategory(selector: string): selector is PluralCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(selector);
}

/** `=0`, `=1`, … exact-value selectors. */
export function isExactSelector(selector: string): boolean {
  return /^=\d+(?:\.\d+)?$/u.test(selector);
}

export interface PluralBranchCheck {
  /** Required categories (for the locale and type) with no branch. `=N` never fills one. */
  readonly missing: readonly PluralCategory[];
  /** Branch selectors that are neither a category for the locale nor `=N`. */
  readonly extra: readonly string[];
}

/**
 * Compare the selectors present in one plural construct with the categories the locale needs.
 * `allowZero` is for i18next, whose `_zero` suffix is a valid special case in every language.
 */
export function checkPluralBranches(
  selectors: Iterable<string>,
  locale: string,
  type: PluralType,
  opts: { readonly allowZero?: boolean } = {},
): PluralBranchCheck {
  const required = pluralCategories(locale, type);
  const present = new Set<string>();
  const extra: string[] = [];
  for (const s of selectors) {
    if (isExactSelector(s)) continue;
    present.add(s);
  }
  for (const s of present) {
    if ((required as readonly string[]).includes(s)) continue;
    if (opts.allowZero === true && s === 'zero') continue;
    extra.push(s);
  }
  const missing = required.filter((c) => !present.has(c));
  return { missing, extra: sortCategories(extra).concat(extra.filter((e) => !isPluralCategory(e)).sort()) };
}

// --- i18next plural suffix families (`key_one`, `key_other`, `key_ordinal_few`, …) ---

export interface PluralSuffix {
  readonly base: string;
  readonly type: PluralType;
  readonly category: PluralCategory;
}

const SUFFIX = /^(.+?)_(ordinal_)?(zero|one|two|few|many|other)$/u;

/** Split an i18next v4 plural suffix off the last key segment, or null when there is none. */
export function parsePluralSuffix(segment: string): PluralSuffix | null {
  const m = SUFFIX.exec(segment);
  if (!m) return null;
  const base = m[1];
  const category = m[3];
  if (base === undefined || category === undefined || !isPluralCategory(category)) return null;
  return { base, type: m[2] !== undefined ? 'ordinal' : 'cardinal', category };
}
