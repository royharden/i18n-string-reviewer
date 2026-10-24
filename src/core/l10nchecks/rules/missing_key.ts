// missing_key (error): a source key has no counterpart in the target. i18next plural families are
// grouped first, so a family counts as present when the target has any of its forms.

import type { Rule, RuleContext } from '../pairs.ts';
import { excerpt } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'missing_key' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  return ctx.alignment.missing.map((e) =>
    ctx.finding({ id, severity }, e.path, `key is missing from ${ctx.target.fileName}`, excerpt(e.value as string)),
  );
}

export const rule: Rule = { id, severity, check };
