import { detectDialect } from '../core/l10nchecks/dialect.ts';
import { suggestLocaleFromFileName } from '../core/l10nchecks/locale.ts';
import { parseLocale } from '../core/l10nchecks/parse.ts';
import type { Dialect } from '../core/l10nchecks/types.ts';
import type { FileInput } from '../core/review/pipeline.ts';

export interface StagedFile extends FileInput {
  readonly id: string;
  readonly confirmed: boolean;
  readonly suggestion: string;
}

export function stageFile(fileName: string, bytes: Uint8Array, id: string, role: 'source' | 'target'): StagedFile {
  const locale = suggestLocaleFromFileName(fileName) ?? '';
  const parsed = parseLocale(bytes, { fileName, locale: locale || 'en', dialect: 'plain', role });
  const suggestion = detectDialect(parsed.doc);
  return { id, fileName, bytes, locale, dialect: suggestion.dialect, confirmed: false, suggestion: suggestion.reason };
}

export const DIALECT_LABELS: Readonly<Record<Dialect, string>> = { icu: 'ICU MessageFormat', i18next: 'i18next', plain: 'Plain text / printf' };

/** Display-only: raw strings and evidence offsets remain untouched. */
export function showBidi(text: string, visible: boolean): string {
  if (!visible) return text;
  const labels: Readonly<Record<string, string>> = {
    '\u061c': 'ALM', '\u200e': 'LRM', '\u200f': 'RLM', '\u202a': 'LRE', '\u202b': 'RLE',
    '\u202c': 'PDF', '\u202d': 'LRO', '\u202e': 'RLO', '\u2066': 'LRI', '\u2067': 'RLI', '\u2068': 'FSI', '\u2069': 'PDI',
  };
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (ch) => `⟨${labels[ch] ?? 'BIDI'}⟩`);
}

/** A small contiguous diff, measured in code points so surrogate pairs remain intact. */
export function textDiff(before: string, after: string): { prefix: string; removed: string; added: string; suffix: string } {
  const a = [...before];
  const b = [...after];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { prefix: a.slice(0, start).join(''), removed: a.slice(start, a.length - end).join(''), added: b.slice(start, b.length - end).join(''), suffix: end ? a.slice(a.length - end).join('') : '' };
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null || (target as HTMLElement).isContentEditable);
}

export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_');
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}
