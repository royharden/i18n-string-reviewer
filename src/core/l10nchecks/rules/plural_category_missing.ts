// plural_category_missing (error): a plural construct lacks a category the TARGET locale needs
// (Intl.PluralRules(locale, {type})). `=N` branches never satisfy a category; `other` is always
// required. Covers ICU plural/selectordinal at every nesting level and i18next suffix families.

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';
import { familyPluralChecks, icuPluralChecks, pluralFamilyPath, suffixFor } from './pluralShared.ts';

export const id = 'plural_category_missing' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  const locale = ctx.target.locale;
  for (const r of icuPluralChecks(ctx)) {
    const problems = r.nodes.filter((n) => n.check.missing.length > 0).map((n) => `${n.label} lacks ${n.check.missing.join(', ')}`);
    if (problems.length > 0) {
      out.push(ctx.finding({ id, severity }, r.pair.path, `${locale} needs more plural branches: ${problems.join('; ')}`, r.pair.target.value as string));
    }
  }
  for (const { family, check: c } of familyPluralChecks(ctx)) {
    if (c.missing.length === 0) continue;
    const forms = c.missing.map((cat) => suffixFor(family.type, cat)).join(', ');
    out.push(ctx.finding({ id, severity }, pluralFamilyPath(family), `${locale} needs ${family.type} plural form(s) ${forms}`));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
