// Context pack (PLAN §3.6): the per-string context a reviewer sees, built in code from already
// MASKED fields, so the cap applies to exactly what leaves the browser.
//
// Fixed priority (highest first):
//   1. source text                      4. description
//   2. target locale + plural categories 5. glossary matches
//   3. context.json entry (screen, note, maxLength)   6. siblings (dropped first)
// Hard cap: CONTEXT_PACK_MAX UTF-16 code units (`.length`). Sections are added whole while they fit;
// the first section that does not fit is truncated deterministically (whole lines for glossary and
// siblings, otherwise a safe cut + "…") and every lower-priority section is dropped.
// A cut never splits a surrogate pair or a ⟦…⟧ token.
//
// Pure: no DOM / Node / Deno globals. Must not import maskgate (mask.ts imports this module).

import { pathKey } from '../l10nchecks/paths.ts';
import { containsTerm } from '../l10nchecks/text.ts';
import type { GlossaryEntry, LocaleDocument } from '../l10nchecks/types.ts';

export const CONTEXT_PACK_MAX = 2000;
export const MAX_SIBLINGS = 8;

const OPEN = '⟦';
const CLOSE = '⟧';
const ELLIPSIS = '…';

export interface PackSibling {
  readonly key: string;
  readonly source: string;
  readonly target: string;
}

/** Every text field must already be masked. */
export interface PackInput {
  readonly sourceLocale: string;
  readonly locale: string;
  readonly source: string;
  readonly pluralCategories: readonly string[];
  readonly screen?: string;
  readonly note?: string;
  readonly maxLength?: number;
  readonly description?: string;
  readonly glossary: readonly string[];
  readonly siblings: readonly PackSibling[];
}

/** Section names in priority order (exported for tests). */
export const PACK_SECTIONS = ['source', 'locale', 'context', 'description', 'glossary', 'siblings'] as const;
export type PackSection = (typeof PACK_SECTIONS)[number];

interface Section {
  readonly name: PackSection;
  /** Header line (always kept with at least one body line for list sections). */
  readonly header: string;
  readonly lines: readonly string[];
  /** List sections are truncated by whole lines; text sections by a safe character cut. */
  readonly list: boolean;
}

/** Largest prefix of `text` with length ≤ `max` that splits neither a surrogate pair nor a ⟦…⟧ token. */
export function safeCut(text: string, max: number): string {
  if (text.length <= max) return text;
  let n = Math.max(0, max);
  const code = text.charCodeAt(n - 1);
  if (n > 0 && code >= 0xd800 && code <= 0xdbff) n--;
  const cut = text.slice(0, n);
  const lastOpen = cut.lastIndexOf(OPEN);
  if (lastOpen !== -1 && cut.indexOf(CLOSE, lastOpen) === -1) return cut.slice(0, lastOpen);
  return cut;
}

function sectionsOf(input: PackInput): Section[] {
  const out: Section[] = [];
  out.push({ name: 'source', header: `Source (${input.sourceLocale}):`, lines: [input.source], list: false });
  const cats = input.pluralCategories.length > 0 ? input.pluralCategories.join(', ') : 'unknown';
  out.push({ name: 'locale', header: `Target locale: ${input.locale}; plural categories: ${cats}`, lines: [], list: false });
  const ctxLines: string[] = [];
  if (input.screen !== undefined) ctxLines.push(`Screen: ${input.screen}`);
  if (input.note !== undefined) ctxLines.push(`Note: ${input.note}`);
  if (input.maxLength !== undefined) ctxLines.push(`Max length: ${input.maxLength} characters`);
  if (ctxLines.length > 0) out.push({ name: 'context', header: 'Context:', lines: ctxLines, list: false });
  if (input.description !== undefined) out.push({ name: 'description', header: 'Description:', lines: [input.description], list: false });
  if (input.glossary.length > 0) out.push({ name: 'glossary', header: 'Glossary:', lines: input.glossary.map((g) => `- ${g}`), list: true });
  if (input.siblings.length > 0) {
    out.push({
      name: 'siblings',
      header: 'Nearby strings:',
      lines: input.siblings.map((s) => `- ${s.key}: ${s.source}${s.target.length > 0 ? ` => ${s.target}` : ''}`),
      list: true,
    });
  }
  return out;
}

function render(section: Section): string {
  if (section.lines.length === 0) return section.header;
  if (!section.list && section.lines.length === 1) return `${section.header} ${section.lines[0]}`;
  return [section.header, ...section.lines].join('\n');
}

/** Build the pack. Result `.length <= max` always. */
export function buildContextPack(input: PackInput, max: number = CONTEXT_PACK_MAX): string {
  max = Number.isFinite(max) ? Math.min(CONTEXT_PACK_MAX, Math.max(0, Math.floor(max))) : CONTEXT_PACK_MAX;
  let out = '';
  const sep = (): string => (out.length > 0 ? '\n' : '');
  for (const section of sectionsOf(input)) {
    const whole = render(section);
    if (out.length + sep().length + whole.length <= max) {
      out += sep() + whole;
      continue;
    }
    // Truncate this section, then stop: lower-priority sections are dropped.
    const room = max - out.length - sep().length;
    if (section.list) {
      let partial = section.header;
      let added = 0;
      for (const line of section.lines) {
        if (partial.length + 1 + line.length > room) break;
        partial += `\n${line}`;
        added++;
      }
      if (added > 0) out += sep() + partial;
    } else if (room > ELLIPSIS.length + 1) {
      const cut = safeCut(whole, room - ELLIPSIS.length);
      if (cut.length > 0) out += sep() + cut + ELLIPSIS;
    }
    break;
  }
  return out.length <= max ? out : safeCut(out, max);
}

/** Which named sections a pack contains, in order (tests: priority preserved under truncation). */
export function packSections(pack: string): PackSection[] {
  const found: PackSection[] = [];
  const lines = pack.split('\n');
  const starts: Array<[PackSection, (l: string) => boolean]> = [
    ['source', (l) => l.startsWith('Source (')],
    ['locale', (l) => l.startsWith('Target locale: ')],
    ['context', (l) => l === 'Context:' || l.startsWith('Context:')],
    ['description', (l) => l.startsWith('Description:')],
    ['glossary', (l) => l === 'Glossary:'],
    ['siblings', (l) => l === 'Nearby strings:'],
  ];
  for (const line of lines) {
    for (const [name, test] of starts) if (test(line) && !found.includes(name)) found.push(name);
  }
  return found;
}

// --- helpers used by the pipeline (unmasked inputs; mask.ts masks their output) ---

/** Glossary entries whose term occurs in the source (case-insensitive, whole word). */
export function matchGlossary(sourceText: string, glossary: readonly GlossaryEntry[]): GlossaryEntry[] {
  return glossary.filter((g) => containsTerm(sourceText, g.term));
}

/** One glossary line for the pack (unmasked; maskItem masks it as a metadata field). */
export function glossaryLine(entry: GlossaryEntry, locale: string): string {
  const parts: string[] = [`"${entry.term}"`];
  if (entry.doNotTranslate === true) parts.push('do not translate');
  const tr = entry.translations?.[locale];
  if (tr !== undefined) parts.push(`${locale}: "${tr}"`);
  let line = parts.join(' | ');
  if (entry.note !== undefined) line += ` (${entry.note})`;
  return line;
}

export interface SiblingRef {
  readonly path: readonly string[];
  readonly source: string;
  readonly target?: string;
}

/**
 * Up to `max` source strings that share the parent path of `path` (excluding `path` itself), in
 * document order, with the target's value when it has a string there.
 */
export function selectSiblings(source: LocaleDocument, target: LocaleDocument, path: readonly string[], max: number = MAX_SIBLINGS): SiblingRef[] {
  const parent = path.slice(0, -1);
  const self = pathKey(path);
  const out: SiblingRef[] = [];
  for (const [key, e] of source.entries) {
    if (out.length >= max) break;
    if (key === self || e.kind !== 'string' || e.path.length !== path.length) continue;
    if (!parent.every((seg, i) => e.path[i] === seg)) continue;
    const t = target.entries.get(key);
    out.push(t !== undefined && t.kind === 'string' ? { path: e.path, source: e.value as string, target: t.value as string } : { path: e.path, source: e.value as string });
  }
  return out;
}
