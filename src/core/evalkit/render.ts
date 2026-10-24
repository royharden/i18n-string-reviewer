// Render executed observations only. This module never runs reviewers or reads/writes files.
import { ERROR_RULE_IDS, WARNING_RULE_IDS } from '../l10nchecks/types.ts';
import { contextAblation } from './metrics.ts';
import type { CleanFpResult, ContextPair, Rate, ScoreResult, ScoringFailure } from './metrics.ts';
import { fmix32, fnv1a32 } from './split.ts';
import type { Split } from './split.ts';

export type { ContextPair } from './metrics.ts';
export const EVAL_METHOD_IDS = ['deterministic', 'heuristic', 'llm-context-off', 'llm-context-on', 'jev', 'cascade', 'mock'] as const;
export type EvalMethodId = (typeof EVAL_METHOD_IDS)[number];
export const SEMANTIC_CATEGORIES = ['accuracy', 'fluency', 'terminology', 'style', 'context_mismatch'] as const;

export interface MethodObservations {
  readonly evidenceValid: number;
  readonly evidenceTotal: number;
  readonly proposalsAccepted: number;
  /** Distinct rejected proposals. Reason counts may exceed this because a proposal can fail several checks. */
  readonly proposalsRejected?: number;
  readonly proposalRejectedByReason: Readonly<Record<string, number>>;
  readonly invariantViolations: number;
  readonly invariantChecked?: number;
  readonly replyCount: number;
  /** null means unavailable/unknown; an executed, known free local method may use zero. */
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly stringCount: number;
}

export interface SampleFix {
  readonly scenarioId: string;
  readonly key: readonly string[];
  readonly locale: string;
  readonly before: string;
  readonly proposal: string;
  readonly accepted: boolean;
  readonly reasons: readonly string[];
}

interface MeasuredMethod {
  readonly id: Exclude<EvalMethodId, 'mock'>;
  readonly status: 'measured';
  readonly scores: ScoreResult;
  readonly reason?: string;
  readonly clean?: CleanFpResult;
  readonly observations?: MethodObservations;
  readonly fixes?: readonly SampleFix[];
}

interface NotMeasuredMethod {
  readonly id: EvalMethodId;
  readonly status: 'not-measured';
  readonly reason: string;
  readonly scores?: never;
  readonly clean?: never;
  readonly observations?: never;
  readonly fixes?: never;
}

interface ReplayMethod {
  readonly id: 'mock';
  readonly status: 'replay-only';
  readonly reason: string;
  readonly observations?: MethodObservations;
  readonly fixes?: readonly SampleFix[];
  readonly scores?: never;
  readonly clean?: never;
}

export type MethodEvaluation = MeasuredMethod | NotMeasuredMethod | ReplayMethod;

export interface EvaluationReport {
  readonly title: string;
  readonly split: Split;
  readonly seed: number;
  readonly versions: Readonly<Record<string, string>>;
  readonly methods: readonly MethodEvaluation[];
  readonly contextPairs?: readonly ContextPair[];
  readonly contextAblationReason?: string;
  readonly notes?: readonly string[];
}

export interface RenderedEvaluation {
  readonly markdown: string;
  readonly jsonl: string;
  readonly failuresMarkdown: string;
  readonly adjudicationMarkdown: string;
}

// Human-readable values are JSON quoted and Markdown escaped; even fixture/provider text cannot
// become executable HTML or corrupt a table. JSONL retains the original data strings.
function cell(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\|/gu, '&#124;').replace(/\r?\n/gu, '<br>').replace(/`/gu, '&#96;');
}

const number = (value: number | null, digits = 4): string => value === null ? 'N/A' : value.toFixed(digits);
const na = (reason: string): string => `N/A (${cell(reason)})`;
const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => [
  `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`), '',
].join('\n');

function rate(value: Rate): string {
  if (value.value === null) return `N/A (0 denominator; ${value.numerator}/${value.denominator})`;
  const interval = value.interval95;
  return `${number(value.value)} (${value.numerator}/${value.denominator}; 95% ${interval ? `[${number(interval.lower)}, ${number(interval.upper)}]` : 'N/A'})`;
}

function count(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`render: ${label} must be a nonnegative safe integer`);
}

function validateObservations(observations: MethodObservations): void {
  for (const [key, value] of Object.entries(observations)) {
    if (key === 'proposalRejectedByReason' || key === 'costUsd' || value === null) continue;
    if (typeof value === 'number') count(value, key);
  }
  if (observations.evidenceValid > observations.evidenceTotal) throw new RangeError('render: valid evidence exceeds observed evidence');
  if (observations.invariantChecked !== undefined && observations.invariantViolations > observations.invariantChecked) throw new RangeError('render: invariant violations exceed checked fixes');
  if (observations.costUsd !== null && (!Number.isFinite(observations.costUsd) || observations.costUsd < 0)) throw new RangeError('render: cost must be a nonnegative observed amount or null');
  for (const [reason, value] of Object.entries(observations.proposalRejectedByReason)) count(value, reason);
}

interface NamedFix extends SampleFix { readonly method: EvalMethodId }

/** Stable seeded ranking, independent of input order. Exactly 20 when at least 20 are available. */
export function sampleFixes(fixes: readonly NamedFix[], seed: number, limit = 20): NamedFix[] {
  if (!Number.isFinite(seed) || !Number.isSafeInteger(limit) || limit < 0) throw new RangeError('render: finite seed and nonnegative sample size required');
  const identity = (fix: NamedFix): string => JSON.stringify([fix.method, fix.scenarioId, fix.key, fix.locale, fix.before, fix.proposal, fix.accepted, fix.reasons]);
  const unique = new Map<string, NamedFix>();
  for (const fix of fixes) unique.set(identity(fix), fix);
  return [...unique.entries()].map(([id, fix]) => ({ id, fix, rank: fmix32(fnv1a32(`${seed}\u0000${id}`)) })).sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit).map((item) => item.fix);
}

function failureRows(method: EvalMethodId, failures: readonly ScoringFailure[]): string[][] {
  return failures.map((failure) => [method, failure.kind, cell(failure.scenarioId), cell(failure.corpus), cell(JSON.stringify(failure.key)), cell(failure.locale), cell(failure.label), cell(failure.reason)]);
}

/** Missing methods become explicit unmeasured rows; mock cannot contribute quality scores. */
export function renderEvaluation(report: EvaluationReport): RenderedEvaluation {
  if (!Number.isFinite(report.seed)) throw new RangeError('render: seed must be finite');
  if (report.split !== 'dev' && report.split !== 'heldout') throw new TypeError('render: unknown split');
  const supplied = new Map<EvalMethodId, MethodEvaluation>();
  for (const method of report.methods) {
    if (!(EVAL_METHOD_IDS as readonly string[]).includes(method.id) || supplied.has(method.id)) throw new TypeError('render: unknown or duplicate method');
    if (!['measured', 'not-measured', 'replay-only'].includes(method.status)) throw new TypeError('render: unknown measurement status');
    if (method.status === 'not-measured' && !method.reason.trim()) throw new TypeError('render: unmeasured method needs a reason');
    if (method.status === 'not-measured' && (method.scores !== undefined || method.clean !== undefined || method.observations !== undefined || method.fixes !== undefined)) throw new TypeError('render: unmeasured rows cannot contain measured values');
    if (method.status === 'replay-only' && (method.id !== 'mock' || !method.reason.trim())) throw new TypeError('render: replay is mock-only and needs a reason');
    // Defend even against untyped JSON callers attempting to attach model accuracy to replay.
    if (method.id === 'mock' && String(method.status) === 'measured') throw new TypeError('render: mock accuracy is not measurable');
    if (method.status === 'measured' && (method.scores.split !== report.split || method.scores.task !== (method.id === 'deterministic' ? 'structural' : 'semantic'))) throw new TypeError('render: score task/split does not match method/report');
    if (method.observations) validateObservations(method.observations);
    supplied.set(method.id, method);
  }
  const methods = EVAL_METHOD_IDS.map((id): MethodEvaluation => supplied.get(id) ?? { id, status: 'not-measured', reason: 'Method was not executed in this run.' });
  const records: unknown[] = [{ kind: 'run', title: report.title, split: report.split, seed: report.seed, versions: report.versions, notes: report.notes ?? [] }];
  const out = [`# ${cell(report.title)}`, '', `Split: ${report.split}. Seed: ${report.seed}. Values below derive from this executed run only.`, '',
    'Units are (scenario, corpus, key path, locale, rule/category); duplicate findings count once. Precision and recall include Wilson 95% intervals and their sample counts. F1 has no interval. Zero denominators are N/A.', '',
    'Mock rows measure recorded-reply replay and gate correctness only; they provide no model accuracy evidence. Unplanted dev semantic findings await adjudication and are excluded from precision; held-out unplanted findings count as false positives. Clean strings and explicit negative controls count false positives in either split.', '',
    'This synthetic, builder-authored corpus is small. Results are indicative; they do not establish production accuracy, translation quality, security, or visual layout safety.', '',
    ...((report.notes ?? []).map((note) => `${cell(note)}\n`)),
    '## Versions', '', table(['Component', 'Version'], Object.entries(report.versions).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, version]) => [cell(name), cell(version)])),
    '## Method status', '', table(['Method', 'Status', 'Reason'], methods.map((method) => [method.id, method.status, cell(method.reason ?? 'Executed; see measured rows.')])),
    '## Precision / recall / F1', '',
  ];
  const qualityRows: string[][] = [];
  const namedFailures: string[][] = [];
  const adjudication: string[][] = [];
  const fixes: NamedFix[] = [];
  for (const method of methods) {
    records.push({ kind: 'method', id: method.id, status: method.status, reason: method.reason, clean: method.status === 'measured' ? method.clean : undefined, observations: method.observations });
    const labels: readonly string[] = method.id === 'deterministic' ? [...ERROR_RULE_IDS, ...WARNING_RULE_IDS] : SEMANTIC_CATEGORIES;
    for (const label of labels) {
      const row = method.status === 'measured' ? method.scores.rows.find((item) => item.label === label) : undefined;
      const reason = method.id === 'mock' ? 'Replay/gate correctness only; no accuracy claim.' : method.status === 'not-measured' ? method.reason : 'This rule/category was not scored.';
      qualityRows.push(row ? [method.id, label, String(row.tp), String(row.fp), String(row.fn), rate(row.precision), rate(row.recall), number(row.f1), String(row.pendingAdjudication)] : [method.id, label, na(reason), 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
      records.push(row ? { kind: 'score', method: method.id, ...row } : { kind: 'score', method: method.id, label, status: 'not-measured', reason });
    }
    if (method.status === 'measured') {
      namedFailures.push(...failureRows(method.id, method.scores.failures));
      adjudication.push(...failureRows(method.id, method.scores.adjudication));
      for (const failure of method.scores.failures) records.push({ kind: 'failure', method: method.id, failure });
      for (const failure of method.scores.adjudication) records.push({ kind: 'adjudication', method: method.id, failure });
    }
    if (method.status !== 'not-measured') {
      for (const fix of method.fixes ?? []) {
        const named = { ...fix, method: method.id };
        fixes.push(named);
        if (!fix.accepted) {
          namedFailures.push([method.id, 'gate_rejection', cell(fix.scenarioId), '—', cell(JSON.stringify(fix.key)), cell(fix.locale), 'proposal', cell(fix.reasons.join(', ') || 'Reason not supplied')]);
          records.push({ kind: 'gate_rejection', ...named });
        }
      }
    }
  }
  out.push(table(['Method', 'Rule / category', 'TP', 'FP', 'Misses', 'Precision (n; Wilson 95%)', 'Recall (n; Wilson 95%)', 'F1', 'Pending adjudication'], qualityRows));
  out.push('## Clean-set false positives per 1,000 strings', '', table(['Method', 'Strings', 'Error FP', 'Errors / 1,000', 'Warning FP', 'Warnings / 1,000'], methods.map((method) => {
    const clean = method.status === 'measured' ? method.clean : undefined;
    const reason = method.status === 'not-measured' ? method.reason : 'Clean-set error/warning counts were not measured for this method.';
    return clean ? [method.id, String(clean.stringCount), String(clean.error.count), number(clean.error.per1000), String(clean.warning.count), number(clean.warning.per1000)] : [method.id, na(reason), 'N/A', 'N/A', 'N/A', 'N/A'];
  })));
  out.push('## Evidence, gate and invariant observations', '', table(['Method', 'Evidence valid / checked', 'Accepted proposals', 'Rejected proposals', 'Invariant violations / checked fixes', 'All replies observed'], methods.map((method) => {
    const observed = method.observations;
    const reason = method.status === 'not-measured' ? method.reason : 'No diagnostics were collected.';
    return observed ? [method.id, observed.evidenceTotal === 0 ? 'N/A (0 checked)' : `${observed.evidenceValid}/${observed.evidenceTotal}`, String(observed.proposalsAccepted), observed.proposalsRejected === undefined ? 'N/A (distinct count unavailable)' : String(observed.proposalsRejected), `${observed.invariantViolations}/${observed.invariantChecked ?? 'N/A (check count unavailable)'}`, String(observed.replyCount)] : [method.id, na(reason), 'N/A', 'N/A', 'N/A', 'N/A'];
  })));
  const reasonRows: string[][] = [];
  for (const method of methods) {
    const reasons = method.observations?.proposalRejectedByReason;
    if (!reasons) reasonRows.push([method.id, na(method.status === 'not-measured' ? method.reason : 'No gate reason counts were collected.'), 'N/A']);
    else if (Object.keys(reasons).length === 0) reasonRows.push([method.id, 'No rejection reasons observed.', '0']);
    else for (const [reason, value] of Object.entries(reasons).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) reasonRows.push([method.id, cell(reason), String(value)]);
  }
  out.push('A proposal can fail several checks; reason counts are not summed into a rejected-proposal count.', '', table(['Method', 'Gate reason', 'Count'], reasonRows));
  const per1000 = (value: number | null, strings: number): string => value === null ? 'N/A (unknown usage/cost)' : strings === 0 ? 'N/A (0 strings)' : number((value * 1000) / strings);
  out.push('## Observed cost and tokens per 1,000 reviewed strings', '', table(['Method', 'Strings', 'Cost USD', 'USD / 1,000', 'Input tokens / 1,000', 'Output tokens / 1,000'], methods.map((method) => {
    const observed = method.observations;
    const reason = method.status === 'not-measured' ? method.reason : 'No usage observations were collected.';
    return observed ? [method.id, String(observed.stringCount), observed.costUsd === null ? 'N/A (unknown cost)' : number(observed.costUsd, 6), per1000(observed.costUsd, observed.stringCount), per1000(observed.inputTokens, observed.stringCount), per1000(observed.outputTokens, observed.stringCount)] : [method.id, na(reason), 'N/A', 'N/A', 'N/A', 'N/A'];
  })));
  out.push('## Matched context ablation (indicative)', '', 'The same planted string/category is evaluated with and without context. These paired outcomes are descriptive, not a significance or generalisation claim.', '');
  const pairs = report.contextPairs ?? [];
  if (pairs.length === 0) {
    const reason = report.contextAblationReason ?? 'Both llm context variants were not executed on matched strings.';
    out.push(na(reason), '');
    records.push({ kind: 'context_ablation', status: 'not-measured', reason });
  } else {
    const off = supplied.get('llm-context-off');
    const on = supplied.get('llm-context-on');
    if (off?.status !== 'measured' || on?.status !== 'measured') throw new TypeError('render: context pairs require both measured llm variants');
    for (const [name, subset] of [['all matched', pairs], ['context dependent', pairs.filter((pair) => pair.contextDependent)]] as const) {
      const summary = contextAblation(subset);
      out.push(table(['Subset', 'Pairs', 'Both detected', 'Off only', 'On only', 'Neither', 'Off recall', 'On recall', 'On − off'], [[name, String(summary.pairCount), String(summary.both), String(summary.offOnly), String(summary.onOnly), String(summary.neither), rate(summary.offRecall), rate(summary.onRecall), number(summary.delta)]]));
      records.push({ kind: 'context_ablation', subset: name, indicative: true, ...summary });
    }
    for (const pair of pairs) records.push({ kind: 'context_pair', ...pair });
  }
  const sampled = sampleFixes(fixes, report.seed);
  const available = new Set(fixes.map((fix) => JSON.stringify([fix.method, fix.scenarioId, fix.key, fix.locale, fix.before, fix.proposal, fix.accepted, fix.reasons]))).size;
  out.push('## Sampled fixes for human reading', '', `Deterministic sample seed ${report.seed}: ${sampled.length} of ${available} distinct observed proposals. ${available < 20 ? 'Fewer than 20 were available; all are shown.' : 'Twenty are shown.'}`, '');
  if (sampled.length === 0) out.push('N/A (no fix proposals were observed).', '');
  else out.push(table(['Method', 'Scenario', 'Key', 'Locale', 'Current target', 'Proposal', 'Gate outcome'], sampled.map((fix) => [fix.method, cell(fix.scenarioId), cell(JSON.stringify(fix.key)), cell(fix.locale), cell(JSON.stringify(fix.before)), cell(JSON.stringify(fix.proposal)), fix.accepted ? 'accepted' : `rejected: ${cell(fix.reasons.join(', '))}`])));
  for (const fix of sampled) records.push({ kind: 'sampled_fix', ...fix });
  const headers = ['Method', 'Kind', 'Scenario', 'Corpus', 'Key', 'Locale', 'Rule / category', 'Reason'];
  const failuresMarkdown = `# Named failures\n\nEvery scored false positive, miss and observed gate rejection is listed below.\n\n${table(headers, namedFailures)}${namedFailures.length === 0 ? '\nNo named failures were observed in the executed measurements.\n' : ''}`;
  const adjudicationMarkdown = `# Dev semantic adjudication\n\nUnplanted dev findings are unresolved; they are not silently accepted as correct.\n\n${table(headers, adjudication)}${adjudication.length === 0 ? '\nNo pending adjudications were observed.\n' : ''}`;
  out.push('## Named failures', '', 'See failures.md for every scored false positive, miss and gate rejection; see adjudication.md for unresolved dev semantic findings.', '');
  return { markdown: `${out.join('\n').trimEnd()}\n`, jsonl: `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, failuresMarkdown, adjudicationMarkdown };
}
