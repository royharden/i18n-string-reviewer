// Masking (PLAN §3.3): a SINGLE span-based pass over the original text. Generated tokens are never
// re-scanned, so a literal "⟦P1⟧" typed by a translator can never be confused with a real token.
//
//   1. Collect spans on the original text:
//        secret-shaped substrings (shared/redact.ts)           → ⟦Rn⟧  (never restorable, never in a legend)
//        literal U+27E6 "⟦" / U+27E7 "⟧" characters             → ⟦Ln⟧  (restorable)
//        placeholders / ICU arguments / ICU `#`                  → ⟦Pn⟧
//        markup tags                                             → ⟦Tn⟧ … ⟦/Tn⟧, void/self-closing ⟦Tn/⟧
//        ICU plural/select skeleton pieces                       → ⟦Sn⟧  (branch prose stays visible)
//      Spans never overlap. Precedence: secret > literal delimiter > structural; among structural
//      spans the earlier start wins, then the longer span.
//   2. Emit left to right; everything outside a span is copied verbatim.
//
// R numbering is shared by every field of one item (so repeated secrets each get their own index
// across key, source, target, notes, …); L/P/T/S numbering restarts per field. Only the TARGET's
// restore map is used to unmask a proposed fix; the gate re-derives the target's masked form.
//
// Pure: no DOM / Node / Deno globals.

import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTimeElement,
} from '@formatjs/icu-messageformat-parser';
import { parseIcu } from '../l10nchecks/icu.ts';
import { displayPath } from '../l10nchecks/paths.ts';
import { tokenizePlaceholders } from '../l10nchecks/placeholders.ts';
import { pluralCategories } from '../l10nchecks/plural.ts';
import { VOID_ELEMENTS, scanTags } from '../l10nchecks/tags.ts';
import type { ContextEntry, Dialect, GlossaryEntry } from '../l10nchecks/types.ts';
import { findSecretSpans } from '../shared/redact.ts';
import { buildContextPack, glossaryLine } from '../context/pack.ts';

/** U+27E6 MATHEMATICAL LEFT WHITE SQUARE BRACKET. */
export const TOKEN_OPEN = '⟦';
/** U+27E7 MATHEMATICAL RIGHT WHITE SQUARE BRACKET. */
export const TOKEN_CLOSE = '⟧';

export type TokenKind = 'R' | 'L' | 'P' | 'T' | 'S';

/** Source of the token regex: ⟦Pn⟧, ⟦Tn⟧, ⟦/Tn⟧, ⟦Tn/⟧, ⟦Sn⟧, ⟦Ln⟧, ⟦Rn⟧. Compile fresh per use (`g` state). */
export const TOKEN_PATTERN = '⟦(\\/?)([RLPTS])(\\d+)(\\/?)⟧';

export function tokenRegExp(): RegExp {
  return new RegExp(TOKEN_PATTERN, 'gu');
}

export type MaskField = 'key' | 'source' | 'target' | 'screen' | 'note' | 'description' | 'glossary' | 'sibling';

export interface LegendEntry {
  readonly field: MaskField;
  readonly token: string;
  readonly kind: 'placeholder' | 'tag' | 'skeleton';
  /** What the token stands for, e.g. `{name}`, `<b>`, `{count, plural, one {`. Never a secret. */
  readonly display: string;
}

export interface RestoreMap {
  readonly field: MaskField;
  /** Exact original for non-redacted text; empty for redacted text (never retains a secret). */
  readonly original: string;
  /** Token → original substring. Holds L/P/T/S tokens only — never an R token, never a secret. */
  readonly tokens: ReadonlyMap<string, string>;
}

export interface FieldMask {
  readonly masked: string;
  readonly restore: RestoreMap;
  /** Structural tokens only (P, T, S). */
  readonly legend: readonly LegendEntry[];
  /** Number of ⟦Rn⟧ tokens emitted for this field. */
  readonly secrets: number;
  /** ICU dialect: whether the text parsed (structural spans come from the AST). Always true otherwise. */
  readonly parsed: boolean;
  /** Deepest plural/select nesting (ICU); 0 otherwise. */
  readonly choiceDepth: number;
  /** A plural/select skeleton could not be split safely and was masked as one piece. */
  readonly degraded: boolean;
}

export interface SecretCounter {
  next: number;
}

export interface MaskTextOptions {
  readonly dialect: Dialect;
  /** Mask placeholders/tags/skeleton (source, target, siblings). False for metadata and keys. */
  readonly structural?: boolean;
  readonly field?: MaskField;
  /** Shared ⟦Rn⟧ counter (one per item). */
  readonly secretCounter?: SecretCounter;
}

type SpanKind = 'secret' | 'literal' | 'placeholder' | 'tag_open' | 'tag_close' | 'tag_self' | 'skeleton';

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: SpanKind;
  readonly tagName?: string;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

interface Located {
  readonly start: number;
  readonly end: number;
}

function locOf(el: unknown): Located | null {
  const loc = (el as { location?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).location;
  const start = loc?.start?.offset;
  const end = loc?.end?.offset;
  return typeof start === 'number' && typeof end === 'number' && end > start ? { start, end } : null;
}

interface OptionWithLocation {
  readonly key: string;
  readonly value: MessageFormatElement[];
  readonly loc: Located | null;
}

/** Plural/select options with their `{…}` locations, in text order (a `__proto__` key is recovered). */
function optionsOf(options: unknown): OptionWithLocation[] {
  const out: OptionWithLocation[] = [];
  const rec = options as Record<string, { value?: unknown; location?: unknown }>;
  for (const key of Object.keys(rec)) {
    const opt = rec[key];
    if (opt && Array.isArray(opt.value)) out.push({ key, value: opt.value as MessageFormatElement[], loc: locOf(opt) });
  }
  const proto: unknown = Object.getPrototypeOf(options);
  if (proto !== null && proto !== Object.prototype && typeof proto === 'object') {
    const v = (proto as { value?: unknown }).value;
    if (Array.isArray(v)) out.push({ key: '__proto__', value: v as MessageFormatElement[], loc: locOf(proto) });
  }
  return out.sort((a, b) => (a.loc?.start ?? 0) - (b.loc?.start ?? 0));
}

interface StructuralScan {
  readonly spans: Span[];
  readonly parsed: boolean;
  readonly choiceDepth: number;
  readonly degraded: boolean;
}

function icuStructuralSpans(text: string): StructuralScan | null {
  const parsed = parseIcu(text);
  if (!parsed.ok) return null;
  const spans: Span[] = [];
  let choiceDepth = 0;
  let degraded = false;
  const walk = (els: readonly MessageFormatElement[], depth: number): void => {
    for (const el of els) {
      const loc = locOf(el);
      if (isPoundElement(el) || isArgumentElement(el) || isNumberElement(el) || isDateElement(el) || isTimeElement(el)) {
        if (loc) spans.push({ start: loc.start, end: loc.end, kind: 'placeholder' });
        else degraded = true;
        continue;
      }
      if (isPluralElement(el) || isSelectElement(el)) {
        const d = depth + 1;
        if (d > choiceDepth) choiceDepth = d;
        const opts = optionsOf(el.options);
        const sound =
          loc !== null &&
          opts.length > 0 &&
          text[loc.end - 1] === '}' &&
          opts.every((o) => o.loc !== null && text[o.loc.start] === '{' && text[o.loc.end - 1] === '}' && o.loc.start > loc.start && o.loc.end < loc.end);
        if (!sound || loc === null) {
          // Cannot split safely: mask the whole construct as one skeleton piece (fixes then disabled).
          if (loc) spans.push({ start: loc.start, end: loc.end, kind: 'skeleton' });
          degraded = true;
          continue;
        }
        const first = opts[0]!.loc!;
        spans.push({ start: loc.start, end: first.start + 1, kind: 'skeleton' });
        for (let i = 0; i + 1 < opts.length; i++) {
          const cur = opts[i]!.loc!;
          const next = opts[i + 1]!.loc!;
          spans.push({ start: cur.end - 1, end: next.start + 1, kind: 'skeleton' });
        }
        const last = opts[opts.length - 1]!.loc!;
        spans.push({ start: last.end - 1, end: loc.end, kind: 'skeleton' });
        for (const o of opts) walk(o.value, d);
      }
    }
  };
  walk(parsed.ast, 0);
  return { spans, parsed: true, choiceDepth, degraded };
}

function tagSpans(text: string): Span[] {
  const tokens = scanTags(text);
  const closed = new Set(tokens.filter((t) => t.kind === 'close').map((t) => t.name));
  return tokens.map((t): Span => {
    const self = t.kind === 'self' || (t.kind === 'open' && VOID_ELEMENTS.has(t.name) && !closed.has(t.name));
    return { start: t.start, end: t.end, kind: self ? 'tag_self' : t.kind === 'close' ? 'tag_close' : 'tag_open', tagName: t.name };
  });
}

function structuralSpans(text: string, dialect: Dialect): StructuralScan {
  if (dialect === 'icu') {
    const icu = icuStructuralSpans(text);
    if (icu) return { ...icu, spans: [...icu.spans, ...tagSpans(text)] };
    // Unparseable ICU: fall back to brace placeholders + tags so the model still sees tokens.
    const plain = tokenizePlaceholders(text, 'plain');
    const spans = [...plain.tokens.map((t): Span => ({ start: t.start, end: t.end, kind: 'placeholder' })), ...tagSpans(text)];
    return { spans, parsed: false, choiceDepth: 0, degraded: false };
  }
  const scan = tokenizePlaceholders(text, dialect);
  const spans = [...scan.tokens.map((t): Span => ({ start: t.start, end: t.end, kind: 'placeholder' })), ...tagSpans(text)];
  return { spans, parsed: true, choiceDepth: 0, degraded: false };
}

/** Choose non-overlapping spans: secrets, then literal delimiters, then structural (earliest, longest). */
function selectSpans(text: string, structural: readonly Span[]): Span[] {
  const accepted: Span[] = [];
  for (const s of findSecretSpans(text)) accepted.push({ start: s.start, end: s.end, kind: 'secret' });
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== TOKEN_OPEN && c !== TOKEN_CLOSE) continue;
    const span: Span = { start: i, end: i + 1, kind: 'literal' };
    if (!accepted.some((a) => overlaps(a, span))) accepted.push(span);
  }
  const ordered = [...structural].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  for (const s of ordered) {
    if (s.end <= s.start) continue;
    if (!accepted.some((a) => overlaps(a, s))) accepted.push(s);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

function legendKind(kind: SpanKind): LegendEntry['kind'] | null {
  if (kind === 'placeholder') return 'placeholder';
  if (kind === 'skeleton') return 'skeleton';
  if (kind === 'tag_open' || kind === 'tag_close' || kind === 'tag_self') return 'tag';
  return null;
}

/** Mask one field. Deterministic: the same text, dialect and options always give the same output. */
export function maskText(text: string, opts: MaskTextOptions): FieldMask {
  const field = opts.field ?? 'target';
  const structuralOn = opts.structural !== false;
  const scan: StructuralScan = structuralOn ? structuralSpans(text, opts.dialect) : { spans: [], parsed: true, choiceDepth: 0, degraded: false };
  const spans = selectSpans(text, scan.spans);
  const counter = opts.secretCounter ?? { next: 1 };
  const tokens = new Map<string, string>();
  const legend: LegendEntry[] = [];
  let nextL = 1;
  let nextP = 1;
  let nextT = 1;
  let nextS = 1;
  const openTags: Array<{ name: string; n: number }> = [];
  let secrets = 0;
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    pos = s.end;
    const raw = text.slice(s.start, s.end);
    let token: string;
    switch (s.kind) {
      case 'secret':
        token = `${TOKEN_OPEN}R${counter.next++}${TOKEN_CLOSE}`;
        secrets++;
        out += token;
        continue; // never restorable, never in a legend
      case 'literal':
        token = `${TOKEN_OPEN}L${nextL++}${TOKEN_CLOSE}`;
        break;
      case 'placeholder':
        token = `${TOKEN_OPEN}P${nextP++}${TOKEN_CLOSE}`;
        break;
      case 'skeleton':
        token = `${TOKEN_OPEN}S${nextS++}${TOKEN_CLOSE}`;
        break;
      case 'tag_self':
        token = `${TOKEN_OPEN}T${nextT++}/${TOKEN_CLOSE}`;
        break;
      case 'tag_open': {
        const n = nextT++;
        openTags.push({ name: s.tagName ?? '', n });
        token = `${TOKEN_OPEN}T${n}${TOKEN_CLOSE}`;
        break;
      }
      case 'tag_close': {
        let idx = -1;
        for (let k = openTags.length - 1; k >= 0; k--) {
          if (openTags[k]!.name === s.tagName) {
            idx = k;
            break;
          }
        }
        let n: number;
        if (idx === -1) n = nextT++;
        else {
          n = openTags[idx]!.n;
          openTags.splice(idx, 1);
        }
        token = `${TOKEN_OPEN}/T${n}${TOKEN_CLOSE}`;
        break;
      }
    }
    tokens.set(token, raw);
    const lk = legendKind(s.kind);
    if (lk !== null) legend.push({ field, token, kind: lk, display: raw });
    out += token;
  }
  out += text.slice(pos);
  return {
    masked: out,
    restore: { field, original: secrets === 0 ? text : '', tokens },
    legend,
    secrets,
    parsed: scan.parsed,
    choiceDepth: scan.choiceDepth,
    degraded: scan.degraded,
  };
}

export interface ParsedToken {
  readonly token: string;
  readonly kind: TokenKind;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface TokenScan {
  readonly tokens: readonly ParsedToken[];
  /** Offsets of "⟦" / "⟧" characters that are not part of a well-formed token. */
  readonly stray: readonly number[];
}

/** Find every token-shaped substring in masked text, plus stray delimiter characters. */
export function scanTokens(masked: string): TokenScan {
  const tokens: ParsedToken[] = [];
  const stray: number[] = [];
  const re = tokenRegExp();
  let pos = 0;
  const strayIn = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (masked[i] === TOKEN_OPEN || masked[i] === TOKEN_CLOSE) stray.push(i);
  };
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    strayIn(pos, m.index);
    const slashBefore = m[1] === '/';
    const slashAfter = m[4] === '/';
    const kind = m[2] as TokenKind;
    // A slash on both sides, or a slash on a non-tag token, is malformed: stray delimiters.
    if ((slashBefore && slashAfter) || ((slashBefore || slashAfter) && kind !== 'T')) {
      stray.push(m.index, m.index + m[0].length - 1);
    } else {
      tokens.push({ token: m[0], kind, index: Number(m[3]), start: m.index, end: m.index + m[0].length });
    }
    pos = m.index + m[0].length;
  }
  strayIn(pos, masked.length);
  return { tokens, stray };
}

export type UnmaskResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      /** Best effort: known tokens restored, unknown and secret tokens removed, stray delimiters kept. */
      readonly text: string;
      readonly unknown: readonly string[];
      readonly secret: readonly string[];
      readonly stray: number;
    };

/** Inverse of `maskText` for one field. Fails on any ⟦Rn⟧, unknown token or stray delimiter. */
export function unmask(masked: string, restore: RestoreMap): UnmaskResult {
  const scan = scanTokens(masked);
  const unknown: string[] = [];
  const secret: string[] = [];
  let out = '';
  let pos = 0;
  for (const t of scan.tokens) {
    out += masked.slice(pos, t.start);
    pos = t.end;
    if (t.kind === 'R') {
      secret.push(t.token);
      continue;
    }
    const raw = restore.tokens.get(t.token);
    if (raw === undefined) {
      unknown.push(t.token);
      continue;
    }
    out += raw;
  }
  out += masked.slice(pos);
  if (unknown.length === 0 && secret.length === 0 && scan.stray.length === 0) return { ok: true, text: out };
  return { ok: false, text: out, unknown, secret, stray: scan.stray.length };
}

// --- whole review items ---

export type NotAllowedReason = 'fix_not_allowed_nested' | 'fix_not_allowed_redacted' | 'fix_not_allowed_empty_source';

/** The model-visible, masked form of one source/target string pair (PLAN §3.3, §3.9). */
export interface MaskedItem {
  readonly itemId: string;
  /** Key path segments, masked (secrets and literal delimiters only). */
  readonly key: readonly string[];
  readonly locale: string;
  readonly sourceLocale: string;
  readonly dialect: Dialect;
  readonly source: string;
  readonly target: string;
  /** Masked context pack, at most 2,000 UTF-16 code units (context/pack.ts). */
  readonly context: string;
  /** Structural tokens of source and target. */
  readonly legend: readonly LegendEntry[];
  readonly fixAllowed: boolean;
}

export interface SiblingInput {
  readonly path: readonly string[];
  readonly source: string;
  readonly target?: string;
}

export interface ReviewInput {
  readonly itemId: string;
  readonly path: readonly string[];
  readonly locale: string;
  readonly sourceLocale: string;
  readonly dialect: Dialect;
  readonly source: string;
  readonly target: string;
  readonly context?: ContextEntry;
  /** Glossary entries that match the source (context/pack.ts `matchGlossary`). */
  readonly glossary?: readonly GlossaryEntry[];
  readonly siblings?: readonly SiblingInput[];
}

export interface MaskResult {
  readonly masked: MaskedItem;
  /** Target restore map: the only one used to unmask a fix. */
  readonly restore: RestoreMap;
  readonly legend: readonly LegendEntry[];
  readonly fixAllowed: boolean;
  readonly notAllowed: readonly NotAllowedReason[];
  /** Any field produced an ⟦Rn⟧ token. */
  readonly redacted: boolean;
  /** Every field's restore map (for audits/tests: none may hold a secret or an R token). */
  readonly restores: readonly RestoreMap[];
  /** Total ⟦Rn⟧ tokens across all fields. */
  readonly secretCount: number;
}

/**
 * Whether a fix may be proposed for this pair, from the masked source/target fields.
 * Any redaction in the item disables fixes: the model never saw the complete review context.
 */
export function fixability(source: FieldMask, target: FieldMask, sourceText: string, keySecrets = 0): NotAllowedReason[] {
  const reasons: NotAllowedReason[] = [];
  if (source.choiceDepth >= 2 || target.choiceDepth >= 2 || source.degraded || target.degraded) reasons.push('fix_not_allowed_nested');
  if (source.secrets + target.secrets + keySecrets > 0) reasons.push('fix_not_allowed_redacted');
  if (sourceText.trim().length === 0) reasons.push('fix_not_allowed_empty_source');
  return reasons;
}

/** Mask every model-visible field of one item with one shared ⟦Rn⟧ counter and build its context pack. */
export function maskItem(input: ReviewInput): MaskResult {
  const counter: SecretCounter = { next: 1 };
  const restores: RestoreMap[] = [];
  let secretCount = 0;
  const meta = (text: string, field: MaskField): string => {
    const m = maskText(text, { dialect: input.dialect, structural: false, field, secretCounter: counter });
    restores.push(m.restore);
    secretCount += m.secrets;
    return m.masked;
  };
  const full = (text: string, field: MaskField): FieldMask => {
    const m = maskText(text, { dialect: input.dialect, structural: true, field, secretCounter: counter });
    restores.push(m.restore);
    secretCount += m.secrets;
    return m;
  };

  const keyStart = counter.next;
  const key = input.path.map((seg) => meta(seg, 'key'));
  const keySecrets = counter.next - keyStart;
  const source = full(input.source, 'source');
  const target = full(input.target, 'target');

  const ctx = input.context;
  const screen = ctx?.screen !== undefined ? meta(ctx.screen, 'screen') : undefined;
  const note = ctx?.note !== undefined ? meta(ctx.note, 'note') : undefined;
  const description = ctx?.description !== undefined ? meta(ctx.description, 'description') : undefined;
  const glossary = (input.glossary ?? []).map((g) => meta(glossaryLine(g, input.locale), 'glossary'));
  const siblings = (input.siblings ?? []).map((s) => {
    const k = meta(displayPath(s.path), 'key');
    const src = full(s.source, 'sibling').masked;
    const tgt = s.target !== undefined ? full(s.target, 'sibling').masked : '';
    return { key: k, source: src, target: tgt };
  });

  let cats: readonly string[] = [];
  try {
    cats = pluralCategories(input.locale, 'cardinal');
  } catch {
    cats = [];
  }
  const context = buildContextPack({
    sourceLocale: input.sourceLocale,
    locale: input.locale,
    source: source.masked,
    pluralCategories: cats,
    ...(screen !== undefined ? { screen } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(ctx?.maxLength !== undefined ? { maxLength: ctx.maxLength } : {}),
    ...(description !== undefined ? { description } : {}),
    glossary,
    siblings,
  });

  const notAllowed = fixability(source, target, input.source, keySecrets);
  if (secretCount > 0 && !notAllowed.includes('fix_not_allowed_redacted')) notAllowed.push('fix_not_allowed_redacted');
  const legend = [...source.legend, ...target.legend];
  const fixAllowed = notAllowed.length === 0;
  return {
    masked: {
      itemId: input.itemId,
      key,
      locale: input.locale,
      sourceLocale: input.sourceLocale,
      dialect: input.dialect,
      source: source.masked,
      target: target.masked,
      context,
      legend,
      fixAllowed,
    },
    restore: target.restore,
    legend,
    fixAllowed,
    notAllowed,
    redacted: secretCount > 0,
    restores,
    secretCount,
  };
}

/** Field mask of a target exactly as `maskItem` produces it (R indices aside, which are never restored). */
export function maskTarget(target: string, dialect: Dialect): FieldMask {
  return maskText(target, { dialect, structural: true, field: 'target' });
}
