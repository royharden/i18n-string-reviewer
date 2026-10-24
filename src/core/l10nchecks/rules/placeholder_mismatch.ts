// placeholder_mismatch (error): placeholders differ between source and target.
//   icu              argument names/types/styles and plural/select nesting (formatjs AST path
//                    signature, plural branches collapsed, `#` ignored — see icu.ts)
//   i18next / plain  multiset of named/indexed tokens; unindexed printf keeps order and types
// Inside an i18next plural family the `count` variable may be dropped or added (like ICU `#`).

import type { Rule, RuleContext } from '../pairs.ts';
import { comparePlaceholders, describePlaceholderDiff } from '../placeholders.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'placeholder_mismatch' as const;
export const severity = 'error' as const;

const COUNT: ReadonlySet<string> = new Set(['count']);

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.comparablePairs()) {
    const s = ctx.sourceOf(p);
    const t = ctx.targetOf(p);
    if (ctx.dialect === 'icu') {
      const diff = ctx.icuDiff(p);
      if (diff && diff.placeholder.length > 0) {
        out.push(ctx.finding({ id, severity }, p.path, `ICU arguments differ: ${diff.placeholder.join('; ')}`, p.target.value as string));
      }
      continue;
    }
    if (t.placeholderErrors.length > 0) {
      out.push(ctx.finding({ id, severity }, p.path, `target placeholder syntax: ${t.placeholderErrors.join('; ')}`, p.target.value as string));
      continue;
    }
    const diff = comparePlaceholders(s.placeholders?.tokens ?? [], t.placeholders?.tokens ?? [], p.family ? { ignoreNames: COUNT } : {});
    if (!diff.equal) {
      const evidence = (t.placeholders?.tokens ?? []).map((x) => x.raw).join(' ');
      out.push(
        ctx.finding({ id, severity }, p.path, `placeholders differ: ${describePlaceholderDiff(diff)}`, evidence.length > 0 ? evidence : undefined),
      );
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
