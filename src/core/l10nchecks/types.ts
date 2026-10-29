// Shared types for the deterministic locale checks (PLAN §3.1, §3.2).
// Pure TypeScript: no DOM, Node or Deno globals anywhere under src/core.

/** Message syntax a locale file uses. Confirmed by the user (or pinned by a manifest) before checks run. */
export type Dialect = 'icu' | 'i18next' | 'plain';

export type FileRole = 'source' | 'target';

/**
 * Canonical map key for a key path: `JSON.stringify(segments)`.
 * Segment arrays keep `a.b` (one segment) and `a` → `b` (two segments) distinct.
 */
export type PathKey = string & { readonly __pathKeyBrand: true };

/** JSON value type of a leaf. Objects are never leaves (they are walked), arrays always are. */
export type JsonValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface Entry {
  /** Key path segments, root first. `__proto__` is ordinary data. */
  readonly path: readonly string[];
  /** Decoded leaf value. Strings for `kind: 'string'`; a null-prototype copy for arrays. */
  readonly value: unknown;
  readonly kind: 'string' | 'other';
  readonly valueType: JsonValueType;
  /** Offset of the value node in `LocaleDocument.text` (UTF-16 code units, BOM already stripped). */
  readonly offset: number;
  /** Length of the value node in `LocaleDocument.text` (including quotes for strings). */
  readonly length: number;
}

export interface LocaleDocument {
  readonly fileName: string;
  /** Canonical BCP-47 tag (as returned by `Intl.getCanonicalLocales`), or the raw tag when rejected. */
  readonly locale: string;
  readonly dialect: Dialect;
  readonly role: FileRole;
  /** Decoded text with any leading BOM removed. Entry offsets refer to this text. */
  readonly text: string;
  /** True when a UTF-8 BOM was present and stripped (export must re-add it). */
  readonly bom: boolean;
  /** Leaves keyed by `pathKey(path)`. Always a `Map`, never a plain object. */
  readonly entries: ReadonlyMap<PathKey, Entry>;
  /**
   * Usable non-root object paths, including empty objects, separate from translatable leaves.
   * Keyed by `pathKey(path)`; duplicate/syntax/path-ambiguous containers are excluded.
   * Optional for callers constructing legacy documents; `parseLocale` always supplies it.
   */
  readonly containers?: ReadonlyMap<PathKey, readonly string[]>;
  /**
   * `review` / `export` are false whenever the file has duplicate keys, conflicting paths,
   * JSON syntax errors or any fatal import error. Diagnostics still run on unambiguous entries.
   */
  readonly eligible: { readonly review: boolean; readonly export: boolean };
  /** Fatal import error (size, UTF-8, depth, key cap, root type, locale): `entries` is empty. */
  readonly rejected: boolean;
}

export type ImportIssueCode =
  | 'file_too_large'
  | 'invalid_utf8'
  | 'bom_stripped'
  | 'json_syntax'
  | 'not_an_object'
  | 'too_deep'
  | 'too_many_keys'
  | 'duplicate_key'
  | 'path_conflict'
  | 'non_string_leaf'
  | 'invalid_locale'
  | 'unsupported_locale'
  | 'metadata_invalid_entry'
  | 'metadata_invalid_path'
  | 'metadata_too_many_entries'
  | 'metadata_not_an_object'
  | 'metadata_not_an_array';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ImportIssue {
  readonly code: ImportIssueCode;
  readonly severity: IssueSeverity;
  readonly fileName: string;
  /** Key path the issue is about, when there is one. */
  readonly path?: readonly string[];
  /** Offset into the decoded text, when known. */
  readonly offset?: number;
  readonly message: string;
}

export const ERROR_RULE_IDS = [
  'missing_key',
  'empty_translation',
  'type_mismatch',
  'placeholder_mismatch',
  'icu_syntax_invalid',
  'plural_category_missing',
  'select_branch_mismatch',
  'html_tag_mismatch',
] as const;

export const WARNING_RULE_IDS = [
  'orphan_key',
  'untranslated_identical',
  'plural_category_extra',
  'number_drift',
  'length_risk',
  'whitespace_drift',
  'bidi_control_chars',
  'glossary_violation',
  'injection_like_text',
] as const;

export type ErrorRuleId = (typeof ERROR_RULE_IDS)[number];
export type WarningRuleId = (typeof WARNING_RULE_IDS)[number];
export type RuleId = ErrorRuleId | WarningRuleId;
export type Severity = 'error' | 'warning';

export interface DeterministicFinding {
  readonly ruleId: RuleId;
  readonly severity: Severity;
  /** Key path of the string the finding is about (target path, or source path for source issues). */
  readonly path: readonly string[];
  /** Locale of the file the finding is about. */
  readonly locale: string;
  /** `target` for normal findings; `source` for one-per-key source issues (see `checkSourceDocument`). */
  readonly subject: FileRole;
  readonly message: string;
  readonly evidence?: string;
}

/** One `context.json` entry (PLAN §1.1). */
export interface ContextEntry {
  readonly screen?: string;
  readonly note?: string;
  readonly description?: string;
  /** Maximum length in Unicode code points. Authoritative over the 1.6× ratio. */
  readonly maxLength?: number;
}

/** One `glossary.json` entry (PLAN §1.1). `translations` is a null-prototype record keyed by canonical locale. */
export interface GlossaryEntry {
  readonly term: string;
  readonly translations?: Readonly<Record<string, string>>;
  readonly doNotTranslate?: boolean;
  readonly note?: string;
}

export type ContextMap = ReadonlyMap<PathKey, ContextEntry>;

export interface CheckOptions {
  readonly context?: ContextMap;
  readonly glossary?: readonly GlossaryEntry[];
}

export type PluralType = 'cardinal' | 'ordinal';
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
