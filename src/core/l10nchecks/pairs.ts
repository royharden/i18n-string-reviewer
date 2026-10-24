// Source/target alignment and the shared, cached per-string analysis every rule reads.
//
// Alignment (PLAN §3.1): i18next plural suffix families are grouped by base key BEFORE the
// missing/orphan comparison; object-vs-string clashes become one type_mismatch instead of a
// cascade of missing + orphan findings; source leaves that are not strings are import issues and
// are skipped here.

import { diffIcuStructures, icuDisplayLength, icuLiteralText, icuStructure, parseIcu } from './icu.ts';
import type { IcuAst, IcuParseError, IcuStructure, IcuStructureDiff } from './icu.ts';
import { ancestorKeys, pathKey } from './paths.ts';
import { tokenizePlaceholders } from './placeholders.ts';
import type { PlaceholderScan } from './placeholders.ts';
import { parsePluralSuffix, pluralCategories } from './plural.ts';
import { buildTagTree } from './tags.ts';
import type { TagTree } from './tags.ts';
import { codePointLength } from './text.ts';
import type {
  CheckOptions,
  ContextEntry,
  DeterministicFinding,
  Dialect,
  Entry,
  FileRole,
  LocaleDocument,
  PathKey,
  PluralCategory,
  PluralType,
  RuleId,
  Severity,
} from './types.ts';

// --- per-string analysis ---

export type IcuAnalysis =
  | { readonly ok: true; readonly ast: IcuAst; readonly structure: IcuStructure }
  | { readonly ok: false; readonly error: IcuParseError };

export interface StringAnalysis {
  readonly text: string;
  readonly dialect: Dialect;
  /** ICU dialect only. */
  readonly icu: IcuAnalysis | null;
  /** Non-ICU dialects only (ICU arguments live in `icu.structure`). */
  readonly placeholders: PlaceholderScan | null;
  /** Non-ICU dialects only (ICU markup lives in `icu.structure`). */
  readonly tags: TagTree | null;
  /** Unbalanced-markup messages (any dialect). */
  readonly tagErrors: readonly string[];
  /** Placeholder syntax errors (non-ICU dialects). */
  readonly placeholderErrors: readonly string[];
  /** Text with placeholders, ICU syntax and markup removed (U+0000 separators). */
  readonly literalText: string;
  /** Approximate rendered length in code points (markup excluded; longest ICU branch). */
  readonly displayLength: number;
  /** ICU plural/select present (branch counts vary by locale). */
  readonly hasChoices: boolean;
  /** Any structural problem: comparisons against this string would be noise. */
  readonly structurallyBroken: boolean;
}

const TAG_SPAN = /<\/?[A-Za-z0-9][^<>]*>/gu;

export function analyzeString(text: string, dialect: Dialect): StringAnalysis {
  if (dialect === 'icu') {
    const parsed = parseIcu(text);
    if (!parsed.ok) {
      return {
        text,
        dialect,
        icu: parsed,
        placeholders: null,
        tags: null,
        tagErrors: [],
        placeholderErrors: [],
        literalText: text,
        displayLength: codePointLength(text.replace(TAG_SPAN, '')),
        hasChoices: false,
        structurallyBroken: true,
      };
    }
    const structure = icuStructure(parsed.ast);
    const tagErrors = structure.tagIssues.map((t) => t.message);
    return {
      text,
      dialect,
      icu: { ok: true, ast: parsed.ast, structure },
      placeholders: null,
      tags: null,
      tagErrors,
      placeholderErrors: [],
      literalText: icuLiteralText(parsed.ast),
      displayLength: icuDisplayLength(parsed.ast),
      hasChoices: structure.choiceDepth > 0,
      structurallyBroken: tagErrors.length > 0,
    };
  }
  const placeholders = tokenizePlaceholders(text, dialect);
  const tags = buildTagTree(text);
  let literal = '';
  let pos = 0;
  const spans = [...placeholders.tokens.map((t) => [t.start, t.end] as const), ...tags.tokens.map((t) => [t.start, t.end] as const)].sort(
    (a, b) => a[0] - b[0],
  );
  for (const [s, e] of spans) {
    if (s < pos) continue;
    literal += `${text.slice(pos, s)}\u0000`;
    pos = e;
  }
  literal += text.slice(pos);
  const tagErrors = tags.errors.map((e) => e.message);
  const placeholderErrors = placeholders.errors.map((e) => e.message);
  return {
    text,
    dialect,
    icu: null,
    placeholders,
    tags,
    tagErrors,
    placeholderErrors,
    literalText: literal,
    displayLength: codePointLength(text.replace(TAG_SPAN, '')),
    hasChoices: false,
    structurallyBroken: tagErrors.length > 0 || placeholderErrors.length > 0,
  };
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

// --- alignment ---

export interface FamilyRef {
  readonly basePath: readonly string[];
  readonly type: PluralType;
  readonly category: PluralCategory;
}

export interface PluralFamily {
  readonly basePath: readonly string[];
  readonly type: PluralType;
  readonly source: Map<PluralCategory, Entry>;
  readonly target: Map<PluralCategory, Entry>;
  /** Categories already explained by an object/leaf clash; suppress only their category noise. */
  readonly clashedCategories?: ReadonlySet<PluralCategory>;
}

export interface PairItem {
  /** Target path (what findings point at). */
  readonly path: readonly string[];
  readonly sourcePath: readonly string[];
  readonly source: Entry;
  readonly target: Entry;
  readonly family: FamilyRef | null;
}

export interface TypeMismatch {
  readonly path: readonly string[];
  readonly message: string;
  readonly evidence?: string;
}

export interface Alignment {
  /** String/string pairs. */
  readonly pairs: readonly PairItem[];
  /** Source string entries with nothing in the target (one representative per plural family). */
  readonly missing: readonly Entry[];
  /** Target entries with nothing in the source. */
  readonly orphans: readonly Entry[];
  readonly typeMismatches: readonly TypeMismatch[];
  readonly families: readonly PluralFamily[];
}

function familyKey(parent: readonly string[], base: string, type: PluralType): string {
  return `${pathKey([...parent, base])}|${type}`;
}

function descendantsIndex(doc: LocaleDocument): Map<PathKey, Entry[]> {
  const idx = new Map<PathKey, Entry[]>();
  // Parsed documents retain actual containers, including empty ones. Absence of this optional
  // metadata keeps compatibility with older callers that supplied only leaf entries.
  if (doc.containers !== undefined) for (const key of doc.containers.keys()) idx.set(key, []);
  for (const e of doc.entries.values()) {
    for (const a of ancestorKeys(e.path)) {
      const list = idx.get(a);
      if (list) list.push(e);
      else if (doc.containers === undefined) idx.set(a, [e]);
    }
  }
  return idx;
}

export function alignDocuments(source: LocaleDocument, target: LocaleDocument): Alignment {
  const pairs: PairItem[] = [];
  const missing: Entry[] = [];
  const orphans: Entry[] = [];
  const typeMismatches: TypeMismatch[] = [];

  // 1. i18next plural families, decided by the source. A cardinal `_other` needs a category
  // sibling unless the source locale has only `other`; explicit `_ordinal_` suffixes stay families.
  const familyMap = new Map<string, PluralFamily>();
  const sourceMember = new Set<PathKey>();
  const targetMember = new Set<PathKey>();
  if (source.dialect === 'i18next') {
    for (const e of source.entries.values()) {
      if (e.kind !== 'string') continue;
      const last = e.path[e.path.length - 1];
      const sfx = last === undefined ? null : parsePluralSuffix(last);
      if (!sfx) continue;
      const parent = e.path.slice(0, -1);
      const key = familyKey(parent, sfx.base, sfx.type);
      let fam = familyMap.get(key);
      if (!fam) {
        fam = { basePath: [...parent, sfx.base], type: sfx.type, source: new Map(), target: new Map() };
        familyMap.set(key, fam);
      }
      fam.source.set(sfx.category, e);
    }
    for (const [key, fam] of familyMap) {
      const ambiguousOther = fam.type === 'cardinal' && fam.source.size === 1 && pluralCategories(source.locale, 'cardinal').length > 1;
      if (!fam.source.has('other') || ambiguousOther) familyMap.delete(key);
      else for (const e of fam.source.values()) sourceMember.add(pathKey(e.path));
    }
    for (const e of target.entries.values()) {
      const last = e.path[e.path.length - 1];
      const sfx = last === undefined ? null : parsePluralSuffix(last);
      if (!sfx) continue;
      const fam = familyMap.get(familyKey(e.path.slice(0, -1), sfx.base, sfx.type));
      if (!fam) continue;
      fam.target.set(sfx.category, e);
      targetMember.add(pathKey(e.path));
    }
  }

  const sourceDesc = descendantsIndex(source);
  const targetDesc = descendantsIndex(target);
  const explainedSource = new Set<PathKey>();
  const explainedTarget = new Set<PathKey>();

  // 2. Target string where the source has an object.
  for (const [key, t] of target.entries) {
    if (source.entries.has(key)) continue;
    const below = sourceDesc.get(key);
    if (!below) continue;
    explainedTarget.add(key);
    for (const s of below) explainedSource.add(pathKey(s.path));
    typeMismatches.push({
      path: t.path,
      message: `target has a ${t.valueType} here, but the source has an object with ${below.length} key(s) below this path`,
    });
  }

  // 3. Source leaves (non-family).
  for (const [key, s] of source.entries) {
    if (explainedSource.has(key)) continue;
    const below = targetDesc.get(key);
    if (s.kind === 'string' && below) {
      explainedSource.add(key);
      for (const d of below) explainedTarget.add(pathKey(d.path));
      typeMismatches.push({ path: s.path, message: `target has an object with ${below.length} key(s) here; the source value is a string` });
      continue;
    }
    if (sourceMember.has(key)) continue;
    const t = target.entries.get(key);
    if (s.kind !== 'string') {
      // Source import issue; nothing to compare against.
      if (t) explainedTarget.add(key);
      continue;
    }
    if (t) {
      explainedTarget.add(key);
      if (t.kind === 'string') pairs.push({ path: t.path, sourcePath: s.path, source: s, target: t, family: null });
      else typeMismatches.push({ path: t.path, message: `target value is ${t.valueType}; the source value is a string`, evidence: describeValue(t.value) });
      continue;
    }
    missing.push(s);
  }

  // 4. Families.
  const families: PluralFamily[] = [];
  for (const fam of familyMap.values()) {
    if ([...fam.source.values()].every((e) => explainedSource.has(pathKey(e.path))) && [...fam.target.values()].every((e) => explainedTarget.has(pathKey(e.path)))) {
      // A whole-parent replacement (or every source form replaced) leaves no usable sibling.
      continue;
    }
    const clashedCategories = new Set<PluralCategory>();
    for (const [category, s] of fam.source) if (explainedSource.has(pathKey(s.path))) clashedCategories.add(category);
    for (const [category, t] of fam.target) if (explainedTarget.has(pathKey(t.path))) clashedCategories.add(category);
    families.push(clashedCategories.size > 0 ? { ...fam, clashedCategories } : fam);
    if (fam.target.size === 0) {
      const rep = fam.source.get('other');
      if (rep && clashedCategories.size === 0) missing.push(rep);
      continue;
    }
    for (const [category, t] of fam.target) {
      if (explainedTarget.has(pathKey(t.path))) continue;
      // A source form remains valid fallback text for another target category even when its own
      // target form is a container; only the clashing target member is unavailable for pairing.
      const s = fam.source.get(category) ?? fam.source.get('other');
      if (!s) continue;
      if (t.kind !== 'string') {
        typeMismatches.push({ path: t.path, message: `target value is ${t.valueType}; the source value is a string`, evidence: describeValue(t.value) });
        continue;
      }
      pairs.push({ path: t.path, sourcePath: s.path, source: s, target: t, family: { basePath: fam.basePath, type: fam.type, category } });
    }
  }

  // 5. Orphans.
  for (const [key, t] of target.entries) {
    if (targetMember.has(key) || explainedTarget.has(key) || source.entries.has(key)) continue;
    orphans.push(t);
  }

  return { pairs, missing, orphans, typeMismatches, families };
}

function describeValue(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return String(v);
  }
}

// --- rule context ---

export interface RuleMeta {
  readonly id: RuleId;
  readonly severity: Severity;
}

/** A deterministic rule: stable id, fixed severity, pure check over one source/target pair. */
export interface Rule extends RuleMeta {
  check(ctx: RuleContext): DeterministicFinding[];
}

export interface RuleContext {
  readonly source: LocaleDocument;
  readonly target: LocaleDocument;
  readonly options: CheckOptions;
  readonly alignment: Alignment;
  /** Dialect used to read both sides (the source's confirmed dialect). */
  readonly dialect: Dialect;
  analyze(text: string): StringAnalysis;
  sourceOf(pair: PairItem): StringAnalysis;
  targetOf(pair: PairItem): StringAnalysis;
  /**
   * Pairs for structural comparison: target not blank, source string structurally sound
   * (a broken source is ONE source issue from `checkSourceDocument`, never N target errors).
   */
  comparablePairs(): readonly PairItem[];
  /** Source-vs-target ICU structure diff (cached); null unless both sides parsed as ICU. */
  icuDiff(pair: PairItem): IcuStructureDiff | null;
  contextFor(pair: PairItem): ContextEntry | undefined;
  finding(rule: RuleMeta, path: readonly string[], message: string, evidence?: string, subject?: FileRole): DeterministicFinding;
}

export function buildRuleContext(source: LocaleDocument, target: LocaleDocument, options: CheckOptions = {}): RuleContext {
  const alignment = alignDocuments(source, target);
  const dialect = source.dialect;
  const cache = new Map<string, StringAnalysis>();
  const analyze = (text: string): StringAnalysis => {
    let a = cache.get(text);
    if (!a) {
      a = analyzeString(text, dialect);
      cache.set(text, a);
    }
    return a;
  };
  let comparable: PairItem[] | null = null;
  const diffs = new Map<PairItem, IcuStructureDiff | null>();
  const ctx: RuleContext = {
    source,
    target,
    options,
    alignment,
    dialect,
    analyze,
    sourceOf: (p) => analyze(p.source.value as string),
    targetOf: (p) => analyze(p.target.value as string),
    comparablePairs: () => {
      if (comparable === null) {
        comparable = alignment.pairs.filter(
          (p) => !isBlank(p.target.value as string) && !analyze(p.source.value as string).structurallyBroken,
        );
      }
      return comparable;
    },
    icuDiff: (p) => {
      if (diffs.has(p)) return diffs.get(p) ?? null;
      const s = analyze(p.source.value as string).icu;
      const t = analyze(p.target.value as string).icu;
      const d = s?.ok === true && t?.ok === true ? diffIcuStructures(s.structure, t.structure) : null;
      diffs.set(p, d);
      return d;
    },
    contextFor: (p) => {
      const ctxMap = options.context;
      if (!ctxMap) return undefined;
      return (
        ctxMap.get(pathKey(p.sourcePath)) ??
        ctxMap.get(pathKey(p.path)) ??
        (p.family ? ctxMap.get(pathKey(p.family.basePath)) : undefined)
      );
    },
    finding: (rule, path, message, evidence, subject = 'target') => {
      const base = { ruleId: rule.id, severity: rule.severity, path, locale: subject === 'source' ? source.locale : target.locale, subject, message };
      return evidence === undefined ? base : { ...base, evidence };
    },
  };
  return ctx;
}
