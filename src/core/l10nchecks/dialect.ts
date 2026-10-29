// Dialect auto-detection (PLAN §3.1). A suggestion only: the UI shows it for one-click confirmation
// and checks for that file wait until it is confirmed; demo/eval manifests pin the dialect.

import { parsePluralSuffix } from './plural.ts';
import type { Dialect, Entry, LocaleDocument } from './types.ts';

const ICU_CONSTRUCT =
  /\{\s*[\p{L}\p{N}_$-]+\s*,\s*(?:plural|select|selectordinal|number|date|time|spellout|ordinal|duration)\s*[,}]/u;
const I18NEXT_INTERPOLATION = /\{\{[^{}]*\}\}|\$t\(/u;

export interface DialectSuggestion {
  readonly dialect: Dialect;
  /** Why: the first key path and construct that decided it, or 'no dialect-specific syntax found'. */
  readonly reason: string;
}

export function detectDialect(doc: Pick<LocaleDocument, 'entries'>): DialectSuggestion {
  const strings: Entry[] = [...doc.entries.values()].filter((e) => e.kind === 'string');
  for (const e of strings) {
    const m = ICU_CONSTRUCT.exec(e.value as string);
    if (m) return { dialect: 'icu', reason: `ICU construct "${m[0]}" in ${e.path.join('.')}` };
  }
  for (const e of strings) {
    const m = I18NEXT_INTERPOLATION.exec(e.value as string);
    if (m) return { dialect: 'i18next', reason: `i18next syntax "${m[0]}" in ${e.path.join('.')}` };
  }
  for (const e of strings) {
    const last = e.path[e.path.length - 1];
    if (last !== undefined && parsePluralSuffix(last) !== null) {
      return { dialect: 'i18next', reason: `i18next plural suffix on key ${e.path.join('.')}` };
    }
  }
  return { dialect: 'plain', reason: 'no dialect-specific syntax found' };
}
