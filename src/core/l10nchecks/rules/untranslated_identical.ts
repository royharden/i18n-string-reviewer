// untranslated_identical (warning): the target is byte-identical to the source and still has at
// least two letters once glossary do-not-translate terms, placeholders and markup are removed.
// Skipped when source and target share a language (en → en-GB is often legitimately identical).

import { languageOf } from '../locale.ts';
import { isBlank } from '../pairs.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import { excerpt, letterCount, removeTerms } from '../text.ts';
import type { DeterministicFinding } from '../types.ts';

export const id = 'untranslated_identical' as const;
export const severity = 'warning' as const;

export function check(ctx: RuleContext): DeterministicFinding[] {
  if (languageOf(ctx.source.locale) === languageOf(ctx.target.locale)) return [];
  const dnt = (ctx.options.glossary ?? []).filter((g) => g.doNotTranslate === true).map((g) => g.term);
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const s = p.source.value as string;
    const t = p.target.value as string;
    if (s !== t || isBlank(t)) continue;
    const literal = ctx.sourceOf(p).literalText;
    if (letterCount(removeTerms(literal, dnt)) < 2) continue;
    out.push(ctx.finding({ id, severity }, p.path, 'target is identical to the source (not a do-not-translate term)', excerpt(t)));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
