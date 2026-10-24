// glossary_violation (warning): the source contains a glossary term (case-insensitive, whole word)
// and the target does not contain the approved translation for the target locale (exact locale,
// then language), or a do-not-translate term was changed.

import { languageOf } from '../locale.ts';
import { isBlank } from '../pairs.ts';
import type { Rule, RuleContext } from '../pairs.ts';
import { containsTerm } from '../text.ts';
import type { DeterministicFinding, GlossaryEntry } from '../types.ts';

export const id = 'glossary_violation' as const;
export const severity = 'warning' as const;

export function approvedTranslation(entry: GlossaryEntry, locale: string): string | undefined {
  const t = entry.translations;
  if (!t) return undefined;
  if (Object.prototype.hasOwnProperty.call(t, locale)) return t[locale];
  const lang = languageOf(locale);
  if (Object.prototype.hasOwnProperty.call(t, lang)) return t[lang];
  return undefined;
}

export function check(ctx: RuleContext): DeterministicFinding[] {
  const glossary = ctx.options.glossary ?? [];
  if (glossary.length === 0) return [];
  const locale = ctx.target.locale;
  const out: DeterministicFinding[] = [];
  for (const p of ctx.alignment.pairs) {
    const s = p.source.value as string;
    const t = p.target.value as string;
    if (isBlank(t)) continue;
    const problems: string[] = [];
    for (const entry of glossary) {
      if (!containsTerm(s, entry.term)) continue;
      if (entry.doNotTranslate === true) {
        if (!containsTerm(t, entry.term)) problems.push(`do-not-translate term "${entry.term}" is missing or altered`);
        continue;
      }
      const approved = approvedTranslation(entry, locale);
      if (approved === undefined || approved.trim().length === 0) continue;
      if (!t.toLocaleLowerCase(locale).includes(approved.toLocaleLowerCase(locale))) {
        problems.push(`"${entry.term}" should be translated as "${approved}"`);
      }
    }
    if (problems.length > 0) out.push(ctx.finding({ id, severity }, p.path, problems.join('; '), JSON.stringify(t)));
  }
  return out;
}

export const rule: Rule = { id, severity, check };
