// html_tag_mismatch (error): markup differs — tag names, nesting, attribute names or exact
// href/src values — or the target's tags are unbalanced. Sibling order may change; `<br>` ≡ `<br/>`.

import type { Rule, RuleContext } from '../pairs.ts';
import { compareTagTrees, scanTags, tagList } from '../tags.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'html_tag_mismatch' as const;
export const severity = 'error' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  const out: DeterministicFinding[] = [];
  for (const p of ctx.comparablePairs()) {
    const t = ctx.targetOf(p);
    const problems: string[] = t.tagErrors.map((e) => `target: ${e}`);
    if (ctx.dialect === 'icu') {
      if (t.icu === null || !t.icu.ok) continue; // icu_syntax_invalid reports it
      const diff = ctx.icuDiff(p);
      if (diff) problems.push(...diff.tags);
    } else if (t.tagErrors.length === 0) {
      const s = ctx.sourceOf(p);
      if (s.tags && t.tags) {
        const cmp = compareTagTrees(s.tags, t.tags);
        if (!cmp.equal) problems.push(`tag structure differs (source ${cmp.sourceForm || 'none'}, target ${cmp.targetForm || 'none'})`);
      }
    }
    if (problems.length > 0) {
      const evidence = tagList(scanTags(p.target.value as string));
      out.push(ctx.finding({ id, severity }, p.path, problems.join('; '), evidence.length > 0 ? evidence : undefined));
    }
  }
  return out;
}

export const rule: Rule = { id, severity, check };
