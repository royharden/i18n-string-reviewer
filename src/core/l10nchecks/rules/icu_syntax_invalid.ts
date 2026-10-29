// icu_syntax_invalid (error): an ICU-dialect target string does not parse (formatjs, tags ignored,
// `other` not required by the parser — a missing `other` is plural_category_missing instead).
// A broken SOURCE string is reported once by checkSourceDocument, never once per target.

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'icu_syntax_invalid' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  if (ctx.dialect !== 'icu') return [];
  const out: DeterministicFinding[] = [];
  for (const p of ctx.comparablePairs()) {
    const icu = ctx.targetOf(p).icu;
    if (icu && !icu.ok) out.push(ctx.finding({ id, severity }, p.path, icu.error.message, p.target.value as string));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
