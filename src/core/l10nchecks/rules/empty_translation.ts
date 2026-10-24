// empty_translation (error): the target string is empty or whitespace-only while the source is not.

import { isBlank } from '../pairs.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import { excerpt } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'empty_translation' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const s = p.source.value as string;
    const t = p.target.value as string;
    if (isBlank(t) && !isBlank(s)) {
      out.push(ctx.finding({ id, severity }, p.path, `translation is empty (source: ${excerpt(s, 60)})`, JSON.stringify(t)));
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
