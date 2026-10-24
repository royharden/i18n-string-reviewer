// whitespace_drift (warning): leading/trailing whitespace or double spaces differ, after treating
// `&nbsp;` ≡ U+00A0 ≡ U+202F as the same character. Comparison only — no bytes are changed.

import { isBlank } from '../pairs.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import { whitespaceDifferences } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'whitespace_drift' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const t = p.target.value as string;
    if (isBlank(t)) continue;
    const diffs = whitespaceDifferences(p.source.value as string, t);
    if (diffs.length > 0) out.push(ctx.finding({ id, severity }, p.path, diffs.join('; '), JSON.stringify(t)));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
