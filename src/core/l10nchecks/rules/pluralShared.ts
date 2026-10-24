// Helpers shared by plural_category_missing and plural_category_extra.

import { checkPluralBranches } from '../plural.ts';
import type { PluralBranchCheck } from '../plural.ts';
import type { PairItem, PluralFamily, RuleContext } from '../pairs.ts';
import type { PluralType } from '../types.ts';

export function pluralLabel(name: string, type: PluralType): string {
  return `{${name}, ${type === 'ordinal' ? 'selectordinal' : 'plural'}}`;
}

/** Where a family finding points: the target `_other` form, else the first target form. */
export function pluralFamilyPath(fam: PluralFamily): readonly string[] {
  const other = fam.target.get('other');
  if (other) return other.path;
  for (const e of fam.target.values()) return e.path;
  return fam.basePath;
}

export interface IcuPluralResult {
  readonly pair: PairItem;
  readonly nodes: ReadonlyArray<{ readonly label: string; readonly check: PluralBranchCheck }>;
}

/** Branch checks for every ICU plural/selectordinal node of every comparable target string. */
export function icuPluralChecks(ctx: RuleContext): IcuPluralResult[] {
  if (ctx.dialect !== 'icu') return [];
  const out: IcuPluralResult[] = [];
  for (const pair of ctx.comparablePairs()) {
    const icu = ctx.targetOf(pair).icu;
    if (!icu?.ok || icu.structure.plurals.length === 0) continue;
    out.push({
      pair,
      nodes: icu.structure.plurals.map((n) => ({
        label: pluralLabel(n.name, n.pluralType),
        check: checkPluralBranches(n.selectors, ctx.target.locale, n.pluralType),
      })),
    });
  }
  return out;
}

/** Branch checks for present i18next families; only categories explained by clashes are omitted. */
export function familyPluralChecks(ctx: RuleContext): Array<{ readonly family: PluralFamily; readonly check: PluralBranchCheck }> {
  return ctx.alignment.families
    .filter((f) => f.target.size > 0 || (f.clashedCategories?.size ?? 0) > 0)
    .map((family) => {
      const check = checkPluralBranches(family.target.keys(), ctx.target.locale, family.type, { allowZero: true });
      return {
        family,
        check: {
          missing: check.missing.filter((category) => !family.clashedCategories?.has(category)),
          extra: check.extra.filter((category) => !(family.clashedCategories as ReadonlySet<string> | undefined)?.has(category)),
        },
      };
    });
}

export function suffixFor(type: PluralType, category: string): string {
  return `_${type === 'ordinal' ? 'ordinal_' : ''}${category}`;
}
