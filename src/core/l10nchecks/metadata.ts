// Optional metadata files (PLAN §1.1): `context.json` and `glossary.json`.
// Same strict decode/parse path as locale files; caps 2 MB / 5,000 entries / depth 32; every string
// field ≤ 2,000 chars; each entry validated with zod. A bad entry is reported by name and dropped;
// the rest of the file still loads.

import { z } from 'zod';
import type { Node as JsonNode } from 'jsonc-parser';
import { validateLocale } from './locale.ts';
import { DEFAULT_LIMITS, objectProperties, parseStrictJson, safeNodeValue } from './parse.ts';
import type { Limits } from './parse.ts';
import { displayPath, parseDisplayPath, pathKey } from './paths.ts';
import type { ContextEntry, ContextMap, GlossaryEntry, ImportIssue, ImportIssueCode, IssueSeverity, PathKey } from './types.ts';

export const MAX_FIELD_CHARS = 2000;

const field = z.string().max(MAX_FIELD_CHARS, `must be at most ${MAX_FIELD_CHARS} characters`);

export const contextEntrySchema = z.object({
  screen: field.optional(),
  note: field.optional(),
  description: field.optional(),
  maxLength: z.number().int().positive().max(100_000).optional(),
});

export const glossaryEntrySchema = z.object({
  term: z.string().min(1).max(MAX_FIELD_CHARS),
  translations: z.record(z.string(), field).optional(),
  doNotTranslate: z.boolean().optional(),
  note: field.optional(),
});

function mk(code: ImportIssueCode, severity: IssueSeverity, fileName: string, message: string, path?: readonly string[]): ImportIssue {
  return path === undefined ? { code, severity, fileName, message } : { code, severity, fileName, message, path };
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ');
}

/** Duplicate property names anywhere under `node` (strict JSON for metadata too). */
function duplicateKeysUnder(node: JsonNode): string[] {
  const out: string[] = [];
  const visit = (n: JsonNode): void => {
    if (n.type === 'object') {
      const { unique, duplicates } = objectProperties(n);
      for (const d of duplicates) if (!out.includes(d.key)) out.push(d.key);
      for (const u of unique) visit(u.valueNode);
    } else if (n.type === 'array') {
      for (const c of n.children ?? []) visit(c);
    }
  };
  visit(node);
  return out;
}

/** Copy only the schema's fields from a validated entry into a fresh object (no prototype tricks). */
function pickContext(v: z.infer<typeof contextEntrySchema>): ContextEntry {
  const out: { screen?: string; note?: string; description?: string; maxLength?: number } = {};
  if (v.screen !== undefined) out.screen = v.screen;
  if (v.note !== undefined) out.note = v.note;
  if (v.description !== undefined) out.description = v.description;
  if (v.maxLength !== undefined) out.maxLength = v.maxLength;
  return out;
}

export interface ContextParseResult {
  readonly context: ContextMap;
  readonly issues: readonly ImportIssue[];
  readonly rejected: boolean;
}

/** `context.json`: `{ "<display key path>": {screen?, note?, description?, maxLength?} }`. */
export function parseContextFile(bytes: Uint8Array, fileName: string, limits: Limits = DEFAULT_LIMITS): ContextParseResult {
  const json = parseStrictJson(bytes, fileName, limits);
  const issues: ImportIssue[] = [...json.issues];
  const context = new Map<PathKey, ContextEntry>();
  if (json.fatal || json.root === undefined) return { context, issues, rejected: true };
  if (json.root.type !== 'object') {
    issues.push(mk('metadata_not_an_object', 'error', fileName, 'context file must be a JSON object keyed by key path'));
    return { context, issues, rejected: true };
  }
  const { unique, duplicates } = objectProperties(json.root);
  if (unique.length + duplicates.length > limits.maxKeys) {
    issues.push(mk('metadata_too_many_entries', 'error', fileName, `more than ${limits.maxKeys} entries; the file is rejected`));
    return { context, issues, rejected: true };
  }
  const seenDup = new Set<string>();
  for (const d of duplicates) {
    if (seenDup.has(d.key)) continue;
    seenDup.add(d.key);
    issues.push(mk('duplicate_key', 'error', fileName, `duplicate context entry ${JSON.stringify(d.key)}; all occurrences ignored`));
  }
  for (const { key, valueNode } of unique) {
    const path = parseDisplayPath(key);
    if (path === null) {
      issues.push(mk('metadata_invalid_path', 'error', fileName, `${JSON.stringify(key)} is not a key path (use a.b.c or a JSON array of segments)`));
      continue;
    }
    const dups = duplicateKeysUnder(valueNode);
    if (dups.length > 0) {
      issues.push(mk('duplicate_key', 'error', fileName, `context entry ${displayPath(path)} repeats field(s) ${dups.join(', ')}; entry ignored`, path));
      continue;
    }
    const parsed = contextEntrySchema.safeParse(safeNodeValue(valueNode));
    if (!parsed.success) {
      issues.push(mk('metadata_invalid_entry', 'error', fileName, `context entry ${displayPath(path)}: ${zodMessage(parsed.error)}`, path));
      continue;
    }
    context.set(pathKey(path), pickContext(parsed.data));
  }
  return { context, issues, rejected: false };
}

export interface GlossaryParseResult {
  readonly glossary: readonly GlossaryEntry[];
  readonly issues: readonly ImportIssue[];
  readonly rejected: boolean;
}

/** `glossary.json`: `[{term, translations?: {locale: string}, doNotTranslate?, note?}]`. */
export function parseGlossaryFile(bytes: Uint8Array, fileName: string, limits: Limits = DEFAULT_LIMITS): GlossaryParseResult {
  const json = parseStrictJson(bytes, fileName, limits);
  const issues: ImportIssue[] = [...json.issues];
  const glossary: GlossaryEntry[] = [];
  if (json.fatal || json.root === undefined) return { glossary, issues, rejected: true };
  if (json.root.type !== 'array') {
    issues.push(mk('metadata_not_an_array', 'error', fileName, 'glossary file must be a JSON array of entries'));
    return { glossary, issues, rejected: true };
  }
  const items = json.root.children ?? [];
  if (items.length > limits.maxKeys) {
    issues.push(mk('metadata_too_many_entries', 'error', fileName, `more than ${limits.maxKeys} entries; the file is rejected`));
    return { glossary, issues, rejected: true };
  }
  items.forEach((node, index) => {
    const label = `glossary entry #${index + 1}`;
    const dups = duplicateKeysUnder(node);
    if (dups.length > 0) {
      issues.push(mk('duplicate_key', 'error', fileName, `${label} repeats field(s) ${dups.join(', ')}; entry ignored`));
      return;
    }
    const raw = safeNodeValue(node);
    const parsed = glossaryEntrySchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(mk('metadata_invalid_entry', 'error', fileName, `${label}: ${zodMessage(parsed.error)}`));
      return;
    }
    const entry: { term: string; translations?: Record<string, string>; doNotTranslate?: boolean; note?: string } = {
      term: parsed.data.term,
    };
    if (parsed.data.doNotTranslate !== undefined) entry.doNotTranslate = parsed.data.doNotTranslate;
    if (parsed.data.note !== undefined) entry.note = parsed.data.note;
    // Build translations from the null-prototype raw value, keyed by canonical locale.
    const rawTranslations = (raw as Record<string, unknown>)['translations'];
    if (rawTranslations !== undefined && rawTranslations !== null && typeof rawTranslations === 'object') {
      const translations = Object.create(null) as Record<string, string>;
      for (const loc of Object.keys(rawTranslations)) {
        const value = (rawTranslations as Record<string, unknown>)[loc];
        const v = validateLocale(loc);
        if (!v.ok) {
          issues.push(mk('metadata_invalid_entry', 'warning', fileName, `${label} ("${parsed.data.term}"): translation locale ignored — ${v.message}`));
          continue;
        }
        if (typeof value === 'string') translations[v.canonical] = value;
      }
      entry.translations = translations;
    }
    glossary.push(entry);
  });
  return { glossary, issues, rejected: false };
}
