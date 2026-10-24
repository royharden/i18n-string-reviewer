// select_branch_mismatch (error): ICU `select` keys differ between source and target (a branch
// dropped or invented). Plural branches are checked per target locale by the plural rules.

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'select_branch_mismatch' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  if (ctx.dialect !== 'icu') return [];
  const out: DeterministicFinding[] = [];
  for (const p of ctx.comparablePairs()) {
    const diff = ctx.icuDiff(p);
    if (diff && diff.select.length > 0) {
      out.push(ctx.finding({ id, severity }, p.path, `select branches differ: ${diff.select.join('; ')}`, p.target.value as string));
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
