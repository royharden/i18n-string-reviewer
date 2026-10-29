// plural_category_extra (warning): a plural branch for a category the target locale never selects
// (e.g. `one` in Japanese). Harmless at runtime but usually a copy of the source's branch set.
// `=N` branches are never extra; i18next `_zero` is allowed in every language.

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';
import { familyPluralChecks, icuPluralChecks, pluralFamilyPath, suffixFor } from './pluralShared.ts';

export const id = 'plural_category_extra' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  const locale = ctx.target.locale;
  for (const r of icuPluralChecks(ctx)) {
    const problems = r.nodes.filter((n) => n.check.extra.length > 0).map((n) => `${n.label} has ${n.check.extra.join(', ')}`);
    if (problems.length > 0) {
      out.push(ctx.finding({ id, severity }, r.pair.path, `${locale} never selects: ${problems.join('; ')}`, r.pair.target.value as string));
    }
  }
  for (const { family, check: c } of familyPluralChecks(ctx)) {
    if (c.extra.length === 0) continue;
    const forms = c.extra.map((cat) => suffixFor(family.type, cat)).join(', ');
    out.push(ctx.finding({ id, severity }, pluralFamilyPath(family), `${locale} never selects ${family.type} form(s) ${forms}`));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
