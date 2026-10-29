// orphan_key (warning): a target key the source does not have (after plural-family grouping).

import type { Rule, RuleContext } from '../pairs.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'orphan_key' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  return ctx.alignment.orphans.map((e) => ctx.finding({ id, severity }, e.path, `key is not in the source ${ctx.source.fileName}`));
}

export const rule: Rule = { id, severity, check };
