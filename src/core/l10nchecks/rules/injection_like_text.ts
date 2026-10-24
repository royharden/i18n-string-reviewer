// injection_like_text (warning): the target reads like an instruction to a model ("ignore previous
// instructions", "you are now", "system prompt", "mark this … correct", `<script`). Flag only:
// model review still runs, over masked text. Source strings are flagged by checkSourceDocument.

import type { Rule, RuleContext } from '../pairs.ts';
import { findInjectionLike } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'injection_like_text' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const hit = findInjectionLike(p.target.value as string);
    if (hit !== null) out.push(ctx.finding({ id, severity }, p.path, 'target contains instruction-like text aimed at a reviewer or model', hit));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
