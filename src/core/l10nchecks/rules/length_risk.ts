// length_risk (warning): the target is likely to overflow its UI slot.
//   - `maxLength` from context.json is authoritative (code points), when present;
//   - otherwise target > 1.6 × source, for sources of at least 4 code points.
// Lengths are VISIBLE lengths (StringAnalysis.displayLength): markup removed, and for ICU
// plural/select messages the LONGEST BRANCH is measured on each side (never the sum of branches),
// so a Russian/Arabic message with more plural branches than English is not penalised for them.

import { isBlank } from '../pairs.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'length_risk' as const;
export const severity = 'warning' as const;

export const LENGTH_RATIO = 1.6;
export const MIN_SOURCE_LENGTH = 4;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    if (isBlank(p.target.value as string)) continue;
    const s = ctx.sourceOf(p).displayLength;
    const t = ctx.targetOf(p).displayLength;
    const maxLength = ctx.contextFor(p)?.maxLength;
    if (maxLength !== undefined) {
      if (t > maxLength) {
        out.push(ctx.finding({ id, severity }, p.path, `target is ${t} characters; context maxLength is ${maxLength}`, `${t} > ${maxLength}`));
      }
      continue;
    }
    if (s >= MIN_SOURCE_LENGTH && t > LENGTH_RATIO * s) {
      out.push(
        ctx.finding({ id, severity }, p.path, `target is ${(t / s).toFixed(2)}× the source length (${t} vs ${s}; limit ${LENGTH_RATIO}×)`, `${t} / ${s}`),
      );
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
