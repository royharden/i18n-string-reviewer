// Non-model comparison floor. Local metadata becomes facts bound to a masked item; it never
// expands the provider wire format. Findings still pass the central evidence validator and gate.
import type { RawModelFinding } from '../cited/finding.ts';
import { MAX_TEXT_FIELD } from '../cited/finding.ts';
import { safeCut } from '../context/pack.ts';
import { languageOf } from '../l10nchecks/locale.ts';
import { analyzeString } from '../l10nchecks/pairs.ts';
import { approvedTranslation } from '../l10nchecks/rules/glossary_violation.ts';
import { LENGTH_RATIO, MIN_SOURCE_LENGTH } from '../l10nchecks/rules/length_risk.ts';
import { containsTerm, letterCount, removeTerms } from '../l10nchecks/text.ts';
import type { GlossaryEntry } from '../l10nchecks/types.ts';
import { tokenRegExp } from '../maskgate/mask.ts';
import type { ReviewItemRecord } from './pipeline.ts';
import type { Reviewer } from './types.ts';
import { MAX_BATCH_SIZE } from './types.ts';

export interface HeuristicItemPolicy {
  /** Binds facts to the exact prepared masked input, including context and token legend. */
  readonly maskedIdentity: string;
  readonly identicalRisk: boolean;
  readonly glossaryRisk: boolean;
  readonly lengthRisk: boolean;
  readonly wrongScriptRisk: boolean;
}

const EXPECTED_SCRIPT: Readonly<Record<string, RegExp>> = {
  fr: /\p{Script=Latin}/u,
  ru: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
};

/** Local facts use the deterministic floor's DNT, glossary and longest-branch length semantics. */
export function buildHeuristicPolicies(records: readonly ReviewItemRecord[], glossary: readonly GlossaryEntry[] = []): ReadonlyMap<string, HeuristicItemPolicy> {
  const policies = new Map<string, HeuristicItemPolicy>();
  const dnt = glossary.filter((entry) => entry.doNotTranslate === true).map((entry) => entry.term);
  for (const record of records) {
    if (policies.has(record.itemId)) throw new Error('duplicate_heuristic_item');
    const item = record.mask.masked;
    const source = analyzeString(record.sourceText, record.dialect);
    const target = analyzeString(record.targetText, record.dialect);
    const targetProse = removeTerms(item.target.replace(tokenRegExp(), ' '), dnt);
    const expected = EXPECTED_SCRIPT[languageOf(item.locale)];
    const glossaryRisk = glossary.some((entry) => {
      if (!containsTerm(record.sourceText, entry.term)) return false;
      if (entry.doNotTranslate === true) return !containsTerm(record.targetText, entry.term);
      const approved = approvedTranslation(entry, item.locale);
      return approved !== undefined && approved.trim().length > 0
        && !record.targetText.toLocaleLowerCase(item.locale).includes(approved.toLocaleLowerCase(item.locale));
    });
    policies.set(record.itemId, Object.freeze({
      maskedIdentity: JSON.stringify(item),
      identicalRisk: record.sourceText === record.targetText
        && languageOf(item.sourceLocale) !== languageOf(item.locale)
        && letterCount(removeTerms(source.literalText, dnt)) >= 2,
      glossaryRisk,
      lengthRisk: record.maxLength !== undefined ? target.displayLength > record.maxLength
        : source.displayLength >= MIN_SOURCE_LENGTH && target.displayLength > LENGTH_RATIO * source.displayLength,
      // A deliberately narrow script hint: no expected-script letter, rather than rejecting
      // ordinary mixed-script names/loanwords. Unknown locales have no script heuristic.
      wrongScriptRisk: expected !== undefined && letterCount(targetProse) >= 2 && !expected.test(targetProse),
    }));
  }
  return policies;
}

export function createHeuristicReviewer(options: { readonly policies: ReadonlyMap<string, HeuristicItemPolicy> }): Reviewer {
  const policies = new Map<string, HeuristicItemPolicy>([...options.policies].map(([id, policy]) => [id, Object.freeze({ ...policy })] as const));
  return {
    id: 'heuristic', label: 'Heuristic (local comparison floor)',
    async review(batch) {
      if (batch.length < 1 || batch.length > MAX_BATCH_SIZE) throw new Error('invalid_batch');
      const findings: RawModelFinding[] = [];
      for (const item of batch) {
        const policy = policies.get(item.itemId);
        if (!policy || policy.maskedIdentity !== JSON.stringify(item)) throw new Error('stale_heuristic_policy');
        if (item.target.trim().length === 0) continue;
        const add = (category: RawModelFinding['category'], explanation: string): void => {
          findings.push({ itemId: item.itemId, key: [...item.key], locale: item.locale, category,
            severity: 'minor', explanation, evidence: safeCut(item.target, MAX_TEXT_FIELD) });
        };
        if (policy.identicalRisk) add('accuracy', 'Local heuristic: target equals the source after allowing do-not-translate terms.');
        if (policy.glossaryRisk) add('terminology', 'Local heuristic: an applicable glossary translation or do-not-translate term is missing.');
        if (policy.lengthRisk) add('style', 'Local heuristic: visible target length exceeds the context limit or the 1.6× source-length floor.');
        if (policy.wrongScriptRisk) add('fluency', 'Local heuristic: target prose has no letter in the expected script for this locale.');
      }
      return { rawFindings: findings, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
