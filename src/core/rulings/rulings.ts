// Rulings (PLAN §3.7): append-only JSONL of human decisions, bound to the exact text they were made
// about. Replay takes the latest valid decision per finding/fingerprint; a ruling whose text changed
// is invalidated (never silently carried over); an approval binds one suggestion hash, so a
// regenerated suggestion is not approved; several approved suggestions for one string need an
// explicit pick before export.
//
// Each ruling also records `key` and `locale` (no product text) so that a ruling whose finding no
// longer exists can still be shown on its string as "invalidated (text changed)".
// `kind: 'l10n_finding'` is provisional (D15).

import { z } from 'zod';
import type { Finding } from '../cited/finding.ts';
import { itemFingerprint, stringKey } from './fingerprint.ts';

export const RULING_DECISIONS = ['approve_fix', 'accept_finding', 'reject', 'skip'] as const;
export type RulingDecision = (typeof RULING_DECISIONS)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/u, 'must be a lower-case SHA-256 hex digest');

export const rulingSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('l10n_finding'),
    itemFingerprint: hex64,
    findingId: hex64,
    key: z.array(z.string()).min(1).max(64),
    locale: z.string().min(1).max(64),
    decision: z.enum(RULING_DECISIONS),
    suggestionHash: hex64.optional(),
    at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.decision === 'approve_fix' && r.suggestionHash === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestionHash'], message: 'approve_fix requires suggestionHash' });
    }
  });

export type Ruling = z.infer<typeof rulingSchema>;

/** Fingerprint of a finding's string as it is NOW (path, locale, source, target, rule/category, checkVersion). */
export async function fingerprintForFinding(f: Pick<Finding, 'key' | 'locale' | 'ruleId' | 'category'>, sourceText: string, targetText: string): Promise<string> {
  return itemFingerprint({ key: f.key, locale: f.locale, source: sourceText, target: targetText, ruleOrCategory: f.ruleId ?? f.category });
}

export interface MakeRulingInput {
  readonly finding: Pick<Finding, 'id' | 'key' | 'locale' | 'suggestionHash'>;
  readonly fingerprint: string;
  readonly decision: RulingDecision;
  /** ISO-8601 timestamp; the caller supplies it (core code never reads the clock). */
  readonly at: string;
}

export function makeRuling(input: MakeRulingInput): Ruling {
  const { finding, decision } = input;
  if (decision === 'approve_fix' && finding.suggestionHash === undefined) {
    throw new Error('approve_fix needs a finding with a gate-accepted suggestion (suggestionHash)');
  }
  const ruling: Ruling = {
    schemaVersion: 1,
    kind: 'l10n_finding',
    itemFingerprint: input.fingerprint,
    findingId: finding.id,
    key: [...finding.key],
    locale: finding.locale,
    decision,
    ...(decision === 'approve_fix' ? { suggestionHash: finding.suggestionHash } : {}),
    at: input.at,
  };
  return rulingSchema.parse(ruling);
}

// --- JSONL ---

export interface RulingParseError {
  /** 1-based line number. */
  readonly line: number;
  readonly message: string;
}

export interface RulingsParseResult {
  readonly rulings: readonly Ruling[];
  readonly errors: readonly RulingParseError[];
}

/** Parse JSONL line by line with zod; bad lines are reported and skipped, never fatal. */
export function parseRulingsJsonl(text: string): RulingsParseResult {
  const rulings: Ruling[] = [];
  const errors: RulingParseError[] = [];
  const lines = text.replace(/^﻿/u, '').split(/\r?\n/u);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ line: i + 1, message: 'not valid JSON' });
      return;
    }
    const parsed = rulingSchema.safeParse(value);
    if (!parsed.success) {
      errors.push({ line: i + 1, message: parsed.error.issues.map((x) => `${x.path.join('.') || '(line)'}: ${x.message}`).join('; ') });
      return;
    }
    rulings.push(parsed.data);
  });
  return { rulings, errors };
}

export function serializeRulings(rulings: readonly Ruling[]): string {
  return rulings.map((r) => JSON.stringify(r)).join('\n') + (rulings.length > 0 ? '\n' : '');
}

// --- replay ---

export interface CurrentFinding {
  readonly finding: Pick<Finding, 'id' | 'key' | 'locale' | 'suggestionHash'>;
  /** Fingerprint computed from the CURRENT source and target text. */
  readonly fingerprint: string;
}

export type RulingStatus = 'active' | 'invalidated_text' | 'invalidated_suggestion';

export interface RulingState {
  readonly ruling: Ruling;
  readonly status: RulingStatus;
}

export interface RulingConflict {
  readonly findingId: string;
  readonly rulings: readonly Ruling[];
  readonly message: string;
}

export interface ReplayResult {
  /** Latest ruling per current finding, with its status. */
  readonly byFinding: ReadonlyMap<string, RulingState>;
  /** Rulings about a string that still exists but whose finding no longer does (text changed). Keyed by stringKey. */
  readonly invalidatedStrings: ReadonlyMap<string, readonly Ruling[]>;
  /** Rulings about strings that are not part of the current import at all. */
  readonly orphaned: readonly Ruling[];
  /** Out-of-order timestamps or simultaneous contradictory decisions (latest line still wins). */
  readonly conflicts: readonly RulingConflict[];
  /** Strings with more than one ACTIVE approved suggestion: an explicit pick is required before export. */
  readonly competing: ReadonlyMap<string, readonly string[]>;
}

/**
 * Replay an append-only log. `knownStrings` (stringKey values) lets a ruling whose finding vanished
 * be attributed to its still-existing string as "invalidated (text changed)".
 */
export function replayRulings(rulings: readonly Ruling[], current: readonly CurrentFinding[], knownStrings: ReadonlySet<string> = new Set()): ReplayResult {
  const currentById = new Map<string, CurrentFinding>();
  const currentStrings = new Set<string>(knownStrings);
  for (const c of current) {
    currentById.set(c.finding.id, c);
    currentStrings.add(stringKey(c.finding.key, c.finding.locale));
  }

  const latest = new Map<string, Ruling>();
  const history = new Map<string, Ruling[]>();
  const conflicts: RulingConflict[] = [];
  for (const r of rulings) {
    const prev = latest.get(r.findingId);
    const list = history.get(r.findingId) ?? [];
    list.push(r);
    history.set(r.findingId, list);
    if (prev) {
      const tPrev = Date.parse(prev.at);
      const tNow = Date.parse(r.at);
      if (tNow < tPrev) {
        conflicts.push({ findingId: r.findingId, rulings: [prev, r], message: `ruling at ${r.at} appears after a later one (${prev.at}); the later line wins` });
      } else if (tNow === tPrev && prev.decision !== r.decision) {
        conflicts.push({ findingId: r.findingId, rulings: [prev, r], message: `contradictory decisions with the same timestamp ${r.at}; the later line wins` });
      }
    }
    latest.set(r.findingId, r);
  }

  const byFinding = new Map<string, RulingState>();
  const invalidatedStrings = new Map<string, Ruling[]>();
  const orphaned: Ruling[] = [];
  for (const [findingId, r] of latest) {
    const cur = currentById.get(findingId);
    if (cur) {
      let status: RulingStatus = 'active';
      if (cur.fingerprint !== r.itemFingerprint || stringKey(cur.finding.key, cur.finding.locale) !== stringKey(r.key, r.locale)) status = 'invalidated_text';
      else if (r.decision === 'approve_fix' && r.suggestionHash !== cur.finding.suggestionHash) status = 'invalidated_suggestion';
      byFinding.set(findingId, { ruling: r, status });
      continue;
    }
    const sk = stringKey(r.key, r.locale);
    if (currentStrings.has(sk)) {
      const list = invalidatedStrings.get(sk) ?? [];
      list.push(r);
      invalidatedStrings.set(sk, list);
    } else {
      orphaned.push(r);
    }
  }

  const approvals = new Map<string, string[]>();
  for (const [findingId, state] of byFinding) {
    if (state.status !== 'active' || state.ruling.decision !== 'approve_fix') continue;
    const sk = stringKey(state.ruling.key, state.ruling.locale);
    const list = approvals.get(sk) ?? [];
    list.push(findingId);
    approvals.set(sk, list);
  }
  const competing = new Map<string, string[]>();
  for (const [sk, ids] of approvals) if (ids.length > 1) competing.set(sk, ids.sort());

  return { byFinding, invalidatedStrings, orphaned, conflicts, competing };
}

/**
 * Resolve competing approvals on one string by keeping `chosenFindingId`: returns `reject` rulings
 * (to append) for every other active approval on that string.
 */
export function pickCompetingApproval(replay: ReplayResult, sk: string, chosenFindingId: string, at: string): Ruling[] {
  const ids = replay.competing.get(sk);
  if (!ids || !ids.includes(chosenFindingId)) throw new Error('chosen finding is not one of the competing approvals for this string');
  const out: Ruling[] = [];
  for (const id of ids) {
    if (id === chosenFindingId) continue;
    const state = replay.byFinding.get(id);
    if (!state) continue;
    const r = state.ruling;
    out.push(
      rulingSchema.parse({
        schemaVersion: 1,
        kind: 'l10n_finding',
        itemFingerprint: r.itemFingerprint,
        findingId: r.findingId,
        key: [...r.key],
        locale: r.locale,
        decision: 'reject',
        at,
      }),
    );
  }
  return out;
}

/** Active approve_fix rulings that may be exported (competing strings excluded). */
export function exportableApprovals(replay: ReplayResult): RulingState[] {
  const out: RulingState[] = [];
  for (const state of replay.byFinding.values()) {
    if (state.status !== 'active' || state.ruling.decision !== 'approve_fix') continue;
    if (replay.competing.has(stringKey(state.ruling.key, state.ruling.locale))) continue;
    out.push(state);
  }
  return out;
}
