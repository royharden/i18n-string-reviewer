// Node-only evaluation entry point. Importing this module never starts an evaluation.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BudgetRefusalError, withBudgetSession } from '../src/core/callledger/budget.ts';
import type { BudgetSession } from '../src/core/callledger/budget.ts';
import { appendLedgerRecord, usdUnits } from '../src/core/callledger/ledger.ts';
import { checkEvidence, FINDING_CATEGORIES, rawModelFindingSchema } from '../src/core/cited/finding.ts';
import { generateMutations, MUTATION_VERSION } from '../src/core/evalkit/mutate.ts';
import { cleanFalsePositives, scoreUnits } from '../src/core/evalkit/metrics.ts';
import type { EvaluationScenario, ScoringUnit } from '../src/core/evalkit/metrics.ts';
import { renderEvaluation } from '../src/core/evalkit/render.ts';
import type { ContextPair, EvaluationReport, MethodEvaluation, MethodObservations, SampleFix } from '../src/core/evalkit/render.ts';
import { splitForKey } from '../src/core/evalkit/split.ts';
import type { Split } from '../src/core/evalkit/split.ts';
import { icuPathSignature } from '../src/core/l10nchecks/icu.ts';
import { pathKey } from '../src/core/l10nchecks/paths.ts';
import { tokenizePlaceholders } from '../src/core/l10nchecks/placeholders.ts';
import { parsePluralSuffix } from '../src/core/l10nchecks/plural.ts';
import { runChecks, checkVersion } from '../src/core/l10nchecks/runChecks.ts';
import { buildTagTree, canonicalTagForm } from '../src/core/l10nchecks/tags.ts';
import { ERROR_RULE_IDS, WARNING_RULE_IDS } from '../src/core/l10nchecks/types.ts';
import type { LocaleDocument, Dialect } from '../src/core/l10nchecks/types.ts';
import { validateFix } from '../src/core/maskgate/gate.ts';
import { maskItem } from '../src/core/maskgate/mask.ts';
import { createAnthropicProvider } from '../src/core/providers/anthropic.ts';
import type { Provider } from '../src/core/providers/types.ts';
import { buildHeuristicPolicies, createHeuristicReviewer } from '../src/core/review/heuristic.ts';
import { jevThresholdConfigSchema } from '../src/core/review/jev.ts';
import { createLlmReviewer } from '../src/core/review/llm.ts';
import type { ReviewTransport } from '../src/core/review/llm.ts';
import { parseReplyFile } from '../src/core/review/mock.ts';
import type { ReplyFile } from '../src/core/review/mock.ts';
import { demoManifestSchema, importFiles, loadDemoSet, preparePipeline, reviewBatch } from '../src/core/review/pipeline.ts';
import type { ImportResult, PreparedPipeline, ReviewItemRecord } from '../src/core/review/pipeline.ts';
import type { Reviewer } from '../src/core/review/types.ts';
import { estimateRequest, requestHash } from '../src/core/shared/estimate.ts';
import { actualCostUsd, PRICE_TABLE_VERSION, priceFor } from '../src/core/shared/prices.ts';
import { buildProviderRequest, DEFAULT_ANTHROPIC_MODEL_ID, PROMPT_VERSION } from '../src/core/shared/prompt.ts';
import { ProviderError } from '../src/core/shared/transport.ts';
import type { ProviderResult } from '../src/core/shared/transport.ts';
import { parseReviewRequest, redactItems } from '../src/core/shared/wire.ts';

export const EVAL_VERSION = 's34-eval-2026-10-24-v1';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// These locations are deliberately independent of cwd, output flags, cache flags and dataset flags.
export const HELDOUT_LOCK = join(ROOT, 'results', 'heldout.lock');
const CACHE = join(ROOT, '.cache');
const RESULTS = join(ROOT, 'results');
export const HELP = `Usage: tsx scripts/eval.ts [--split dev|heldout] [--live] [--help]
Default: dev split, recorded-reply replay plus deterministic checks and local heuristic floor.
--live adds both matched LLM context-off/on rows; requires finite positive EVAL_MAX_USD
and ANTHROPIC_API_KEY. ANTHROPIC_MODEL_ID must be in the pinned price table.
Heldout consumes the fixed results/heldout.lock once, including mock runs and failed runs.
No rerun, dataset, root, output-directory or lock override exists. A changed dataset requires heldout-v2.
Outputs: results/{results.md,results.jsonl,failures.md,adjudication.md,call-ledger.jsonl}.
Jev/cascade remain unmeasured pending the explicit dev probe and held-out admission criteria.
`;

export interface EvalConfig { readonly split: Split; readonly live: boolean; readonly help: boolean; readonly maxUsd?: number; readonly modelId: string }
export function parseEvalArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>>): EvalConfig {
  let split: Split = 'dev'; let live = false; let help = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error('duplicate_option');
    seen.add(arg);
    if (arg === '--live') live = true;
    else if (arg === '--help') help = true;
    else if (arg === '--split') {
      const value = args[++i];
      if (value !== 'dev' && value !== 'heldout') throw new Error('invalid_split');
      split = value;
    } else throw new Error('unknown_option');
  }
  const modelId = env['ANTHROPIC_MODEL_ID']?.trim() || DEFAULT_ANTHROPIC_MODEL_ID;
  if (help) return { split, live, help, modelId };
  if (!live) return { split, live, help, modelId };
  const rawCap = env['EVAL_MAX_USD'];
  const maxUsd = rawCap?.trim() ? Number(rawCap) : NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd < 0.00000001) throw new Error('explicit_finite_positive_EVAL_MAX_USD_required');
  try { usdUnits(maxUsd, 'down'); } catch { throw new Error('explicit_finite_positive_EVAL_MAX_USD_required'); }
  if (!env['ANTHROPIC_API_KEY']?.trim()) throw new Error('ANTHROPIC_API_KEY_required');
  priceFor('anthropic', modelId);
  return { split, live, help, maxUsd, modelId };
}

/** A permanent marker, never a mutex to be released. Failure after creation keeps the marker. */
export async function consumeHeldoutLock(path: string, versions: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ schemaVersion: 1, dataset: 'fixtures/manifest.json', versions }) + '\n'); await file.sync(); }
  finally { await file.close(); }
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1), seed: z.number().int(),
  files: z.array(z.object({ path: z.string().min(1), locale: z.string().min(1), dialect: z.enum(['icu', 'i18next', 'plain']), role: z.enum(['source', 'target']), corpus: z.string().min(1) }).strict()).min(2),
  context: z.string(), glossary: z.string(), labels: z.object({ semantic: z.string(), semanticCorpus: z.string(), mutations: z.string() }),
  mutation: z.object({ seed: z.number().int(), generator: z.string(), operators: z.string() }),
  split: z.object({ by: z.literal('source_key'), dev: z.literal(0.6), heldout: z.literal(0.4), rule: z.string().min(1) }).passthrough(),
  heldoutFrozenAt: z.literal('2026-10-24'), freeze: z.string().min(1), authorship: z.string().min(1), seedSelection: z.unknown(),
}).passthrough();
const labelSchema = z.object({ id: z.string().min(1), key: z.array(z.string()).min(1), locale: z.string(), category: z.enum(FINDING_CATEGORIES), severity: z.enum(['minor', 'major', 'critical']), contextDependent: z.boolean(), plantedTarget: z.string(), what_bug_this_catches: z.string().min(1), author: z.string().min(1), split: z.enum(['dev', 'heldout']) }).strict();
type SemanticLabel = z.infer<typeof labelSchema>;
interface Corpus { readonly id: string; readonly imported: ImportResult }
interface FixtureData { readonly manifest: z.infer<typeof manifestSchema>; readonly labels: readonly SemanticLabel[]; readonly corpora: readonly Corpus[]; readonly versions: Readonly<Record<string, string>>; readonly replies: readonly { name: string; file: ReplyFile }[]; readonly demos: ReadonlyMap<string, ImportResult> }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function fixturePath(relative: string): string {
  const path = resolve(ROOT, relative);
  if (!path.startsWith(ROOT) || !relative.startsWith('fixtures/') || relative.includes('..') || relative.includes('\\')) throw new Error('invalid_fixture_path');
  return path;
}
const bytes = async (relative: string): Promise<Uint8Array> => readFile(fixturePath(relative));
const text = async (relative: string): Promise<string> => readFile(fixturePath(relative), 'utf8');
const json = async (relative: string): Promise<unknown> => JSON.parse(await text(relative)) as unknown;

export function sourceKey(key: readonly string[], dialect: Dialect): string[] {
  const suffix = dialect === 'i18next' ? parsePluralSuffix(key.at(-1) ?? '') : null;
  return suffix ? [...key.slice(0, -1), suffix.base] : [...key];
}
function splitDocument(doc: LocaleDocument, split: Split, seed: number, extra?: readonly string[]): LocaleDocument {
  const entries = new Map([...doc.entries].filter(([, e]) => splitForKey(sourceKey(e.path, doc.dialect), { seed, dev: 0.6 }) === split || (extra !== undefined && pathKey(e.path) === pathKey(extra))));
  const paths = [...entries.values()].map((e) => e.path);
  const containers = new Map([...(doc.containers ?? [])].filter(([, p]) => paths.some((key) => p.length < key.length && p.every((part, i) => part === key[i]))));
  return { ...doc, entries, containers };
}
function plantedDocument(doc: LocaleDocument, label: SemanticLabel): LocaleDocument {
  const entries = new Map(doc.entries); const key = pathKey(label.key); const entry = entries.get(key);
  if (entry?.kind !== 'string') throw new Error('semantic_label_target_missing');
  entries.set(key, { ...entry, value: label.plantedTarget });
  return { ...doc, entries };
}
async function loadFixtures(): Promise<FixtureData> {
  const manifestText = await text('fixtures/manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (manifest.seed !== manifest.mutation.seed) throw new Error('mutation_seed_mismatch');
  const labelText = await text(manifest.labels.semantic);
  const labels = labelText.split(/\r?\n/u).filter((line) => line.trim()).map((line) => labelSchema.parse(JSON.parse(line) as unknown));
  if (labels.length < 55 || labels.filter((label) => label.contextDependent).length < 30) throw new Error('semantic_label_floor_missing');
  if (new Set(labels.map((label) => label.id)).size !== labels.length) throw new Error('duplicate_semantic_label');
  const context = await bytes(manifest.context); const glossary = await bytes(manifest.glossary);
  const raw = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    if (raw.has(file.path)) throw new Error('duplicate_manifest_path');
    raw.set(file.path, await bytes(file.path));
  }
  const corpora: Corpus[] = [];
  for (const id of new Set(manifest.files.map((file) => file.corpus))) {
    const files = manifest.files.filter((file) => file.corpus === id); const sources = files.filter((file) => file.role === 'source');
    const source = sources[0]; if (sources.length !== 1 || !source) throw new Error('invalid_corpus_source');
    const input = (file: (typeof files)[number]) => ({ fileName: file.path, bytes: raw.get(file.path)!, locale: file.locale, dialect: file.dialect });
    const imported = importFiles({ source: input(source), targets: files.filter((file) => file.role === 'target').map(input), context: { fileName: manifest.context, bytes: context }, glossary: { fileName: manifest.glossary, bytes: glossary } });
    if (imported.issues.some((issue) => issue.severity === 'error') || imported.source.rejected || imported.targets.some((doc) => doc.rejected)) throw new Error('invalid_corpus_import');
    corpora.push({ id, imported });
  }
  const semantic = corpora.find((corpus) => corpus.id === manifest.labels.semanticCorpus);
  if (!semantic) throw new Error('semantic_corpus_missing');
  for (const label of labels) {
    if (splitForKey(label.key, { seed: manifest.seed, dev: manifest.split.dev }) !== label.split || !semantic.imported.source.entries.has(pathKey(label.key)) || semantic.imported.targets.find((doc) => doc.locale === label.locale)?.entries.get(pathKey(label.key))?.kind !== 'string') throw new Error('semantic_label_binding_or_split_mismatch');
  }
  const thresholdText = await readFile(join(ROOT, 'config/thresholds.json'), 'utf8');
  const thresholds = jevThresholdConfigSchema.parse(JSON.parse(thresholdText) as unknown);
  const replyNames = (await readdir(join(ROOT, 'fixtures/replies'))).filter((name) => name.endsWith('.json')).sort();
  const replies = await Promise.all(replyNames.map(async (name) => ({ name, file: parseReplyFile(await json(`fixtures/replies/${name}`), name) })));
  const demoManifest = demoManifestSchema.parse(await json('fixtures/demo/manifest.json'));
  const demoRaw = new Map<string, Uint8Array>();
  for (const set of demoManifest.sets) for (const file of [set.source, ...set.targets]) demoRaw.set(file.path, await bytes(file.path));
  // Metadata references are part of the demo manifest, not hard-coded evaluation corpus data.
  const demoContext = await bytes('fixtures/demo/context.json'); const demoGlossary = await bytes('fixtures/demo/glossary.json');
  demoRaw.set('fixtures/demo/context.json', demoContext); demoRaw.set('fixtures/demo/glossary.json', demoGlossary);
  const demos = new Map(demoManifest.sets.map((set) => [set.id, loadDemoSet(demoManifest, set.id, (path) => { const value = demoRaw.get(path); if (!value) throw new Error('demo_manifest_reference_missing'); return value; })]));
  for (const { file } of replies) for (const reply of file.replies) if (!reply.item) {
    const demo = demos.get(file.set); const target = demo?.targets.find((doc) => doc.locale === reply.locale);
    if (!demo || !target || !demo.source.entries.has(pathKey(reply.key)) || target.entries.get(pathKey(reply.key))?.kind !== 'string') throw new Error('unbound_recorded_reply');
  }
  const corpusDigest = digest([...raw].map(([path, data]) => `${path}\u0000${Buffer.from(data).toString('utf8')}`).join('\u0000') + labelText + Buffer.from(context).toString('utf8') + Buffer.from(glossary).toString('utf8'));
  return { manifest, labels, corpora, replies, demos, versions: { evaluation: EVAL_VERSION, manifest: digest(manifestText), corpus: corpusDigest, prompt: PROMPT_VERSION, rules: checkVersion, mutations: MUTATION_VERSION, thresholds: thresholds.version, thresholdHash: digest(thresholdText), prices: PRICE_TABLE_VERSION, split: manifest.split.rule, heldoutFrozenAt: manifest.heldoutFrozenAt } };
}

export interface ProposalAudit extends SampleFix { readonly exportable: boolean; readonly invariantViolations: readonly string[] }
function same(a: readonly string[] | null, b: readonly string[] | null): boolean { return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b); }
/** Independent of the gate's structural-signature/compare helpers. */
export function independentInvariant(current: string, fix: string, dialect: Dialect): string[] {
  const violations: string[] = [];
  if (dialect === 'icu' && !same(icuPathSignature(current), icuPathSignature(fix))) violations.push('path_signature');
  const before = tokenizePlaceholders(current, dialect); const after = tokenizePlaceholders(fix, dialect);
  if (after.errors.length || !same(before.tokens.map((token) => token.identity).sort(), after.tokens.map((token) => token.identity).sort())) violations.push('placeholders');
  if (!same(before.tokens.filter((token) => token.ordered).map((token) => token.identity), after.tokens.filter((token) => token.ordered).map((token) => token.identity))) violations.push('printf_order');
  const a = buildTagTree(current); const b = buildTagTree(fix);
  if (b.errors.length || canonicalTagForm(a.children) !== canonicalTagForm(b.children)) violations.push('tag_tree');
  return violations;
}
/** Audit before schema/evidence filtering, so unsupported and misdirected proposals cannot vanish. */
export function auditRawProposals(raw: unknown, records: readonly ReviewItemRecord[], scenarioId: string): ProposalAudit[] {
  const list: unknown = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['findings'] : undefined;
  if (!Array.isArray(list)) return [];
  const out: ProposalAudit[] = [];
  for (const candidate of list) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>; if (typeof item['suggestedFix'] !== 'string') continue;
    const record = records.find((r) => r.itemId === item['itemId']);
    const claimedKey = Array.isArray(item['key']) && item['key'].every((part: unknown) => typeof part === 'string') ? item['key'] as string[] : ['(unbound)'];
    const locale = typeof item['locale'] === 'string' ? item['locale'] : '(unbound)';
    if (!record) { out.push({ scenarioId, key: claimedKey, locale, before: '', proposal: item['suggestedFix'], accepted: false, reasons: ['unbound_proposal'], exportable: false, invariantViolations: [] }); continue; }
    const gate = validateFix(record.targetText, item['suggestedFix'], record.mask.restore, { dialect: record.dialect, sourceText: record.sourceText, notAllowed: record.mask.notAllowed, ...(record.maxLength === undefined ? {} : { maxLength: record.maxLength }) });
    const bound = same(claimedKey, record.mask.masked.key) && locale === record.locale;
    const supported = typeof item['evidence'] === 'string' && checkEvidence(item['evidence'], record.mask.masked.target, record.mask.restore, record.targetText).status === 'supported';
    const schemaValid = rawModelFindingSchema.safeParse(item).success;
    const violations = gate.ok ? independentInvariant(record.targetText, gate.text, record.dialect) : [];
    out.push({ scenarioId, key: [...record.key], locale: record.locale, before: record.targetText, proposal: item['suggestedFix'], accepted: gate.ok, reasons: gate.ok ? [] : [...gate.reasons], exportable: bound && supported && schemaValid && gate.ok && gate.text !== record.targetText && violations.length === 0, invariantViolations: violations });
  }
  return out;
}

const cacheSchema = z.object({ schemaVersion: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/u), provider: z.literal('anthropic'), modelId: z.string(), promptVersion: z.string(), priceTableVersion: z.string(), sourceLedgerId: z.string().uuid(), originalCostUsd: z.number().finite().nonnegative(), result: z.object({ value: z.unknown(), usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(), rawUsage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(), latencyMs: z.number().int().nonnegative(), retries: z.literal(0) }).strict() }).strict();
export interface TransportEvent { readonly kind: 'dispatch' | 'cache-hit' | 'error'; readonly requestHash: string; readonly sourceLedgerId?: string; readonly status: string; readonly costUsd: number | null; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly originalCostUsd?: number; readonly cachedInputTokens?: number; readonly cachedOutputTokens?: number }
export function safeError(error: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof BudgetRefusalError) return error.reservation.created ? error.reservation.status : 'duplicate_attempt';
  if (error !== null && typeof error === 'object' && 'code' in error && ['EEXIST', 'EACCES', 'ENOSPC'].includes(String(error.code))) return String(error.code);
  const allowed = ['invalid_response_cache', 'cache_provenance_mismatch', 'incomplete_evaluation_results_written', 'invariant_violation_results_written', 'duplicate_option', 'unknown_option', 'invalid_split', 'explicit_finite_positive_EVAL_MAX_USD_required', 'ANTHROPIC_API_KEY_required', 'model_not_priced'];
  return error instanceof Error && allowed.includes(error.message) ? error.message : 'evaluation_failed';
}
export function createMeteredTransport(options: { session: BudgetSession; provider: Provider; cacheDir: string; ledgerPath: string; modelId: string; events: TransportEvent[] }): ReviewTransport {
  return async (raw) => {
    const request = parseReviewRequest(raw);
    if (request.reviewer !== 'llm') throw new Error('experimental_provider_not_enabled');
    const providerRequest = buildProviderRequest({ reviewer: request.reviewer, items: redactItems(request.items), withContext: request.withContext, anthropicModelId: options.modelId });
    const hash = await requestHash(providerRequest); const cachePath = join(options.cacheDir, 'responses', `${hash}.json`);
    let cached: z.infer<typeof cacheSchema> | undefined;
    try { cached = cacheSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')) as unknown); }
    catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        options.events.push({ kind: 'error', requestHash: hash, status: 'invalid_response_cache', costUsd: 0, inputTokens: 0, outputTokens: 0 });
        throw new Error('invalid_response_cache');
      }
    }
    if (cached) {
      const origin = options.session.snapshot().entries.find((row) => row.ledgerId === cached.sourceLedgerId);
      if (cached.requestHash !== hash || cached.modelId !== providerRequest.modelId || cached.promptVersion !== providerRequest.promptVersion || cached.priceTableVersion !== PRICE_TABLE_VERSION || cached.result.usage.inputTokens !== cached.result.rawUsage.input_tokens || cached.result.usage.outputTokens !== cached.result.rawUsage.output_tokens || cached.originalCostUsd !== actualCostUsd('anthropic', providerRequest.modelId, cached.result.usage)
        || !origin || origin.status !== 'ok' || origin.provider !== 'anthropic' || origin.promptHash !== hash || origin.modelId !== cached.modelId || origin.priceTableVersion !== cached.priceTableVersion || origin.inputTokens !== cached.result.usage.inputTokens || origin.outputTokens !== cached.result.usage.outputTokens || origin.costUsd !== cached.originalCostUsd) {
        options.events.push({ kind: 'error', requestHash: hash, status: 'cache_provenance_mismatch', costUsd: 0, inputTokens: 0, outputTokens: 0 });
        throw new Error('cache_provenance_mismatch');
      }
      options.events.push({ kind: 'cache-hit', requestHash: hash, sourceLedgerId: cached.sourceLedgerId, status: 'cached', costUsd: 0, inputTokens: 0, outputTokens: 0, originalCostUsd: cached.originalCostUsd, cachedInputTokens: cached.result.usage.inputTokens, cachedOutputTokens: cached.result.usage.outputTokens });
      return { reviewer: 'llm', rawFindings: cached.result.value, usage: cached.result.usage, ledgerId: cached.sourceLedgerId };
    }
    const estimate = estimateRequest(providerRequest); const previous = new Set(options.session.snapshot().entries.map((row) => row.ledgerId));
    let dispatchRecorded = false;
    try {
      const called = await options.session.call({ requestId: request.requestId, attempt: request.attempt, provider: providerRequest.provider, modelId: providerRequest.modelId, promptHash: hash, questionIds: providerRequest.questionIds, priceTableVersion: PRICE_TABLE_VERSION, estimateUsd: estimate.estimateUsd }, async () => {
        const result = await options.provider.complete(providerRequest);
        return { value: result, actualUsd: actualCostUsd(providerRequest.provider, providerRequest.modelId, result.usage), ...result.usage, rawUsage: result.rawUsage, latencyMs: result.latencyMs };
      });
      const result: ProviderResult = called.value;
      options.events.push({ kind: 'dispatch', requestHash: hash, sourceLedgerId: called.ledger.ledgerId, status: called.ledger.status, costUsd: called.ledger.costUsd, inputTokens: called.ledger.inputTokens, outputTokens: called.ledger.outputTokens });
      dispatchRecorded = true;
      const cache = cacheSchema.parse({ schemaVersion: 1, requestHash: hash, provider: 'anthropic', modelId: providerRequest.modelId, promptVersion: providerRequest.promptVersion, priceTableVersion: PRICE_TABLE_VERSION, sourceLedgerId: called.ledger.ledgerId, originalCostUsd: called.ledger.costUsd, result });
      await mkdir(dirname(cachePath), { recursive: true });
      const temporary = `${cachePath}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(cache) + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, cachePath);
      return { reviewer: 'llm', rawFindings: result.value, usage: result.usage, ledgerId: called.ledger.ledgerId };
    } catch (error) {
      const knownNoAdditionalCharge = error instanceof BudgetRefusalError || dispatchRecorded;
      options.events.push({ kind: 'error', requestHash: hash, status: dispatchRecorded ? 'post_dispatch_persistence_failure' : safeError(error), costUsd: knownNoAdditionalCharge ? 0 : null, inputTokens: knownNoAdditionalCharge ? 0 : null, outputTokens: knownNoAdditionalCharge ? 0 : null });
      throw error;
    } finally {
      // Includes refused and unknown reservations. Append only allowlisted terminal metadata.
      for (const row of options.session.snapshot().entries) if (!previous.has(row.ledgerId)) await appendLedgerRecord(options.ledgerPath, row);
    }
  };
}

interface MethodData { scenarios: EvaluationScenario[]; truth: ScoringUnit[]; predictions: ScoringUnit[]; fixes: ProposalAudit[]; evidenceValid: number; evidenceTotal: number; replyCount: number; stringCount: number; events: TransportEvent[]; detected: Map<string, boolean> }
function methodData(): MethodData { return { scenarios: [], truth: [], predictions: [], fixes: [], evidenceValid: 0, evidenceTotal: 0, replyCount: 0, stringCount: 0, events: [], detected: new Map() }; }
function observations(data: MethodData): MethodObservations {
  const reasons: Record<string, number> = {};
  for (const fix of data.fixes) if (!fix.accepted) for (const reason of fix.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  const known = data.events.every((event) => event.costUsd !== null);
  return { evidenceValid: data.evidenceValid, evidenceTotal: data.evidenceTotal, proposalsAccepted: data.fixes.filter((fix) => fix.accepted).length, proposalsRejected: data.fixes.filter((fix) => !fix.accepted).length, proposalRejectedByReason: reasons, invariantViolations: data.fixes.filter((fix) => fix.invariantViolations.length > 0).length, invariantChecked: data.fixes.filter((fix) => fix.accepted).length, replyCount: data.replyCount, stringCount: data.stringCount, costUsd: known ? data.events.reduce((sum, event) => sum + event.costUsd!, 0) : null, inputTokens: known ? data.events.reduce((sum, event) => sum + event.inputTokens!, 0) : null, outputTokens: known ? data.events.reduce((sum, event) => sum + event.outputTokens!, 0) : null };
}
async function evaluateSemantic(data: MethodData, scenario: EvaluationScenario, prepared: PreparedPipeline, reviewer: Reviewer, withContext: boolean): Promise<void> {
  data.scenarios.push(scenario);
  for (const batch of prepared.batches) {
    const audited: Reviewer = { id: reviewer.id, label: reviewer.label, async review(items, opts) { const reply = await reviewer.review(items, opts); data.replyCount++; data.fixes.push(...auditRawProposals(reply.rawFindings, batch, scenario.id)); return reply; } };
    const result = await reviewBatch(batch, audited, { withContext });
    data.stringCount += batch.length;
    for (const finding of result.findings) {
      // Heuristic is static/reviewer=heuristic with no deterministic ruleId (M5 attribution).
      if (finding.reviewer !== reviewer.id || finding.ruleId !== undefined) continue;
      data.predictions.push({ scenarioId: scenario.id, corpus: scenario.corpus, key: finding.key, locale: finding.locale, label: finding.category });
      data.evidenceTotal++; if (finding.evidenceStatus === 'supported') data.evidenceValid++;
    }
  }
}
function onlyLabel(prepared: PreparedPipeline, label: SemanticLabel): PreparedPipeline {
  return { ...prepared, batches: prepared.batches.map((batch) => batch.filter((record) => record.locale === label.locale && pathKey(record.key) === pathKey(label.key))).filter((batch) => batch.length > 0) };
}
async function auditRecordedReplies(fixtures: FixtureData): Promise<MethodData> {
  const data = methodData();
  for (const { name, file } of fixtures.replies) for (const reply of file.replies) {
    let record: ReviewItemRecord;
    if (reply.item) {
      const itemId = `reply-${reply.id}`; const item = reply.item;
      const mask = maskItem({ itemId, path: reply.key, locale: reply.locale, sourceLocale: item.sourceLocale, dialect: item.dialect, source: item.source, target: item.target, ...(item.maxLength === undefined ? {} : { context: { maxLength: item.maxLength } }) });
      record = { itemId, fileName: name, key: reply.key, locale: reply.locale, dialect: item.dialect, sourceText: item.source, targetText: item.target, mask, ...(item.maxLength === undefined ? {} : { maxLength: item.maxLength }) };
    } else {
      const demo = fixtures.demos.get(file.set); if (!demo) throw new Error('unbound_recorded_reply');
      const prepared = await preparePipeline(demo); const found = prepared.batches.flat().find((item) => item.locale === reply.locale && pathKey(item.key) === pathKey(reply.key));
      if (!found) throw new Error('unbound_recorded_reply'); record = found;
    }
    for (const [variant, findings] of [reply.findings, ...(reply.regenerate === undefined ? [] : [reply.regenerate])].entries()) {
      const raw = findings.map((finding) => ({ itemId: finding.misdirect?.itemId ?? record.itemId, key: finding.misdirect?.key ?? record.mask.masked.key, locale: finding.misdirect?.locale ?? record.locale, category: finding.category, severity: finding.severity, explanation: finding.explanation, evidence: finding.evidence, ...(finding.suggestedFix === undefined ? {} : { suggestedFix: finding.suggestedFix }) }));
      const scenarioId = `${name}/${reply.id}/variant-${variant}`;
      data.replyCount++; data.stringCount++; data.fixes.push(...auditRawProposals(raw, [record], scenarioId));
      const result = await reviewBatch([record], { id: 'mock', label: 'recorded replay', review: async () => ({ rawFindings: raw }) });
      data.evidenceTotal += result.findings.length; data.evidenceValid += result.findings.filter((finding) => finding.evidenceStatus === 'supported').length;
    }
  }
  return data;
}

async function evaluate(fixtures: FixtureData, config: EvalConfig, session?: BudgetSession, provider?: Provider): Promise<void> {
  const seed = fixtures.manifest.seed; const split = config.split; const methods: MethodEvaluation[] = [];
  // Surface historical origins and any crash recovery (reserved -> unknown/full) in JSONL too.
  // This append-only file contains terminal snapshots, not one unique row per ledger ID.
  if (session) for (const row of session.snapshot().entries) await appendLedgerRecord(join(RESULTS, 'call-ledger.jsonl'), row);
  const structuralScenarios: EvaluationScenario[] = []; const structuralTruth: ScoringUnit[] = []; const structuralPredictions: ScoringUnit[] = [];
  const cleanFindings: Array<ScoringUnit & { severity: 'error' | 'warning' }> = []; let cleanStrings = 0;
  const corpora = fixtures.corpora.map((corpus) => ({ id: corpus.id, imported: { ...corpus.imported, source: splitDocument(corpus.imported.source, split, seed), targets: corpus.imported.targets.map((doc) => splitDocument(doc, split, seed)) } }));
  const mutations = generateMutations({ corpora: fixtures.corpora.flatMap((corpus) => corpus.imported.targets.map((target) => ({ id: corpus.id, source: corpus.imported.source, target, options: { context: corpus.imported.context, glossary: corpus.imported.glossary } }))), seed, split: { dev: fixtures.manifest.split.dev }, onlySplit: split });
  for (const mutation of mutations.cases) {
    const corpus = corpora.find((candidate) => candidate.id === mutation.corpus)!;
    const scenario: EvaluationScenario = { id: mutation.id, corpus: mutation.corpus, split: mutation.label.split, kind: mutation.label.expected.length ? 'planted' : 'control' };
    structuralScenarios.push(scenario);
    const base = { scenarioId: scenario.id, corpus: scenario.corpus, key: mutation.label.key, locale: mutation.label.locale };
    structuralTruth.push(...mutation.label.expected.map((expected) => ({ ...base, label: expected.ruleId })));
    const target = splitDocument(mutation.target, split, seed, mutation.label.key);
    for (const finding of runChecks(corpus.imported.source, target, { context: corpus.imported.context, glossary: corpus.imported.glossary })) structuralPredictions.push({ scenarioId: scenario.id, corpus: scenario.corpus, key: finding.path, locale: finding.locale, label: finding.ruleId });
  }
  for (const corpus of corpora) for (const target of corpus.imported.targets) {
    const scenario: EvaluationScenario = { id: `clean/${corpus.id}/${target.locale}`, corpus: corpus.id, split, kind: 'clean' };
    structuralScenarios.push(scenario); cleanStrings += [...target.entries.values()].filter((entry) => entry.kind === 'string').length;
    for (const finding of runChecks(corpus.imported.source, target, { context: corpus.imported.context, glossary: corpus.imported.glossary })) {
      const unit = { scenarioId: scenario.id, corpus: scenario.corpus, key: finding.path, locale: finding.locale, label: finding.ruleId, severity: finding.severity };
      cleanFindings.push(unit); structuralPredictions.push(unit);
    }
  }
  methods.push({ id: 'deterministic', status: 'measured', scores: scoreUnits({ scenarios: structuralScenarios, truth: structuralTruth, predictions: structuralPredictions, labels: [...ERROR_RULE_IDS, ...WARNING_RULE_IDS], task: 'structural', split }), clean: cleanFalsePositives({ findings: cleanFindings, stringCount: cleanStrings }) });
  const mock = await auditRecordedReplies(fixtures);
  methods.push({ id: 'mock', status: 'replay-only', reason: 'Recorded synthetic/demo replies validate replay, evidence and gate mechanics only; they measure no semantic accuracy.', observations: observations(mock), fixes: mock.fixes });
  const semanticCorpus = corpora.find((corpus) => corpus.id === fixtures.manifest.labels.semanticCorpus)!;
  const activeLabels = fixtures.labels.filter((label) => label.split === split);
  const methodRuns: Array<{ id: 'heuristic' | 'llm-context-off' | 'llm-context-on'; data: MethodData; withContext: boolean }> = [{ id: 'heuristic', data: methodData(), withContext: true }];
  if (config.live) methodRuns.push({ id: 'llm-context-off', data: methodData(), withContext: false }, { id: 'llm-context-on', data: methodData(), withContext: true });
  const transportRows: Array<Record<string, unknown>> = []; const errors: Array<Record<string, unknown>> = [];
  for (const run of methodRuns) {
    const reviewerFor = (prepared: PreparedPipeline): Reviewer => {
      if (run.id === 'heuristic') return createHeuristicReviewer({ policies: buildHeuristicPolicies(prepared.batches.flat(), semanticCorpus.imported.glossary) });
      if (!session || !provider) throw new Error('live_budget_session_missing');
      const transport = createMeteredTransport({ session, provider, cacheDir: CACHE, ledgerPath: join(RESULTS, 'call-ledger.jsonl'), modelId: config.modelId, events: run.data.events });
      return createLlmReviewer({ transport });
    };
    try {
      const clean = await preparePipeline(semanticCorpus.imported);
      await evaluateSemantic(run.data, { id: 'semantic/clean', corpus: semanticCorpus.id, split, kind: 'clean' }, clean, reviewerFor(clean), run.withContext);
      for (const label of activeLabels) {
        const target = semanticCorpus.imported.targets.find((doc) => doc.locale === label.locale)!;
        const imported = { ...semanticCorpus.imported, targets: [plantedDocument(target, label)] };
        const prepared = onlyLabel(await preparePipeline(imported), label);
        if (prepared.batches.flat().length !== 1) throw new Error('semantic_scenario_not_bound');
        const scenarioId = `semantic/${label.id}`;
        run.data.truth.push({ scenarioId, corpus: semanticCorpus.id, key: label.key, locale: label.locale, label: label.category });
        await evaluateSemantic(run.data, { id: scenarioId, corpus: semanticCorpus.id, split, kind: 'planted' }, prepared, reviewerFor(prepared), run.withContext);
        run.data.detected.set(label.id, run.data.predictions.some((prediction) => prediction.scenarioId === scenarioId && prediction.label === label.category));
      }
      methods.push({ id: run.id, status: 'measured', scores: scoreUnits({ scenarios: run.data.scenarios, truth: run.data.truth, predictions: run.data.predictions, labels: FINDING_CATEGORIES, task: 'semantic', split }), observations: observations(run.data), fixes: run.data.fixes });
    } catch (error) {
      // Partial paid work is explicit, never scored as a complete matched experiment.
      methods.push({ id: run.id, status: 'not-measured', reason: `Incomplete evaluation (${safeError(error)}); partial dispatches/audits are retained in results.jsonl and the accounting ledger.` });
      errors.push({ type: 'method-error', method: run.id, status: safeError(error), completedScenarios: run.data.scenarios.length, observations: observations(run.data) });
    }
    transportRows.push(...run.data.events.map((event) => ({ type: 'transport', method: run.id, ...event })));
  }
  for (const id of ['llm-context-off', 'llm-context-on'] as const) if (!config.live) methods.push({ id, status: 'not-measured', reason: 'Live evaluation was not selected; --live, explicit EVAL_MAX_USD and ANTHROPIC_API_KEY are required. No mock substitution.' });
  for (const id of ['jev', 'cascade'] as const) methods.push({ id, status: 'not-measured', reason: 'Live Jev/cascade rows and automated dev-probe execution are cut from this delivery. Provisional thresholds are disabled. Actual dev probe (30 pairs/locale), absolute recall floor and injection tolerance have not been measured; held-out cascade recall/cost admission is pending.' });
  const off = methodRuns.find((run) => run.id === 'llm-context-off'); const on = methodRuns.find((run) => run.id === 'llm-context-on');
  const pairedComplete = methods.some((method) => method.id === 'llm-context-off' && method.status === 'measured') && methods.some((method) => method.id === 'llm-context-on' && method.status === 'measured');
  const contextPairs: ContextPair[] = pairedComplete && off && on ? activeLabels.map((label) => ({ scenarioId: `semantic/${label.id}`, key: label.key, locale: label.locale, category: label.category, contextDependent: label.contextDependent, offDetected: off.data.detected.get(label.id) === true, onDetected: on.data.detected.get(label.id) === true })) : [];
  const report: EvaluationReport = { title: 'TaskBoard string review evaluation', split, seed, versions: { ...fixtures.versions, anthropicModel: config.modelId }, methods, contextPairs, contextAblationReason: 'Both complete live matched context rows are required; missing or failed rows cannot establish an ablation.', notes: [fixtures.manifest.authorship, 'The split seed was selected on key placement and label counts, not drawn blindly; see fixtures/manifest.json seedSelection. This is a small synthetic, builder-authored corpus with no native-speaker adjudication.', 'Glossary-backed terminology labels overlap deterministic checks; heuristic terminology recall is inflated. Heuristic is a non-model floor, not evidence of general semantic judgement.', 'Mock replay includes every original and regenerated recorded proposal, including unsupported and dropped claims. All raw live proposals are audited before evidence/schema filtering. Audit gate acceptance alone does not make an unsupported/unbound proposal exportable; exportable is recorded separately in JSONL.', 'Costs and tokens count newly dispatched calls only. Cache hits identify the original ledger/usage/cost separately and incur zero new provider spend. Provider failures retain unknown costs as N/A. Estimates bound local accounting only, not provider billing.', 'Context ablation is a matched-pair indicative comparison, not causal or multilingual quality validation. Semantic clean predictions are false positives; dev unplanted categories on planted strings require adjudication; held-out extras are false positives.'] };
  const rendered = renderEvaluation(report);
  await mkdir(RESULTS, { recursive: true });
  await writeFile(join(RESULTS, 'results.md'), rendered.markdown, 'utf8');
  await writeFile(join(RESULTS, 'adjudication.md'), rendered.adjudicationMarkdown, 'utf8');
  const audits = [{ id: 'mock', data: mock }, ...methodRuns].flatMap((run) => run.data.fixes.map((fix) => ({ type: 'proposal-audit', method: run.id, ...fix })));
  const markdownCell = (value: unknown): string => JSON.stringify(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\|/gu, '&#124;').replace(/`/gu, '&#96;');
  const auditFailures = audits.filter((audit) => !audit.accepted || audit.invariantViolations.length > 0);
  const auditTable = ['\n## Complete proposal audit failures (including incomplete methods)\n', '| Method | Scenario | Key | Locale | Reasons | Invariant violations |', '| --- | --- | --- | --- | --- | --- |', ...auditFailures.map((audit) => `| ${[audit.method, audit.scenarioId, audit.key, audit.locale, audit.reasons, audit.invariantViolations].map(markdownCell).join(' | ')} |`), ''].join('\n');
  await writeFile(join(RESULTS, 'failures.md'), rendered.failuresMarkdown + auditTable, 'utf8');
  await writeFile(join(RESULTS, 'results.jsonl'), rendered.jsonl.trimEnd() + '\n' + [...transportRows, ...errors, ...audits, { type: 'mutation-coverage', coverage: mutations.coverage }].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  if (errors.length) throw new Error('incomplete_evaluation_results_written');
  if (audits.some((audit) => audit.invariantViolations.length > 0)) throw new Error('invariant_violation_results_written');
}

export async function main(args: readonly string[] = process.argv.slice(2), env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = parseEvalArgs(args, env);
  if (config.help) { process.stdout.write(HELP); return; }
  const fixtures = await loadFixtures(); // Validate all flags/config/fixture bindings before consuming the marker.
  if (config.split === 'heldout') await consumeHeldoutLock(HELDOUT_LOCK, { ...fixtures.versions, mode: config.live ? 'live' : 'mock', anthropicModel: config.modelId });
  if (config.live) await withBudgetSession({ live: true, maxUsd: config.maxUsd!, cacheDir: CACHE }, async (session) => evaluate(fixtures, config, session, createAnthropicProvider({ fetch, anthropicApiKey: env['ANTHROPIC_API_KEY'] })));
  else await evaluate(fixtures, config);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => { process.stderr.write(`${safeError(error)}; evaluation stopped. Heldout markers are retained.\n`); process.exitCode = 1; });
}
