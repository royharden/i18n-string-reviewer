// number_drift (warning): the numbers written in the text differ after per-locale normalisation
// (`1,000` en ≡ `1 000` fr ≡ `1.000` de ≡ `١٬٠٠٠` ar). Placeholders, ICU syntax and markup are
// excluded. Messages with plural/select branches compare value SETS (branch counts differ by
// locale); i18next plural-family forms only flag numbers absent from every source form.

import { compareNumbers, extractNumbers } from '../numbers.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import { pathKey } from '../paths.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'number_drift' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  const familyNumbers = new Map<string, Set<string>>();
  for (const fam of ctx.alignment.families) {
    const set = new Set<string>();
    for (const e of fam.source.values()) {
      for (const n of extractNumbers(ctx.analyze(e.value as string).literalText, ctx.source.locale)) set.add(n);
    }
    familyNumbers.set(pathKey(fam.basePath), set);
  }
  for (const p of ctx.comparablePairs()) {
    const s = ctx.sourceOf(p);
    const t = ctx.targetOf(p);
    if (t.icu !== null && !t.icu.ok) continue;
    if (p.family) {
      const allowed = familyNumbers.get(pathKey(p.family.basePath)) ?? new Set<string>();
      const extra = extractNumbers(t.literalText, ctx.target.locale).filter((n) => !allowed.has(n));
      if (extra.length > 0) {
        out.push(ctx.finding({ id, severity }, p.path, `target has number(s) ${extra.join(', ')} not in any source form`, extra.join(', ')));
      }
      continue;
    }
    const cmp = compareNumbers(s.literalText, ctx.source.locale, t.literalText, ctx.target.locale, {
      asSets: s.hasChoices || t.hasChoices,
    });
    if (!cmp.equal) {
      out.push(
        ctx.finding(
          { id, severity },
          p.path,
          `numbers differ (source [${cmp.source.join(', ')}], target [${cmp.target.join(', ')}])`,
          `source: ${cmp.source.join(', ') || 'none'}; target: ${cmp.target.join(', ') || 'none'}`,
        ),
      );
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
