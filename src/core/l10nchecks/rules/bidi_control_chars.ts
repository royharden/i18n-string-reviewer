// bidi_control_chars (warning): the target contains bidirectional control characters
// (U+061C, U+200E/F, U+202A–202E, U+2066–2069) that the source does not.

import type { Rule, RuleContext } from '../pairs.ts';
import { bidiControls, codePointLabel } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'bidi_control_chars' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const inSource = bidiControls(p.source.value as string);
    const added = [...bidiControls(p.target.value as string)].filter((c) => !inSource.has(c));
    if (added.length > 0) {
      const labels = added.map(codePointLabel).sort().join(', ');
      out.push(ctx.finding({ id, severity }, p.path, `target adds bidi control character(s) ${labels}`, labels));
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
