// Review pipeline (PLAN §3.1–§3.9, M3): import → deterministic checks → mask + context pack →
// reviewer batches (≤ 20) → finding validation against the producing batch → fix gate → invariant
// check. Pure and async (hashing): the caller supplies file bytes and the reviewer; nothing here
// touches the network, the clock, the file system or the DOM.

import { z } from 'zod';
import { sortFindingsForReview, staticFinding, validateModelFindings } from '../cited/finding.ts';
import type { BatchItem, DropReason, Finding } from '../cited/finding.ts';
import { matchGlossary, selectSiblings } from '../context/pack.ts';
import { resolveSourceText } from '../export/patch.ts';
import { parseContextFile, parseGlossaryFile } from '../l10nchecks/metadata.ts';
import { alignDocuments } from '../l10nchecks/pairs.ts';
import { buildValidationReport, parseLocale } from '../l10nchecks/parse.ts';
import type { FileReportInput, ValidationReport } from '../l10nchecks/parse.ts';
import { pathKey } from '../l10nchecks/paths.ts';
import { runAllChecks } from '../l10nchecks/runChecks.ts';
import type { ContextEntry, ContextMap, Dialect, GlossaryEntry, ImportIssue, LocaleDocument, PathKey } from '../l10nchecks/types.ts';
import { createGateStats, mergeGateStats, validateFix } from '../maskgate/gate.ts';
import type { GateStats } from '../maskgate/gate.ts';
import { maskItem } from '../maskgate/mask.ts';
import type { MaskResult } from '../maskgate/mask.ts';
import { invariantViolations } from '../maskgate/signature.ts';
import type { InvariantViolation } from '../maskgate/signature.ts';
import { stringKey, suggestionHash } from '../rulings/fingerprint.ts';
import { fingerprintForFinding } from '../rulings/rulings.ts';
import type { BatchReviewResult, GateRejection, Reviewer, ReviewOptions } from './types.ts';
import { MAX_BATCH_SIZE } from './types.ts';

// --- import ---

export const MAX_TARGETS = 10;

export interface FileInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** User-confirmed or manifest-pinned BCP-47 locale. */
  readonly locale: string;
  /** User-confirmed or manifest-pinned dialect. */
  readonly dialect: Dialect;
}

export interface MetaInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface ImportInput {
  readonly source: FileInput;
  readonly targets: readonly FileInput[];
  readonly context?: MetaInput;
  readonly glossary?: MetaInput;
}

export interface ImportResult {
  readonly source: LocaleDocument;
  readonly targets: readonly LocaleDocument[];
  readonly context: ContextMap;
  readonly glossary: readonly GlossaryEntry[];
  readonly issues: readonly ImportIssue[];
  readonly report: ValidationReport;
}

/** Strict import of one source, ≤ 10 targets (distinct locales) and optional metadata. */
export function importFiles(input: ImportInput): ImportResult {
  if (input.targets.length > MAX_TARGETS) throw new RangeError(`at most ${MAX_TARGETS} target files per import (got ${input.targets.length})`);
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const t of input.targets) {
    if (t.dialect !== input.source.dialect) throw new Error(`dialect mismatch: ${t.fileName} (${t.dialect}) and source (${input.source.dialect}); import each dialect separately`);
    if (names.has(t.fileName)) throw new Error(`two target files share the filename "${t.fileName}"; rename the files before importing them together`);
    names.add(t.fileName);
    const loc = t.locale.trim().toLowerCase();
    if (seen.has(loc)) throw new Error(`two target files share the locale "${t.locale}"; import them separately`);
    seen.add(loc);
  }
  const reports: FileReportInput[] = [];
  const issues: ImportIssue[] = [];
  const src = parseLocale(input.source.bytes, { fileName: input.source.fileName, locale: input.source.locale, dialect: input.source.dialect, role: 'source' });
  issues.push(...src.issues);
  reports.push({ fileName: src.doc.fileName, kind: 'locale', locale: src.doc.locale, role: 'source', issues: src.issues, rejected: src.doc.rejected, eligible: src.doc.eligible.review });
  const targets: LocaleDocument[] = [];
  for (const t of input.targets) {
    const r = parseLocale(t.bytes, { fileName: t.fileName, locale: t.locale, dialect: t.dialect, role: 'target' });
    issues.push(...r.issues);
    targets.push(r.doc);
    reports.push({ fileName: r.doc.fileName, kind: 'locale', locale: r.doc.locale, role: 'target', issues: r.issues, rejected: r.doc.rejected, eligible: r.doc.eligible.export });
  }
  let context: ContextMap = new Map<PathKey, ContextEntry>();
  if (input.context) {
    const c = parseContextFile(input.context.bytes, input.context.fileName);
    context = c.context;
    issues.push(...c.issues);
    reports.push({ fileName: input.context.fileName, kind: 'context', issues: c.issues, rejected: c.rejected });
  }
  let glossary: readonly GlossaryEntry[] = [];
  if (input.glossary) {
    const g = parseGlossaryFile(input.glossary.bytes, input.glossary.fileName);
    glossary = g.glossary;
    issues.push(...g.issues);
    reports.push({ fileName: input.glossary.fileName, kind: 'glossary', issues: g.issues, rejected: g.rejected });
  }
  return { source: src.doc, targets, context, glossary, issues, report: buildValidationReport(reports) };
}

// --- demo manifest (fixtures/demo/manifest.json) ---

const fileRefSchema = z.object({ path: z.string().min(1), locale: z.string().min(1), dialect: z.enum(['icu', 'i18next', 'plain']) }).strict();

export const demoManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    description: z.string(),
    sets: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string(),
            source: fileRefSchema,
            targets: z.array(fileRefSchema).min(1).max(MAX_TARGETS),
            context: z.string().optional(),
            glossary: z.string().optional(),
            replies: z.array(z.string()),
            sourceOverrides: z.array(z.object({ key: z.array(z.string()).min(1), note: z.string() }).strict()).optional(),
          })
          .strict(),
      )
      .min(1),
    broken: z.object({ set: z.string(), file: fileRefSchema, note: z.string() }).strict(),
    split: z.record(z.string(), z.unknown()),
    planted: z.array(
      z
        .object({
          set: z.string(),
          locale: z.string(),
          key: z.array(z.string()).min(1),
          /** Rule ids that must fire on this string. */
          expect: z.array(z.string()),
          /** Rule ids that must NOT fire on this string. */
          absent: z.array(z.string()).optional(),
          note: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type DemoManifest = z.infer<typeof demoManifestSchema>;
export type DemoSet = DemoManifest['sets'][number];

/** Reads a repository-relative path (e.g. "fixtures/demo/en.json"). */
export type ReadFile = (path: string) => Uint8Array;

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Import one demo set with the manifest's pinned locales and dialects. */
export function loadDemoSet(manifest: DemoManifest, setId: string, read: ReadFile): ImportResult {
  const set = manifest.sets.find((s) => s.id === setId);
  if (!set) throw new Error(`demo set "${setId}" not in manifest`);
  const file = (ref: z.infer<typeof fileRefSchema>): FileInput => ({ fileName: baseName(ref.path), bytes: read(ref.path), locale: ref.locale, dialect: ref.dialect });
  return importFiles({
    source: file(set.source),
    targets: set.targets.map(file),
    ...(set.context !== undefined ? { context: { fileName: baseName(set.context), bytes: read(set.context) } } : {}),
    ...(set.glossary !== undefined ? { glossary: { fileName: baseName(set.glossary), bytes: read(set.glossary) } } : {}),
  });
}

/** The "Load broken file" import: the broken set's source + the broken target only. */
export function loadBrokenDemo(manifest: DemoManifest, read: ReadFile): ImportResult {
  const set = manifest.sets.find((s) => s.id === manifest.broken.set);
  if (!set) throw new Error(`demo set "${manifest.broken.set}" not in manifest`);
  const ref = manifest.broken.file;
  return importFiles({
    source: { fileName: baseName(set.source.path), bytes: read(set.source.path), locale: set.source.locale, dialect: set.source.dialect },
    targets: [{ fileName: baseName(ref.path), bytes: read(ref.path), locale: ref.locale, dialect: ref.dialect }],
    ...(set.context !== undefined ? { context: { fileName: baseName(set.context), bytes: read(set.context) } } : {}),
    ...(set.glossary !== undefined ? { glossary: { fileName: baseName(set.glossary), bytes: read(set.glossary) } } : {}),
  });
}

// --- pipeline ---

export interface ReviewScope {
  readonly locales?: readonly string[];
  /** Key path prefix (segments). */
  readonly keyPrefix?: readonly string[];
  /** Only strings without error-level deterministic findings. */
  readonly errorFreeOnly?: boolean;
}

export interface PipelineOptions {
  /** Omit for a deterministic-only run. */
  readonly reviewer?: Reviewer;
  readonly reviewOptions?: ReviewOptions;
  readonly scope?: ReviewScope;
  /** ≤ 20 (MAX_BATCH_SIZE). */
  readonly batchSize?: number;
}

export interface ReviewItemRecord {
  readonly itemId: string;
  readonly fileName: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly dialect: Dialect;
  readonly sourceText: string;
  readonly targetText: string;
  readonly mask: MaskResult;
  readonly maxLength?: number;
}

/** The texts a finding was computed from (UI side-by-side view, fingerprints). */
export interface FindingTexts {
  readonly fileName: string;
  readonly sourceText: string;
  readonly targetText: string;
  /** Whether the target has a string at this key (false for missing keys and type mismatches). */
  readonly targetPresent: boolean;
}

export interface InvariantRecord {
  readonly itemId: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly violations: readonly InvariantViolation[];
}

export interface FileSummary {
  readonly fileName: string;
  readonly locale: string;
  readonly reviewed: boolean;
  readonly reason?: string;
  readonly exportEligible: boolean;
  readonly reviewedItems: number;
}

export interface PipelineResult {
  /** One-per-key source issues (subject 'source'). */
  readonly sourceFindings: readonly Finding[];
  /** Target findings, deterministic + model, errors first. */
  readonly findings: readonly Finding[];
  readonly rejections: readonly GateRejection[];
  readonly gate: GateStats;
  readonly dropped: number;
  readonly dropReasons: Readonly<Record<DropReason, number>>;
  /** Model findings dropped because an earlier finding had the same id (same string + category). */
  readonly duplicateFindings: number;
  /** Accepted fixes that failed the independent invariant check. Must always be empty. */
  readonly invariantViolations: readonly InvariantRecord[];
  readonly items: ReadonlyMap<string, ReviewItemRecord>;
  readonly texts: ReadonlyMap<string, FindingTexts>;
  /** Current fingerprint per finding id (rulings binding). */
  readonly fingerprints: ReadonlyMap<string, string>;
  /** stringKey of every target string in the import (rulings invalidation). */
  readonly knownStrings: ReadonlySet<string>;
  /** Deterministic findings per rule id (target + source). */
  readonly ruleCounts: Readonly<Record<string, number>>;
  readonly files: readonly FileSummary[];
  readonly batches: number;
  readonly reviewer: string | null;
}

export interface PreparedPipeline {
  /** Deterministic findings plus the exact local text/restore records; never send this object. */
  readonly base: PipelineResult;
  /** Frozen batches. Only record.mask.masked may cross a reviewer transport. */
  readonly batches: readonly (readonly ReviewItemRecord[])[];
  readonly scope: ReviewScope;
}

export interface PipelineProgress {
  readonly completedBatches: number;
  readonly totalBatches: number;
}

export interface PreparedRunOptions {
  readonly reviewer: Reviewer;
  readonly reviewOptions?: ReviewOptions;
  /** Checked before each batch; an in-flight call finishes and is retained. */
  readonly shouldCancel?: () => boolean;
  readonly onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineExecutionResult extends PipelineResult, PipelineProgress {
  readonly completion: 'complete' | 'cancelled' | 'error';
  /** Caller-facing error, never interpreted as a successful/mock run. */
  readonly error?: string;
}

function freezePlain<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePlain(child);
    Object.freeze(value);
  }
  return value;
}

function emptyDrops(): Record<DropReason, number> {
  return { malformed_reply: 0, schema: 0, not_in_batch: 0, key_mismatch: 0, locale_mismatch: 0 };
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((s, i) => path[i] === s);
}

function contextFor(context: ContextMap, path: readonly string[], sourcePath: readonly string[]): ContextEntry | undefined {
  return context.get(pathKey(sourcePath)) ?? context.get(pathKey(path));
}

/**
 * Review one batch: send masked items, validate the reply against THIS batch, gate every proposal,
 * check the invariant on every accepted fix.
 */
export async function reviewBatch(
  batch: readonly ReviewItemRecord[],
  reviewer: Reviewer,
  opts: ReviewOptions = {},
): Promise<BatchReviewResult & { readonly invariant: readonly InvariantRecord[] }> {
  if (batch.length === 0 || batch.length > MAX_BATCH_SIZE) throw new RangeError(`a batch holds 1..${MAX_BATCH_SIZE} items`);
  const gate = createGateStats();
  const reply = await reviewer.review(
    batch.map((r) => r.mask.masked),
    opts,
  );
  const batchItems: BatchItem[] = batch.map((r) => ({ masked: r.mask.masked, restore: r.mask.restore, key: r.key, sourceText: r.sourceText, targetText: r.targetText }));
  const byId = new Map(batch.map((r) => [r.itemId, r] as const));
  // Local heuristic claims share evidence/gate validation but are never attributed to a model
  // or assigned a deterministic l10nchecks rule id.
  const validation = await validateModelFindings(reply.rawFindings, batchItems, reviewer.id, reviewer.id === 'heuristic' ? 'static' : 'model');
  const findings: Finding[] = [];
  const rejections: GateRejection[] = [];
  const invariant: InvariantRecord[] = [];
  for (const vf of validation.findings) {
    const rec = byId.get(vf.finding.itemId);
    if (!rec || vf.proposalMasked === undefined) {
      findings.push(vf.finding);
      continue;
    }
    const result = validateFix(
      rec.targetText,
      vf.proposalMasked,
      rec.mask.restore,
      { dialect: rec.dialect, sourceText: rec.sourceText, notAllowed: rec.mask.notAllowed, ...(rec.maxLength !== undefined ? { maxLength: rec.maxLength } : {}) },
      gate,
    );
    if (!result.ok) {
      rejections.push({
        itemId: rec.itemId,
        key: rec.key,
        locale: rec.locale,
        category: vf.finding.category,
        reviewer: reviewer.id,
        findingId: vf.finding.id,
        proposal: vf.proposalMasked,
        reasons: result.reasons,
      });
      findings.push(vf.finding);
      continue;
    }
    if (result.text === rec.targetText) {
      findings.push(vf.finding); // a no-op proposal is not a suggestion
      continue;
    }
    const violations = invariantViolations(rec.targetText, result.text, rec.dialect);
    if (violations.length > 0) invariant.push({ itemId: rec.itemId, key: rec.key, locale: rec.locale, violations });
    findings.push({ ...vf.finding, suggestedFix: result.text, suggestedFixMasked: vf.proposalMasked, suggestionHash: await suggestionHash(result.text) });
  }
  return {
    findings,
    dropped: validation.dropped,
    dropReasons: validation.dropReasons,
    rejections,
    gate,
    invariant,
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
  };
}

export async function preparePipeline(imp: ImportResult, opts: Pick<PipelineOptions, 'scope' | 'batchSize'> = {}): Promise<PreparedPipeline> {
  const { source } = imp;
  const batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, opts.batchSize ?? MAX_BATCH_SIZE));
  const checks = runAllChecks(source, imp.targets, { context: imp.context, glossary: imp.glossary });

  const texts = new Map<string, FindingTexts>();
  const knownStrings = new Set<string>();
  const ruleCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const byId = new Map<string, Finding>();
  const addFinding = (f: Finding, t: FindingTexts): boolean => {
    const prev = byId.get(f.id);
    if (prev) {
      if (f.source === 'static' && prev.source === 'static' && prev.explanation !== f.explanation) {
        byId.set(f.id, { ...prev, explanation: `${prev.explanation}; ${f.explanation}` });
      }
      return false;
    }
    byId.set(f.id, f);
    texts.set(f.id, t);
    return true;
  };

  // Source issues.
  const sourceFindings: Finding[] = [];
  let srcN = 0;
  for (const df of checks.source) {
    ruleCounts[df.ruleId] = (ruleCounts[df.ruleId] ?? 0) + 1;
    const sourceText = resolveSourceText(source, df.path) ?? '';
    const f = await staticFinding(df, { itemId: `s-${srcN++}`, sourceText, targetText: '' });
    sourceFindings.push(f);
    texts.set(f.id, { fileName: source.fileName, sourceText, targetText: '', targetPresent: false });
  }

  // Item ids per target, in document order.
  const itemIds = imp.targets.map((doc, ti) => {
    const ids = new Map<PathKey, string>();
    let n = 0;
    for (const [k, e] of doc.entries) {
      ids.set(k, `t${ti}-k${n++}`);
      if (e.kind === 'string') knownStrings.add(stringKey(e.path, doc.locale));
    }
    return ids;
  });

  // Deterministic findings.
  for (let ti = 0; ti < imp.targets.length; ti++) {
    const doc = imp.targets[ti]!;
    const ids = itemIds[ti]!;
    let missingN = 0;
    for (const df of checks.byTarget.get(doc.fileName) ?? []) {
      ruleCounts[df.ruleId] = (ruleCounts[df.ruleId] ?? 0) + 1;
      const pk = pathKey(df.path);
      let itemId = ids.get(pk);
      if (itemId === undefined) {
        itemId = `t${ti}-m${missingN++}`;
        ids.set(pk, itemId);
      }
      const entry = doc.entries.get(pk);
      const targetPresent = entry !== undefined && entry.kind === 'string';
      const targetText = entry !== undefined && entry.kind === 'string' ? (entry.value as string) : '';
      const sourceText = resolveSourceText(source, df.path) ?? '';
      const f = await staticFinding(df, { itemId, sourceText, targetText });
      addFinding(f, { fileName: doc.fileName, sourceText, targetText, targetPresent });
    }
  }

  // Model review.
  const gate = createGateStats();
  const dropReasons = emptyDrops();
  const preparedBatches: Array<readonly ReviewItemRecord[]> = [];
  const rejections: GateRejection[] = [];
  const invariant: InvariantRecord[] = [];
  const items = new Map<string, ReviewItemRecord>();
  const files: FileSummary[] = [];
  const scope: ReviewScope = freezePlain({ ...opts.scope, ...(opts.scope?.locales ? { locales: [...opts.scope.locales] } : {}), ...(opts.scope?.keyPrefix ? { keyPrefix: [...opts.scope.keyPrefix] } : {}) });

  for (let ti = 0; ti < imp.targets.length; ti++) {
    const doc = imp.targets[ti]!;
    const ids = itemIds[ti]!;
    const exportEligible = !doc.rejected && doc.eligible.export && !source.rejected && source.eligible.export && doc.dialect === source.dialect;
    if (doc.rejected || !doc.eligible.review || source.rejected || !source.eligible.review || doc.dialect !== source.dialect) {
      files.push({ fileName: doc.fileName, locale: doc.locale, reviewed: false, reason: 'not eligible for model review (import errors)', exportEligible, reviewedItems: 0 });
      continue;
    }
    if (scope.locales !== undefined && !scope.locales.includes(doc.locale)) {
      files.push({ fileName: doc.fileName, locale: doc.locale, reviewed: false, reason: 'outside the selected locales', exportEligible, reviewedItems: 0 });
      continue;
    }
    const errorKeys = new Set<string>();
    if (scope.errorFreeOnly === true) {
      for (const df of checks.byTarget.get(doc.fileName) ?? []) if (df.severity === 'error') errorKeys.add(pathKey(df.path));
    }
    const records: ReviewItemRecord[] = [];
    for (const pair of alignDocuments(source, doc).pairs) {
      if (scope.keyPrefix !== undefined && !startsWith(pair.path, scope.keyPrefix)) continue;
      if (errorKeys.has(pathKey(pair.path))) continue;
      const itemId = ids.get(pathKey(pair.path));
      if (itemId === undefined) continue;
      const sourceText = pair.source.value as string;
      const targetText = pair.target.value as string;
      const ctxEntry = contextFor(imp.context, pair.path, pair.sourcePath) ?? (pair.family ? imp.context.get(pathKey(pair.family.basePath)) : undefined);
      const mask = maskItem({
        itemId,
        path: pair.path,
        locale: doc.locale,
        sourceLocale: source.locale,
        dialect: doc.dialect,
        source: sourceText,
        target: targetText,
        ...(ctxEntry !== undefined ? { context: ctxEntry } : {}),
        glossary: matchGlossary(sourceText, imp.glossary),
        siblings: selectSiblings(source, doc, pair.sourcePath),
      });
      const rec: ReviewItemRecord = {
        itemId,
        fileName: doc.fileName,
        key: pair.path,
        locale: doc.locale,
        dialect: doc.dialect,
        sourceText,
        targetText,
        mask,
        ...(ctxEntry?.maxLength !== undefined ? { maxLength: ctxEntry.maxLength } : {}),
      };
      freezePlain(mask.masked);
      const frozen = Object.freeze({ ...rec, key: Object.freeze([...rec.key]) });
      records.push(frozen);
      items.set(itemId, frozen);
    }
    for (let i = 0; i < records.length; i += batchSize) {
      preparedBatches.push(Object.freeze(records.slice(i, i + batchSize)));
    }
    files.push({ fileName: doc.fileName, locale: doc.locale, reviewed: false, reason: 'not reviewed yet', exportEligible, reviewedItems: 0 });
  }

  const findings = sortFindingsForReview([...byId.values()]);
  const fingerprints = new Map<string, string>();
  for (const f of [...findings, ...sourceFindings]) {
    const t = texts.get(f.id);
    if (t) fingerprints.set(f.id, await fingerprintForFinding(f, t.sourceText, t.targetText));
  }

  const base: PipelineResult = {
    sourceFindings,
    findings,
    rejections,
    gate,
    dropped: 0,
    dropReasons,
    duplicateFindings: 0,
    invariantViolations: invariant,
    items,
    texts,
    fingerprints,
    knownStrings,
    ruleCounts,
    files,
    batches: 0,
    reviewer: null,
  };
  return Object.freeze({ base, batches: Object.freeze(preparedBatches), scope });
}

/** Execute exactly the prepared batches, sequentially. A failure/cancel preserves every completed batch. */
export async function runPreparedPipeline(prepared: PreparedPipeline, opts: PreparedRunOptions): Promise<PipelineExecutionResult> {
  const { base } = prepared;
  const byId = new Map(base.findings.map((finding) => [finding.id, finding]));
  const texts = new Map(base.texts);
  const fingerprints = new Map(base.fingerprints);
  const gate = createGateStats();
  const dropReasons = emptyDrops();
  const rejections: GateRejection[] = [];
  const invariant: InvariantRecord[] = [];
  const reviewedItems = new Map<string, number>();
  let dropped = 0;
  let duplicateFindings = 0;
  let completedBatches = 0;
  let completion: PipelineExecutionResult['completion'] = 'complete';
  let error: string | undefined;
  for (const batch of prepared.batches) {
    if (opts.shouldCancel?.()) { completion = 'cancelled'; break; }
    try {
      const reviewed = await reviewBatch(batch, opts.reviewer, opts.reviewOptions ?? {});
      mergeGateStats(gate, reviewed.gate);
      dropped += reviewed.dropped;
      for (const reason of Object.keys(reviewed.dropReasons) as DropReason[]) dropReasons[reason] += reviewed.dropReasons[reason];
      rejections.push(...reviewed.rejections);
      invariant.push(...reviewed.invariant);
      for (const finding of reviewed.findings) {
        const record = base.items.get(finding.itemId);
        if (!record) continue;
        if (byId.has(finding.id)) { duplicateFindings++; continue; }
        const fingerprint = await fingerprintForFinding(finding, record.sourceText, record.targetText);
        byId.set(finding.id, finding);
        texts.set(finding.id, { fileName: record.fileName, sourceText: record.sourceText, targetText: record.targetText, targetPresent: true });
        fingerprints.set(finding.id, fingerprint);
      }
      for (const record of batch) reviewedItems.set(record.fileName, (reviewedItems.get(record.fileName) ?? 0) + 1);
      completedBatches++;
      opts.onProgress?.({ completedBatches, totalBatches: prepared.batches.length });
    } catch (cause) {
      completion = 'error';
      error = cause instanceof Error ? cause.message : 'Reviewer execution failed.';
      break;
    }
  }
  const files = base.files.map((file): FileSummary => {
    if (file.reason !== 'not reviewed yet') return file;
    const planned = prepared.batches.flat().filter((record) => record.fileName === file.fileName).length;
    const count = reviewedItems.get(file.fileName) ?? 0;
    return { ...file, reviewed: count === planned, reviewedItems: count, ...(count === planned ? { reason: undefined } : { reason: `${completion}: reviewed ${count} of ${planned} planned strings` }) };
  });
  return { ...base, findings: sortFindingsForReview([...byId.values()]), texts, fingerprints, files, gate, rejections, invariantViolations: invariant, dropped, dropReasons, duplicateFindings, reviewer: opts.reviewer.id, batches: completedBatches, completedBatches, totalBatches: prepared.batches.length, completion, ...(error ? { error } : {}) };
}

/** Legacy entry point: deterministic-only by default; reviewer failures still reject. */
export async function runPipeline(imp: ImportResult, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const prepared = await preparePipeline(imp, opts);
  if (!opts.reviewer) return { ...prepared.base, items: new Map(), files: prepared.base.files.map((file) => ({ ...file, reviewed: false, reason: 'deterministic checks only' })) };
  const result = await runPreparedPipeline(prepared, { reviewer: opts.reviewer, ...(opts.reviewOptions ? { reviewOptions: opts.reviewOptions } : {}) });
  if (result.completion === 'error') throw new Error(result.error ?? 'Reviewer execution failed.');
  return result;
}

// --- summary (scripts/demo.ts and the demo snapshot test print / compare the same text) ---

export function summarizePipeline(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push(`reviewer: ${result.reviewer ?? 'none (deterministic only)'}`);
  for (const f of result.files) {
    lines.push(`file ${f.fileName} (${f.locale}): ${f.reviewed ? `reviewed ${f.reviewedItems} item(s)` : `not reviewed — ${f.reason ?? ''}`}; export ${f.exportEligible ? 'enabled' : 'DISABLED'}`);
  }
  lines.push('deterministic findings by rule:');
  for (const rule of Object.keys(result.ruleCounts).sort()) lines.push(`  ${rule}: ${result.ruleCounts[rule]}`);
  const model = result.findings.filter((f) => f.source === 'model');
  if (result.reviewer === 'heuristic') lines.push(`local heuristic findings: ${result.findings.filter((f) => f.reviewer === 'heuristic').length} (non-model comparison floor)`);
  lines.push(
    `model findings: ${model.length} (supported ${model.filter((f) => f.evidenceStatus === 'supported').length}, unsupported ${model.filter((f) => f.evidenceStatus === 'unsupported').length}, with gated fix ${model.filter((f) => f.suggestedFix !== undefined).length}); dropped ${result.dropped}; duplicate ids ${result.duplicateFindings}; batches ${result.batches}`,
  );
  for (const k of Object.keys(result.dropReasons).sort() as DropReason[]) if (result.dropReasons[k] > 0) lines.push(`  dropped ${k}: ${result.dropReasons[k]}`);
  lines.push(`gate: checked ${result.gate.checked}, accepted ${result.gate.accepted}, rejected ${result.gate.rejected}`);
  lines.push('gate rejections by reason:');
  for (const [reason, n] of Object.entries(result.gate.byReason)) if (n > 0) lines.push(`  ${reason}: ${n}`);
  lines.push(`invariant violations: ${result.invariantViolations.length}`);
  return lines.join('\n');
}
