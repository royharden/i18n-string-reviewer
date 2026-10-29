// Test helpers: build LocaleDocuments from small inline fixtures and run one rule or all rules.

import { buildRuleContext } from '../../src/core/l10nchecks/pairs.ts';
import type { Rule } from '../../src/core/l10nchecks/pairs.ts';
import { parseLocale } from '../../src/core/l10nchecks/parse.ts';
import { pathKey } from '../../src/core/l10nchecks/paths.ts';
import { runChecks } from '../../src/core/l10nchecks/runChecks.ts';
import type {
  CheckOptions,
  ContextEntry,
  ContextMap,
  DeterministicFinding,
  Dialect,
  FileRole,
  LocaleDocument,
  PathKey,
  RuleId,
} from '../../src/core/l10nchecks/types.ts';

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface DocOptions {
  dialect?: Dialect;
  role?: FileRole;
  fileName?: string;
}

/** Parse an inline fixture (raw JSON text or a plain object). Throws if the import was rejected. */
export function makeDoc(content: string | Record<string, unknown>, locale: string, opts: DocOptions = {}): LocaleDocument {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const { doc, issues } = parseLocale(enc(text), {
    fileName: opts.fileName ?? `${locale}.json`,
    locale,
    dialect: opts.dialect ?? 'icu',
    role: opts.role ?? 'target',
  });
  if (doc.rejected) throw new Error(`fixture rejected: ${issues.map((i) => i.message).join('; ')}`);
  return doc;
}

export function sourceDoc(content: string | Record<string, unknown>, dialect: Dialect = 'icu', locale = 'en'): LocaleDocument {
  return makeDoc(content, locale, { dialect, role: 'source' });
}

export function targetDoc(content: string | Record<string, unknown>, locale: string, dialect: Dialect = 'icu'): LocaleDocument {
  return makeDoc(content, locale, { dialect, role: 'target' });
}

export function runRule(rule: Rule, source: LocaleDocument, target: LocaleDocument, options: CheckOptions = {}): DeterministicFinding[] {
  return rule.check(buildRuleContext(source, target, options));
}

export interface PairOptions {
  dialect?: Dialect;
  options?: CheckOptions;
  sourceLocale?: string;
}

/** One key `k`: source text `s` vs target text `t`, checked by one rule. */
export function checkPair(rule: Rule, s: string, t: string, targetLocale: string, opts: PairOptions = {}): DeterministicFinding[] {
  const dialect = opts.dialect ?? 'icu';
  return runRule(rule, sourceDoc({ k: s }, dialect, opts.sourceLocale ?? 'en'), targetDoc({ k: t }, targetLocale, dialect), opts.options ?? {});
}

/** One key `k` through every rule (runChecks). */
export function checkAll(s: string, t: string, targetLocale: string, opts: PairOptions = {}): DeterministicFinding[] {
  const dialect = opts.dialect ?? 'icu';
  return runChecks(sourceDoc({ k: s }, dialect, opts.sourceLocale ?? 'en'), targetDoc({ k: t }, targetLocale, dialect), opts.options ?? {});
}

export const ruleIds = (findings: readonly DeterministicFinding[]): RuleId[] => findings.map((f) => f.ruleId);

export const errorsOf = (findings: readonly DeterministicFinding[]): DeterministicFinding[] =>
  findings.filter((f) => f.severity === 'error');

export function contextMap(entries: ReadonlyArray<[readonly string[], ContextEntry]>): ContextMap {
  return new Map<PathKey, ContextEntry>(entries.map(([p, e]) => [pathKey(p), e]));
}
