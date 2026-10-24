// Patched export (PLAN §3.8): only approved, gate-revalidated, fingerprint-current fixes are written,
// with jsonc-parser `modify` + `applyEdits` on the ORIGINAL text. Every byte outside the replaced
// value ranges is identical to the input (a leading BOM is re-added). Keys are never inserted.
// Files with `eligible.export = false` (duplicate keys, path conflicts, JSON errors, rejected) are refused.

import { applyEdits, modify } from 'jsonc-parser';
import type { Edit } from 'jsonc-parser';
import type { Finding } from '../cited/finding.ts';
import { matchGlossary, selectSiblings } from '../context/pack.ts';
import { pathKey } from '../l10nchecks/paths.ts';
import { alignDocuments } from '../l10nchecks/pairs.ts';
import { parsePluralSuffix } from '../l10nchecks/plural.ts';
import type { ContextMap, Entry, GlossaryEntry, LocaleDocument } from '../l10nchecks/types.ts';
import { validateFix } from '../maskgate/gate.ts';
import type { GateReason } from '../maskgate/gate.ts';
import { maskItem } from '../maskgate/mask.ts';
import { suggestionHash } from '../rulings/fingerprint.ts';
import { fingerprintForFinding } from '../rulings/rulings.ts';
import type { Ruling } from '../rulings/rulings.ts';

/**
 * Source text a target key is compared with: the same key, or — for an i18next plural-suffix family
 * member such as `count_few` — the source's same-category member, else its `_other` member.
 */
export function resolveSourceText(source: LocaleDocument, key: readonly string[]): string | undefined {
  const exact = source.entries.get(pathKey(key));
  if (exact) return exact.kind === 'string' ? (exact.value as string) : undefined;
  if (source.dialect !== 'i18next') return undefined;
  const last = key[key.length - 1];
  const sfx = last === undefined ? null : parsePluralSuffix(last);
  if (!sfx) return undefined;
  const parent = key.slice(0, -1);
  if (!alignDocuments(source, source).families.some((f) => f.type === sfx.type && pathKey(f.basePath) === pathKey([...parent, sfx.base]))) return undefined;
  const infix = sfx.type === 'ordinal' ? '_ordinal_' : '_';
  for (const cat of [sfx.category, 'other']) {
    const e = source.entries.get(pathKey([...parent, `${sfx.base}${infix}${cat}`]));
    if (e?.kind === 'string') return e.value as string;
  }
  return undefined;
}

/**
 * The edit that replaces one string value. Uses jsonc-parser `modify`; accepts its result only when
 * it is exactly one edit over the value's own range (no reformatting of neighbouring bytes), and
 * otherwise falls back to the identical direct value-range edit. Null when the range is not the
 * string literal the document recorded.
 */
export function valueEdit(text: string, entry: Entry, value: string): Edit | null {
  const literal = text.slice(entry.offset, entry.offset + entry.length);
  let recorded: unknown;
  try {
    recorded = JSON.parse(literal);
  } catch {
    return null;
  }
  if (typeof recorded !== 'string' || recorded !== entry.value) return null;
  const content = JSON.stringify(value);
  let edits: Edit[] = [];
  try {
    edits = modify(text, [...entry.path], value, {});
  } catch {
    edits = [];
  }
  const only = edits.length === 1 ? edits[0] : undefined;
  if (only && only.offset === entry.offset && only.length === entry.length && only.content === content) return only;
  return { offset: entry.offset, length: entry.length, content };
}

/** Full file text (BOM re-added when the original had one) with one string value replaced. For UI edits. */
export function replaceStringValue(doc: LocaleDocument, key: readonly string[], value: string): { ok: true; text: string } | { ok: false; reason: string } {
  const entry = doc.entries.get(pathKey(key));
  if (!entry || entry.kind !== 'string') return { ok: false, reason: 'key is not a string in this file' };
  const edit = valueEdit(doc.text, entry, value);
  if (!edit) return { ok: false, reason: 'value range does not match the parsed document' };
  return { ok: true, text: (doc.bom ? '﻿' : '') + applyEdits(doc.text, [edit]) };
}

export interface ApprovedFix {
  readonly finding: Finding;
  readonly ruling: Ruling;
}

export interface PatchContext {
  /** The source document (current), for fingerprints and the gate's source checks. */
  readonly source: LocaleDocument;
  readonly context?: ContextMap;
  readonly glossary?: readonly GlossaryEntry[];
}

export type SkipReason =
  | 'file_ineligible'
  | 'not_approve_fix'
  | 'finding_mismatch'
  | 'locale_mismatch'
  | 'no_suggestion'
  | 'suggestion_hash_mismatch'
  | 'key_not_in_target'
  | 'not_a_string'
  | 'no_source'
  | 'stale_fingerprint'
  | 'competing_approvals'
  | 'gate_rejected'
  | 'edit_range_mismatch';

export interface SkippedFix {
  readonly findingId: string;
  readonly key: readonly string[];
  readonly reason: SkipReason;
  readonly gateReasons?: readonly GateReason[];
}

export interface AppliedFix {
  readonly findingId: string;
  readonly key: readonly string[];
  /** Range of the replaced value in the ORIGINAL text (BOM excluded). */
  readonly offset: number;
  readonly length: number;
  readonly value: string;
}

export type PatchResult =
  | { readonly ok: true; readonly text: string; readonly applied: readonly AppliedFix[]; readonly skipped: readonly SkippedFix[] }
  | { readonly ok: false; readonly refused: string; readonly applied: readonly AppliedFix[]; readonly skipped: readonly SkippedFix[] };

/** Apply approved fixes to one target document. Async (re-hashes suggestions and fingerprints). */
export async function applyApprovedFixes(doc: LocaleDocument, fixes: readonly ApprovedFix[], ctx: PatchContext): Promise<PatchResult> {
  const skipped: SkippedFix[] = [];
  const skip = (f: ApprovedFix, reason: SkipReason, gateReasons?: readonly GateReason[]): void => {
    skipped.push(gateReasons ? { findingId: f.finding.id, key: f.finding.key, reason, gateReasons } : { findingId: f.finding.id, key: f.finding.key, reason });
  };
  if (doc.rejected || !doc.eligible.export || ctx.source.rejected || !ctx.source.eligible.export || doc.dialect !== ctx.source.dialect) {
    for (const f of fixes) skip(f, 'file_ineligible');
    return {
      ok: false,
      refused: `${doc.fileName} is not eligible for export (duplicate keys, conflicting paths, JSON errors or a rejected import); fix the file and re-import`,
      applied: [],
      skipped,
    };
  }

  const perKey = new Map<string, number>();
  for (const f of fixes) {
    if (f.ruling.decision !== 'approve_fix') continue;
    const pk = pathKey(f.finding.key);
    perKey.set(pk, (perKey.get(pk) ?? 0) + 1);
  }

  const edits: Edit[] = [];
  const applied: AppliedFix[] = [];
  const aligned = new Map(alignDocuments(ctx.source, doc).pairs.map((p) => [pathKey(p.path), p]));
  for (const f of fixes) {
    const { finding, ruling } = f;
    if (ruling.decision !== 'approve_fix') {
      skip(f, 'not_approve_fix');
      continue;
    }
    if (ruling.findingId !== finding.id || pathKey(ruling.key) !== pathKey(finding.key)) {
      skip(f, 'finding_mismatch');
      continue;
    }
    if (finding.locale !== doc.locale || ruling.locale !== doc.locale) {
      skip(f, 'locale_mismatch');
      continue;
    }
    const fix = finding.suggestedFix;
    const masked = finding.suggestedFixMasked;
    if (fix === undefined || masked === undefined || finding.suggestionHash === undefined || finding.evidenceStatus !== 'supported') {
      skip(f, 'no_suggestion');
      continue;
    }
    if (ruling.suggestionHash !== finding.suggestionHash || (await suggestionHash(fix)) !== finding.suggestionHash) {
      skip(f, 'suggestion_hash_mismatch');
      continue;
    }
    const pk = pathKey(finding.key);
    if ((perKey.get(pk) ?? 0) > 1) {
      skip(f, 'competing_approvals');
      continue;
    }
    const entry = doc.entries.get(pk);
    if (!entry) {
      skip(f, 'key_not_in_target');
      continue;
    }
    if (entry.kind !== 'string') {
      skip(f, 'not_a_string');
      continue;
    }
    const target = entry.value as string;
    const pair = aligned.get(pk);
    if (!pair) {
      skip(f, 'no_source');
      continue;
    }
    const sourceText = pair.source.value as string;
    if ((await fingerprintForFinding(finding, sourceText, target)) !== ruling.itemFingerprint) {
      skip(f, 'stale_fingerprint');
      continue;
    }
    const dialect = doc.dialect;
    const entryContext = ctx.context?.get(pathKey(pair.sourcePath)) ?? ctx.context?.get(pk) ?? (pair.family ? ctx.context?.get(pathKey(pair.family.basePath)) : undefined);
    const current = maskItem({ itemId: finding.itemId, path: finding.key, locale: doc.locale, sourceLocale: ctx.source.locale, dialect, source: sourceText, target,
      ...(entryContext !== undefined ? { context: entryContext } : {}), glossary: matchGlossary(sourceText, ctx.glossary ?? []), siblings: selectSiblings(ctx.source, doc, pair.sourcePath) });
    const maxLength = entryContext?.maxLength;
    const gate = validateFix(target, masked, current.restore, { dialect, sourceText, notAllowed: current.notAllowed, ...(maxLength !== undefined ? { maxLength } : {}) });
    if (!gate.ok) {
      skip(f, 'gate_rejected', gate.reasons);
      continue;
    }
    if (gate.text !== fix) {
      skip(f, 'gate_rejected');
      continue;
    }
    const edit = valueEdit(doc.text, entry, fix);
    if (!edit) {
      skip(f, 'edit_range_mismatch');
      continue;
    }
    edits.push(edit);
    applied.push({ findingId: finding.id, key: finding.key, offset: entry.offset, length: entry.length, value: fix });
  }
  const text = (doc.bom ? '﻿' : '') + (edits.length > 0 ? applyEdits(doc.text, edits) : doc.text);
  return { ok: true, text, applied, skipped };
}
