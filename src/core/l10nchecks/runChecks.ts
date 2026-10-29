// Entry points for the deterministic pass (PLAN §3.2).
//
//   runChecks(source, target, opts)      findings for one target (synchronous, pure)
//   checkSourceDocument(source, opts)    one-per-key SOURCE issues (broken ICU, unbalanced tags,
//                                        bad placeholders, missing plural branches, injection text);
//                                        runChecks skips structural target checks for those keys
//   runAllChecks(source, targets, opts)  both, for a whole import
//
// `checkVersion` is part of every finding id / ruling fingerprint downstream (PLAN §3.5, §3.7):
// bump it whenever any rule's behaviour changes.

import { analyzeString, buildRuleContext } from './pairs.ts';
import type { RuleMeta } from './pairs.ts';
import { displayPath } from './paths.ts';
import { checkPluralBranches } from './plural.ts';
import { RULES } from './rules/index.ts';
import { pluralLabel } from './rules/pluralShared.ts';
import { findInjectionLike } from './text.ts';
import type { CheckOptions, DeterministicFinding, LocaleDocument } from './types.ts';

export const checkVersion = 'l10nchecks/1.0.3';

/** Errors first, then key path, then rule id, then message (stable output for snapshots). */
export function sortFindings(findings: readonly DeterministicFinding[]): DeterministicFinding[] {
  const sev = (f: DeterministicFinding): number => (f.severity === 'error' ? 0 : 1);
  return [...findings].sort((a, b) => {
    if (sev(a) !== sev(b)) return sev(a) - sev(b);
    const pa = displayPath(a.path);
    const pb = displayPath(b.path);
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

/** All deterministic findings for one target against the source. Rejected files yield none. */
export function runChecks(source: LocaleDocument, target: LocaleDocument, opts: CheckOptions = {}): DeterministicFinding[] {
  if (source.rejected || target.rejected) return [];
  const ctx = buildRuleContext(source, target, opts);
  const out: DeterministicFinding[] = [];
  for (const rule of RULES) out.push(...rule.check(ctx));
  return sortFindings(out);
}

const SOURCE_ICU: RuleMeta = { id: 'icu_syntax_invalid', severity: 'error' };
const SOURCE_TAGS: RuleMeta = { id: 'html_tag_mismatch', severity: 'error' };
const SOURCE_PLACEHOLDERS: RuleMeta = { id: 'placeholder_mismatch', severity: 'error' };
const SOURCE_PLURAL: RuleMeta = { id: 'plural_category_missing', severity: 'error' };
const SOURCE_INJECTION: RuleMeta = { id: 'injection_like_text', severity: 'warning' };

/** Source-file issues, one per key (never repeated per target). `subject` is 'source'. */
export function checkSourceDocument(source: LocaleDocument, _opts: CheckOptions = {}): DeterministicFinding[] {
  if (source.rejected) return [];
  const out: DeterministicFinding[] = [];
  const make = (rule: RuleMeta, path: readonly string[], message: string, evidence?: string): DeterministicFinding => {
    const base = { ruleId: rule.id, severity: rule.severity, path, locale: source.locale, subject: 'source' as const, message };
    return evidence === undefined ? base : { ...base, evidence };
  };
  for (const e of source.entries.values()) {
    if (e.kind !== 'string') continue;
    const text = e.value as string;
    const a = analyzeString(text, source.dialect);
    if (a.icu && !a.icu.ok) {
      out.push(make(SOURCE_ICU, e.path, `source string: ${a.icu.error.message}; target checks for this key are skipped`, text));
      continue;
    }
    if (a.tagErrors.length > 0) {
      out.push(make(SOURCE_TAGS, e.path, `source markup: ${a.tagErrors.join('; ')}; structural target checks for this key are skipped`, text));
    }
    if (a.placeholderErrors.length > 0) {
      out.push(make(SOURCE_PLACEHOLDERS, e.path, `source placeholder syntax: ${a.placeholderErrors.join('; ')}; structural target checks for this key are skipped`, text));
    }
    if (a.icu?.ok === true) {
      const problems: string[] = [];
      for (const node of a.icu.structure.plurals) {
        const r = checkPluralBranches(node.selectors, source.locale, node.pluralType);
        if (r.missing.length > 0) problems.push(`${pluralLabel(node.name, node.pluralType)} lacks ${r.missing.join(', ')}`);
      }
      if (problems.length > 0) out.push(make(SOURCE_PLURAL, e.path, `source ${source.locale}: ${problems.join('; ')}`, text));
    }
    const hit = findInjectionLike(text);
    if (hit !== null) out.push(make(SOURCE_INJECTION, e.path, 'source contains instruction-like text aimed at a reviewer or model', hit));
  }
  return sortFindings(out);
}

export interface AllChecksResult {
  readonly source: readonly DeterministicFinding[];
  /** Keyed by target file name (file names are unique within one import). */
  readonly byTarget: ReadonlyMap<string, readonly DeterministicFinding[]>;
}

export function runAllChecks(source: LocaleDocument, targets: readonly LocaleDocument[], opts: CheckOptions = {}): AllChecksResult {
  const byTarget = new Map<string, readonly DeterministicFinding[]>();
  for (const t of targets) byTarget.set(t.fileName, runChecks(source, t, opts));
  return { source: checkSourceDocument(source, opts), byTarget };
}
