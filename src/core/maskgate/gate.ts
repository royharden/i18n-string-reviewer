// Fix gate (PLAN §3.4) — the headline invariant: no accepted fix alters a placeholder, tag or ICU
// structure of the CURRENT target. Every check runs and every reason is collected (no short
// circuit); every rejection is counted by reason in GateStats.
//
//   1. fixAllowed           fix_not_allowed_nested | fix_not_allowed_redacted | fix_not_allowed_empty_source
//   2. tokens               unknown_token, missing_token, duplicate_token, secret_token, token_moved_branch
//   3. unmask / reparse     unmask_failed; icu_reparse_failed (ICU) | tokenize_failed (i18next / plain)
//   4. structure            structure_changed (ICU path signature), placeholder_changed, printf_order, tag_changed
//   5. URLs                 new_url (http(s):// or www. absent from the current target)
//   6. length (code points) max_length (context maxLength, authoritative) else length_ratio
//
// Length caps count Unicode code points of the unmasked string (PLAN §3.4).

import { parseIcu } from '../l10nchecks/icu.ts';
import { tokenizePlaceholders } from '../l10nchecks/placeholders.ts';
import type { Dialect } from '../l10nchecks/types.ts';
import { fixability, maskTarget, maskText, scanTokens, unmask } from './mask.ts';
import type { NotAllowedReason, ParsedToken, RestoreMap } from './mask.ts';
import { compareStructure, structureSignature } from './signature.ts';

export const GATE_REASONS = [
  'fix_not_allowed_nested',
  'fix_not_allowed_redacted',
  'fix_not_allowed_empty_source',
  'unknown_token',
  'missing_token',
  'duplicate_token',
  'secret_token',
  'token_moved_branch',
  'unmask_failed',
  'icu_reparse_failed',
  'tokenize_failed',
  'structure_changed',
  'placeholder_changed',
  'printf_order',
  'tag_changed',
  'new_url',
  'max_length',
  'length_ratio',
] as const;

export type GateReason = (typeof GATE_REASONS)[number];

export const LENGTH_RATIO_LIMIT = 1.6;

export interface GateContext {
  readonly dialect: Dialect;
  /** Current source text of the same key. */
  readonly sourceText: string;
  /** Reasons the item was already marked not fixable (e.g. a secret in the key). Merged with the gate's own. */
  readonly notAllowed?: readonly NotAllowedReason[];
  /** context.json maxLength (code points), authoritative when present. */
  readonly maxLength?: number;
}

export type GateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reasons: readonly GateReason[]; /** best-effort unmasked text, for display */ readonly text: string };

export interface GateStats {
  checked: number;
  accepted: number;
  rejected: number;
  readonly byReason: Record<GateReason, number>;
}

export function createGateStats(): GateStats {
  const byReason = Object.create(null) as Record<GateReason, number>;
  for (const r of GATE_REASONS) byReason[r] = 0;
  return { checked: 0, accepted: 0, rejected: 0, byReason };
}

export function recordGate(stats: GateStats, result: GateResult): void {
  stats.checked++;
  if (result.ok) {
    stats.accepted++;
    return;
  }
  stats.rejected++;
  for (const r of result.reasons) stats.byReason[r]++;
}

export function mergeGateStats(into: GateStats, from: GateStats): void {
  into.checked += from.checked;
  into.accepted += from.accepted;
  into.rejected += from.rejected;
  for (const r of GATE_REASONS) into.byReason[r] += from.byReason[r];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'{}]+|\bwww\.[^\s<>"'{}]+/giu;

/** URLs in `fix` that do not occur in `current` (case-insensitive). */
export function newUrls(current: string, fix: string): string[] {
  const have = new Set((current.match(URL_RE) ?? []).map((u) => u.toLowerCase()));
  return (fix.match(URL_RE) ?? []).filter((u) => !have.has(u.toLowerCase()));
}

export function visibleLength(text: string, dialect: Dialect): number {
  void dialect; // Kept in the public API for callers; the gate counts the complete string.
  return Array.from(text).length;
}

function sameTokenMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** For each token, the skeleton token most recently preceding it ('' = outside any branch). */
function branchOf(tokens: readonly ParsedToken[]): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  for (const t of tokens) {
    if (t.kind === 'S') {
      current = t.token;
      continue;
    }
    out.set(t.token, current);
  }
  return out;
}

function countTokens(tokens: readonly ParsedToken[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokens) out.set(t.token, (out.get(t.token) ?? 0) + 1);
  return out;
}

/**
 * Validate a proposed fix (masked, in the current target's token space) against the CURRENT target.
 * `restore` must be the restore map of the current target; a map built from other text fails with
 * unmask_failed (the gate then continues with a freshly derived map so other reasons are still found).
 */
export function validateFix(currentTarget: string, proposalMasked: string, restore: RestoreMap, ctx: GateContext, stats?: GateStats): GateResult {
  const reasons = new Set<GateReason>();
  const { dialect } = ctx;

  // 1. fixAllowed (recomputed from the current source/target, merged with the caller's reasons)
  const current = maskTarget(currentTarget, dialect);
  const sourceMask = maskText(ctx.sourceText, { dialect, structural: true, field: 'source' });
  for (const r of fixability(sourceMask, current, ctx.sourceText)) reasons.add(r);
  for (const r of ctx.notAllowed ?? []) reasons.add(r);

  // The caller's restore map must describe exactly the current target.
  const restoreOk = restore.original === current.restore.original && restore.field === 'target' && sameTokenMap(restore.tokens, current.restore.tokens);
  if (!restoreOk) reasons.add('unmask_failed');
  const map = restoreOk ? restore : current.restore;

  // 2. tokens
  const proposal = scanTokens(proposalMasked);
  const proposalCounts = countTokens(proposal.tokens);
  for (const t of proposal.tokens) {
    if (t.kind === 'R') reasons.add('secret_token');
    else if (!map.tokens.has(t.token)) reasons.add('unknown_token');
  }
  for (const [token, n] of proposalCounts) if (n > 1 && map.tokens.has(token)) reasons.add('duplicate_token');
  for (const token of map.tokens.keys()) if (!proposalCounts.has(token)) reasons.add('missing_token');

  const currentTokens = scanTokens(current.masked).tokens.filter((t) => t.kind !== 'R');
  if (currentTokens.some((t) => t.kind === 'S')) {
    const before = branchOf(currentTokens);
    const after = branchOf(proposal.tokens.filter((t) => t.kind !== 'R'));
    for (const [token, branch] of before) {
      if (proposalCounts.get(token) !== 1) continue;
      if (after.has(token) && after.get(token) !== branch) reasons.add('token_moved_branch');
    }
    // Skeleton pieces must keep their relative order (swapping them swaps branch contents).
    const curOrder = currentTokens.filter((t) => t.kind === 'S').map((t) => t.token);
    const seen = new Set<string>();
    const newOrder = proposal.tokens.filter((t) => t.kind === 'S' && map.tokens.has(t.token) && !seen.has(t.token) && seen.add(t.token)).map((t) => t.token);
    const curFiltered = curOrder.filter((t) => seen.has(t));
    if (curFiltered.some((t, i) => newOrder[i] !== t)) reasons.add('token_moved_branch');
  }

  // 3. unmask + reparse
  const um = unmask(proposalMasked, map);
  if (!um.ok) reasons.add('unmask_failed');
  const text = um.text;
  let reparsed = true;
  if (dialect === 'icu') {
    if (!parseIcu(text).ok) {
      reasons.add('icu_reparse_failed');
      reparsed = false;
    }
  } else if (tokenizePlaceholders(text, dialect).errors.length > 0) {
    reasons.add('tokenize_failed');
    reparsed = false;
  }

  // 4. structure against the current target
  const curSig = structureSignature(currentTarget, dialect);
  const fixSig = structureSignature(text, dialect);
  const diff = compareStructure(curSig, fixSig);
  if (diff.structure || (!reparsed && dialect === 'icu')) reasons.add('structure_changed');
  if (diff.placeholders) reasons.add('placeholder_changed');
  if (diff.printfOrder) reasons.add('printf_order');
  if (diff.tags) reasons.add('tag_changed');

  // 5. URLs
  if (newUrls(currentTarget, text).length > 0) reasons.add('new_url');

  // 6. length
  const fixLen = visibleLength(text, dialect);
  if (ctx.maxLength !== undefined) {
    if (fixLen > ctx.maxLength) reasons.add('max_length');
  } else {
    const limit = Math.floor(LENGTH_RATIO_LIMIT * visibleLength(ctx.sourceText, dialect));
    if (fixLen > limit) reasons.add('length_ratio');
  }

  const ordered = GATE_REASONS.filter((r) => reasons.has(r));
  const result: GateResult = ordered.length === 0 ? { ok: true, text } : { ok: false, reasons: ordered, text };
  if (stats) recordGate(stats, result);
  return result;
}
