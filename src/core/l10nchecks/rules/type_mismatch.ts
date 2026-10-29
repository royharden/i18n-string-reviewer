// type_mismatch (error): the target value is not a string where the source has a string (number,
// boolean, null, array), or an object/string clash at the same key path.

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'type_mismatch' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  return ctx.alignment.typeMismatches.map((m) => ctx.finding({ id, severity }, m.path, m.message, m.evidence));
}

export const rule: Rule = { id, severity, check };
