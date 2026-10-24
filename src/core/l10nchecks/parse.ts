// Strict locale-file import (PLAN §3.1).
//
//   bytes → size cap → fatal UTF-8 decode (BOM stripped + recorded) → bracket-depth pre-scan
//   → jsonc-parser parseTree {disallowComments, allowTrailingComma: false} → walk with
//   per-object duplicate detection → leaves keyed by path-segment arrays in a Map.
//
// Fatal problems (size, UTF-8, depth, key cap, root not an object, unknown locale) reject the file
// (no entries). Duplicate keys, dot-joined path collisions and JSON syntax errors keep the
// unambiguous entries for diagnostics but make the file ineligible for model review and export.

import { parseTree, printParseErrorCode } from 'jsonc-parser';
import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { validateLocale } from './locale.ts';
import { ancestorKeys, displayPath, pathKey } from './paths.ts';
import type {
  Dialect,
  Entry,
  FileRole,
  ImportIssue,
  ImportIssueCode,
  IssueSeverity,
  JsonValueType,
  LocaleDocument,
  PathKey,
} from './types.ts';

export interface Limits {
  /** Maximum file size in bytes (before decoding). */
  readonly maxBytes: number;
  /** Maximum number of leaves (locale files) or entries (metadata files). */
  readonly maxKeys: number;
  /** Maximum container nesting depth (the root object is depth 1). */
  readonly maxDepth: number;
}

export const DEFAULT_LIMITS: Limits = { maxBytes: 2 * 1024 * 1024, maxKeys: 5000, maxDepth: 32 };

function issue(
  code: ImportIssueCode,
  severity: IssueSeverity,
  fileName: string,
  message: string,
  extra: { path?: readonly string[]; offset?: number } = {},
): ImportIssue {
  return { code, severity, fileName, message, ...extra };
}

/** 1-based line/column for an offset, for messages. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let col = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else col++;
  }
  return { line, column: col };
}

/** Deepest `{`/`[` nesting outside strings. Linear, no recursion, so hostile input cannot blow the stack. */
export function maxBracketDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash: skip escaped char
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 125 || c === 93) depth = Math.max(0, depth - 1);
  }
  return max;
}

export interface StrictJsonResult {
  /** Decoded text without BOM ('' when decoding failed). */
  readonly text: string;
  readonly bom: boolean;
  /** Parse tree, or undefined when the file could not be parsed at all. */
  readonly root: JsonNode | undefined;
  readonly issues: ImportIssue[];
  /** A fatal issue was found: callers must not use `root`. */
  readonly fatal: boolean;
  /** JSON syntax errors were found (tree may be partial). */
  readonly syntaxErrors: boolean;
}

/** Shared strict decode + parse for locale files and metadata files. */
export function parseStrictJson(bytes: Uint8Array, fileName: string, limits: Limits = DEFAULT_LIMITS): StrictJsonResult {
  const issues: ImportIssue[] = [];
  const fail = (code: ImportIssueCode, message: string, offset?: number): StrictJsonResult => {
    issues.push(issue(code, 'error', fileName, message, offset === undefined ? {} : { offset }));
    return { text: '', bom: false, root: undefined, issues, fatal: true, syntaxErrors: false };
  };
  if (bytes.byteLength > limits.maxBytes) {
    return fail('file_too_large', `file is ${bytes.byteLength} bytes; the limit is ${limits.maxBytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('invalid_utf8', 'file is not valid UTF-8 (malformed byte sequence); re-save it as UTF-8');
  }
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    bom = true;
    issues.push(issue('bom_stripped', 'info', fileName, 'UTF-8 byte order mark stripped (recorded; export re-adds it)'));
  }
  const depth = maxBracketDepth(text);
  if (depth > limits.maxDepth) {
    issues.push(issue('too_deep', 'error', fileName, `nesting depth ${depth} exceeds the limit of ${limits.maxDepth}`));
    return { text, bom, root: undefined, issues, fatal: true, syntaxErrors: false };
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  for (const e of errors) {
    const { line, column } = lineColumn(text, e.offset);
    issues.push(
      issue('json_syntax', 'error', fileName, `JSON syntax error ${printParseErrorCode(e.error)} at line ${line}, column ${column}`, {
        offset: e.offset,
      }),
    );
  }
  if (root === undefined) {
    issues.push(issue('json_syntax', 'error', fileName, 'file contains no JSON value'));
    return { text, bom, root: undefined, issues, fatal: true, syntaxErrors: true };
  }
  return { text, bom, root, issues, fatal: false, syntaxErrors: errors.length > 0 };
}

/** Plain-data copy of a JSON node with null-prototype objects (`__proto__` stays ordinary data). */
export function safeNodeValue(node: JsonNode): unknown {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return node.value as unknown;
    case 'null':
      return null;
    case 'array':
      return (node.children ?? []).map(safeNodeValue);
    case 'object': {
      const out = Object.create(null) as Record<string, unknown>;
      for (const prop of node.children ?? []) {
        const k = prop.children?.[0];
        const v = prop.children?.[1];
        if (k?.type === 'string' && v) out[k.value as string] = safeNodeValue(v);
      }
      return out;
    }
    default:
      return undefined;
  }
}

export interface ObjectProperty {
  readonly key: string;
  readonly keyNode: JsonNode;
  readonly valueNode: JsonNode;
}

/**
 * Properties of an object node with duplicates separated out. Duplicate keys are ambiguous, so
 * every occurrence is returned in `duplicates` and none in `unique`.
 */
export function objectProperties(node: JsonNode): { unique: ObjectProperty[]; duplicates: ObjectProperty[] } {
  const all: ObjectProperty[] = [];
  const counts = new Map<string, number>();
  for (const prop of node.children ?? []) {
    const keyNode = prop.children?.[0];
    const valueNode = prop.children?.[1];
    if (prop.type !== 'property' || keyNode?.type !== 'string' || valueNode === undefined) continue;
    const key = keyNode.value as string;
    all.push({ key, keyNode, valueNode });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique: ObjectProperty[] = [];
  const duplicates: ObjectProperty[] = [];
  for (const p of all) ((counts.get(p.key) ?? 0) > 1 ? duplicates : unique).push(p);
  return { unique, duplicates };
}

function jsonType(node: JsonNode): JsonValueType {
  switch (node.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'array':
    case 'object':
      return node.type;
    default:
      return 'null';
  }
}

export interface ParseLocaleOptions {
  readonly fileName: string;
  /** User-confirmed (or manifest-pinned) BCP-47 locale. */
  readonly locale: string;
  /** User-confirmed (or manifest-pinned) dialect. */
  readonly dialect: Dialect;
  readonly role: FileRole;
  readonly limits?: Limits;
}

export interface ParseLocaleResult {
  readonly doc: LocaleDocument;
  readonly issues: readonly ImportIssue[];
}

export function parseLocale(bytes: Uint8Array, opts: ParseLocaleOptions): ParseLocaleResult {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const { fileName } = opts;
  const issues: ImportIssue[] = [];
  const rejectedDoc = (text: string, bom: boolean, locale: string): ParseLocaleResult => ({
    doc: {
      fileName,
      locale,
      dialect: opts.dialect,
      role: opts.role,
      text,
      bom,
      entries: new Map(),
      containers: new Map(),
      eligible: { review: false, export: false },
      rejected: true,
    },
    issues,
  });

  const loc = validateLocale(opts.locale);
  if (!loc.ok) issues.push(issue(loc.code, 'error', fileName, loc.message));
  const locale = loc.ok ? loc.canonical : opts.locale;

  const json = parseStrictJson(bytes, fileName, limits);
  issues.push(...json.issues);
  if (json.fatal || json.root === undefined || !loc.ok) return rejectedDoc(json.text, json.bom, locale);
  if (json.root.type !== 'object') {
    issues.push(issue('not_an_object', 'error', fileName, `top-level value is ${json.root.type}; a locale file must be a JSON object`));
    return rejectedDoc(json.text, json.bom, locale);
  }

  const entries = new Map<PathKey, Entry>();
  const containers = new Map<PathKey, readonly string[]>();
  let ambiguous = json.syntaxErrors;
  let tooMany = false;

  const walk = (node: JsonNode, path: readonly string[]): void => {
    const { unique, duplicates } = objectProperties(node);
    const reported = new Set<string>();
    for (const d of duplicates) {
      if (reported.has(d.key)) continue;
      reported.add(d.key);
      ambiguous = true;
      const p = [...path, d.key];
      issues.push(
        issue('duplicate_key', 'error', fileName, `duplicate key ${JSON.stringify(d.key)} at ${displayPath(p)}; all occurrences ignored`, {
          path: p,
          offset: d.keyNode.offset,
        }),
      );
    }
    for (const { key, valueNode } of unique) {
      if (tooMany) return;
      const p = [...path, key];
      if (valueNode.type === 'object') {
        containers.set(pathKey(p), p);
        walk(valueNode, p);
        continue;
      }
      if (entries.size >= limits.maxKeys) {
        tooMany = true;
        return;
      }
      const valueType = jsonType(valueNode);
      const isString = valueNode.type === 'string';
      entries.set(pathKey(p), {
        path: p,
        value: isString ? (valueNode.value as string) : safeNodeValue(valueNode),
        kind: isString ? 'string' : 'other',
        valueType,
        offset: valueNode.offset,
        length: valueNode.length,
      });
      if (!isString && opts.role === 'source') {
        issues.push(
          issue('non_string_leaf', 'error', fileName, `source value at ${displayPath(p)} is ${valueType}, not a string; key skipped`, {
            path: p,
            offset: valueNode.offset,
          }),
        );
      }
    }
  };
  walk(json.root, []);

  if (tooMany) {
    issues.push(issue('too_many_keys', 'error', fileName, `more than ${limits.maxKeys} keys; the file is rejected`));
    return rejectedDoc(json.text, json.bom, locale);
  }

  // Distinct segment paths that dot-join to the same string (`["a.b"]` vs `["a","b"]`) are kept
  // apart here, but any runtime that splits keys on '.' cannot tell them apart.
  const joined = new Map<string, Array<readonly string[]>>();
  for (const p of [...entries.values()].map((e) => e.path).concat([...containers.values()])) {
    const j = p.join('.');
    const list = joined.get(j);
    if (list) list.push(p);
    else joined.set(j, [p]);
  }
  const ambiguousPrefixes = new Set<PathKey>();
  for (const [j, list] of joined) {
    if (list.length < 2) continue;
    ambiguous = true;
    for (const p of list) ambiguousPrefixes.add(pathKey(p));
    issues.push(
      issue(
        'path_conflict',
        'error',
        fileName,
        `paths ${list.map((p) => displayPath(p)).join(' and ')} both read as "${j}" when keys are split on "."`,
        { path: list[0] ?? [] },
      ),
    );
  }
  for (const [key, p] of containers) {
    if (ambiguousPrefixes.has(key) || ancestorKeys(p).some((a) => ambiguousPrefixes.has(a))) containers.delete(key);
  }

  return {
    doc: {
      fileName,
      locale,
      dialect: opts.dialect,
      role: opts.role,
      text: json.text,
      bom: json.bom,
      entries,
      // A partial syntax-error tree must not establish object/string structural evidence.
      containers: json.syntaxErrors ? new Map() : containers,
      eligible: { review: !ambiguous, export: !ambiguous },
      rejected: false,
    },
    issues,
  };
}

// --- validation report (PLAN §1.1: names every unparseable file / key / metadata entry) ---

export type FileStatus = 'ok' | 'warnings' | 'ineligible' | 'rejected';

export interface FileReportInput {
  readonly fileName: string;
  readonly kind: 'locale' | 'context' | 'glossary';
  readonly locale?: string;
  readonly role?: FileRole;
  readonly issues: readonly ImportIssue[];
  readonly rejected: boolean;
  /** For locale files: false when review/export were disabled. */
  readonly eligible?: boolean;
}

export interface FileReport extends FileReportInput {
  readonly status: FileStatus;
}

export interface ValidationReport {
  readonly files: readonly FileReport[];
  readonly errorCount: number;
  readonly warningCount: number;
}

export function buildValidationReport(inputs: readonly FileReportInput[]): ValidationReport {
  let errorCount = 0;
  let warningCount = 0;
  const files = inputs.map((f): FileReport => {
    const errors = f.issues.filter((i) => i.severity === 'error').length;
    const warnings = f.issues.filter((i) => i.severity === 'warning').length;
    errorCount += errors;
    warningCount += warnings;
    const status: FileStatus = f.rejected
      ? 'rejected'
      : f.eligible === false
        ? 'ineligible'
        : errors > 0 || warnings > 0
          ? 'warnings'
          : 'ok';
    return { ...f, status };
  });
  return { files, errorCount, warningCount };
}

const STATUS_TEXT: Record<FileStatus, string> = {
  ok: 'OK',
  warnings: 'imported with issues',
  ineligible: 'INELIGIBLE — model review and patched export disabled',
  rejected: 'REJECTED — not imported',
};

/** Plain-text report: one header per file, then every issue with its key path. */
export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];
  for (const f of report.files) {
    const label = [f.kind, f.role, f.locale].filter((x) => x !== undefined).join(', ');
    lines.push(`${f.fileName} (${label}): ${STATUS_TEXT[f.status]}`);
    for (const i of f.issues) {
      const where = i.path !== undefined ? ` [${displayPath(i.path)}]` : '';
      lines.push(`  ${i.severity} ${i.code}${where}: ${i.message}`);
    }
  }
  lines.push(`${report.errorCount} error(s), ${report.warningCount} warning(s)`);
  return lines.join('\n');
}
