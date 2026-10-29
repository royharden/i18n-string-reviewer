// Text helpers shared by the warning rules: code points, whitespace normalisation, bidi controls,
// injection-like phrases, letter counts and glossary term matching.

export function codePointLength(text: string): number {
  return [...text].length;
}

// --- whitespace_drift ---

/** `&nbsp;` / `&#160;` / `&#xA0;` ≡ U+00A0 ≡ U+202F (all mapped to U+00A0). Used for comparison only. */
export function normalizeSpaces(text: string): string {
  return text.replace(/&nbsp;|&#160;|&#x0*a0;/giu, '\u00A0').replace(/\u202F/gu, '\u00A0');
}

export interface WhitespaceProfile {
  readonly leading: string;
  readonly trailing: string;
  readonly doubleSpace: boolean;
}

export function whitespaceProfile(text: string): WhitespaceProfile {
  const t = normalizeSpaces(text);
  const leading = /^\s*/u.exec(t)?.[0] ?? '';
  const trailing = leading.length === t.length ? '' : (/\s*$/u.exec(t)?.[0] ?? '');
  return { leading, trailing, doubleSpace: /[ \u00A0]{2,}/u.test(t) };
}

function showWs(ws: string): string {
  return [...ws]
    .map((c) => (c === ' ' ? '␠' : `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`))
    .join(' ');
}

/** Differences in leading/trailing whitespace or double spaces; empty when none. */
export function whitespaceDifferences(source: string, target: string): string[] {
  const s = whitespaceProfile(source);
  const t = whitespaceProfile(target);
  const out: string[] = [];
  if (s.leading !== t.leading) out.push(`leading whitespace differs (source [${showWs(s.leading)}], target [${showWs(t.leading)}])`);
  if (s.trailing !== t.trailing) out.push(`trailing whitespace differs (source [${showWs(s.trailing)}], target [${showWs(t.trailing)}])`);
  if (s.doubleSpace !== t.doubleSpace) out.push(t.doubleSpace ? 'target has a double space the source does not' : 'source double space not kept in target');
  return out;
}

// --- bidi_control_chars ---

export const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function bidiControls(text: string): Set<string> {
  return new Set(text.match(BIDI_CONTROL_RE) ?? []);
}

export function codePointLabel(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

// --- injection_like_text ---

export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|all|any|these|those)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules?|directions?|guidelines?)\b/iu,
  // "you are now" only when it re-assigns a role ("You are now signed in" is ordinary UI text).
  /\byou are now (?:a |an |the |my )?(?:[\p{L}-]+ )?(?:assistant|ai|model|bot|system|developer|admin|administrator|unrestricted|jailbroken|dan)\b/iu,
  /\bsystem prompt\b/iu,
  /\bmark (?:this|it|the|these|them)\b[^.\n]{0,40}?\b(?:as )?(?:correct|approved|valid|ok|fine|accurate)\b/iu,
  /\bnew instructions?\s*:/iu,
  /<\s*script\b/iu,
];

/** The first injection-like phrase in `text`, or null. Flag only — review still runs. */
export function findInjectionLike(text: string): string | null {
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// --- letters, glossary ---

export function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Case-insensitive whole-word matcher for a glossary term (Unicode letters/digits as word chars). */
export function termRegExp(term: string, flags = 'giu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term.trim())}(?![\\p{L}\\p{N}_])`, flags);
}

export function containsTerm(text: string, term: string): boolean {
  if (term.trim().length === 0) return false;
  return termRegExp(term, 'iu').test(text);
}

/** Remove every occurrence of the given terms (whole word, case-insensitive). */
export function removeTerms(text: string, terms: readonly string[]): string {
  let out = text;
  for (const term of terms) {
    if (term.trim().length === 0) continue;
    out = out.replace(termRegExp(term), ' ');
  }
  return out;
}

/** JSON-quoted excerpt for messages and evidence (at most `max` code points before quoting). */
export function excerpt(text: string, max = 80): string {
  const cps = [...text];
  return JSON.stringify(cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : text);
}
