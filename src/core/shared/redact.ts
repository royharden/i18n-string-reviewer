// Secret-shaped substring detection (PLAN §3.3 step 1). Used by maskgate (browser, Node) and copied
// into the edge function's `_shared/` (Deno) by scripts/sync-function-shared.ts (M4).
// Function-copyable: imports nothing (src/core/shared/** may import only within shared/).
//
// Detection is deliberately over-eager: a false positive only hides a substring from the model and
// disables fixes for that string; a false negative would send a credential to a provider.

export type SecretKind =
  | 'pem_private_key'
  | 'url_credentials'
  | 'jwt'
  | 'anthropic_key'
  | 'openai_style_key'
  | 'github_token'
  | 'slack_token'
  | 'aws_access_key'
  | 'email'
  | 'long_hex'
  | 'long_base64';

export interface SecretSpan {
  readonly kind: SecretKind;
  /** UTF-16 offsets into the scanned text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

interface Pattern {
  readonly kind: SecretKind;
  readonly source: string;
  readonly flags: string;
  /** Optional extra filter on the matched text. */
  readonly accept?: (match: string) => boolean;
}

/**
 * Patterns in priority order (earlier wins on equal start; the longest match wins otherwise).
 * Sources are strings so each scan compiles fresh RegExp objects (no shared `lastIndex` state).
 */
export const SECRET_PATTERNS: readonly Pattern[] = [
  // PEM block: BEGIN line through END line, or to the end of the text when END is missing.
  {
    kind: 'pem_private_key',
    source: '-----BEGIN [A-Z0-9 ]*KEY-----(?:[\\s\\S]*?-----END [A-Z0-9 ]*KEY-----|[\\s\\S]*$)',
    flags: 'gu',
  },
  // scheme://user[:password]@host... — the whole URL (username-only credentials included).
  { kind: 'url_credentials', source: '\\b[A-Za-z][A-Za-z0-9+.-]*://[^\\s/:@]+(?::[^\\s/@]*)?@[^\\s"\'<>]+', flags: 'gu' },
  { kind: 'jwt', source: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', flags: 'gu' },
  { kind: 'anthropic_key', source: '\\bsk-ant-[A-Za-z0-9_-]{10,}', flags: 'gu' },
  { kind: 'openai_style_key', source: '\\bsk-[A-Za-z0-9_-]{16,}', flags: 'gu' },
  { kind: 'github_token', source: '\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})', flags: 'gu' },
  { kind: 'slack_token', source: '\\bxox[bpas]-[A-Za-z0-9-]{10,}', flags: 'gu' },
  { kind: 'aws_access_key', source: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b', flags: 'gu' },
  { kind: 'email', source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}', flags: 'gu' },
  { kind: 'long_hex', source: '\\b[0-9A-Fa-f]{32,}\\b', flags: 'gu' },
  // Base64 / base64url runs of 32+, including all-letter runs. Deliberately over-eager.
  { kind: 'long_base64', source: '[A-Za-z0-9+/_-]{32,}={0,2}', flags: 'gu' },
];

/**
 * Every secret-shaped span in `text`, non-overlapping, sorted by start. On overlap the earlier
 * start wins; on equal start the longer match wins; on equal length the higher-priority pattern.
 */
export function findSecretSpans(text: string): SecretSpan[] {
  const candidates: Array<SecretSpan & { readonly priority: number }> = [];
  SECRET_PATTERNS.forEach((p, priority) => {
    const re = new RegExp(p.source, p.flags);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (p.accept && !p.accept(m[0])) continue;
      candidates.push({ kind: p.kind, start: m.index, end: m.index + m[0].length, priority });
    }
  });
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.priority - b.priority);
  const out: SecretSpan[] = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.start < lastEnd) continue;
    out.push({ kind: c.kind, start: c.start, end: c.end });
    lastEnd = c.end;
  }
  return out;
}

export function containsSecret(text: string): boolean {
  return findSecretSpans(text).length > 0;
}

export const REDACTION_MARK = '[REDACTED]';

export interface RedactResult {
  readonly text: string;
  readonly count: number;
  readonly kinds: readonly SecretKind[];
}

/**
 * Replace each secret-shaped span with `[REDACTED]`. Used where no restore is needed (edge
 * function re-redaction, logs). maskgate uses `findSecretSpans` directly and emits `⟦Rn⟧`.
 */
export function redactText(text: string, mark: string = REDACTION_MARK): RedactResult {
  const spans = findSecretSpans(text);
  if (spans.length === 0) return { text, count: 0, kinds: [] };
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + mark;
    pos = s.end;
  }
  out += text.slice(pos);
  return { text: out, count: spans.length, kinds: spans.map((s) => s.kind) };
}
