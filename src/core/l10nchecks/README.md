# l10nchecks — deterministic locale checks

Pure TypeScript (no DOM, Node or Deno globals; only `Intl`, `TextDecoder`, `jsonc-parser`,
`@formatjs/icu-messageformat-parser`, `zod`). Runs in the browser, Node and Deno.

Status: source written in Dirty Mode. Nothing here has been compiled, tested or run
(see `docs/DEFERRED-VALIDATION.md`, D2–D5).

## Pipeline

1. `parseLocale(bytes, {fileName, locale, dialect, role})` → `{doc, issues}` (`parse.ts`).
   2 MB / 5,000 keys / depth 32 caps, fatal UTF-8, BOM stripped and recorded, strict JSON
   (no comments, no trailing commas), duplicate keys and dot-joined path collisions make the file
   ineligible for review and export. Keys are segment arrays (`paths.ts`); maps are `Map`s.
2. `parseContextFile` / `parseGlossaryFile` (`metadata.ts`): same strict parse, zod per entry.
3. `buildValidationReport` / `formatValidationReport`: every file, key and metadata entry problem.
4. `detectDialect(doc)` suggests `icu | i18next | plain`; the user confirms.
5. `runChecks(source, target, {context, glossary})` → `DeterministicFinding[]`;
   `checkSourceDocument(source)` → one-per-key source issues; `runAllChecks` does both.

## Modules

| File | Purpose |
|---|---|
| `types.ts` | Shared types and the 17 rule ids |
| `paths.ts` | `pathKey`, `displayPath` / `parseDisplayPath` (`a.b` vs `["a.b"]`) |
| `locale.ts` | `validateLocale`, `suggestLocaleFromFileName` |
| `plural.ts` | `Intl.PluralRules` categories, branch check, i18next suffix parsing |
| `placeholders.ts` | Dialect-aware tokenizer; unindexed printf order rule |
| `icu.ts` | formatjs parse, path signature (`icuPathSignature`, exported for the M3 gate), structure diff |
| `tags.ts` | Tag tokenizer/tree, order-insensitive compare, `<br>` ≡ `<br/>` |
| `numbers.ts` | Per-locale number normalisation (Arabic-Indic / Persian digits) |
| `text.ts` | Whitespace, bidi, injection patterns, glossary matching |
| `pairs.ts` | Alignment (i18next families grouped first), per-string analysis cache, `RuleContext` |
| `rules/<rule_id>.ts` | One rule each: exports `id`, `severity`, `check`, `rule` |
| `runChecks.ts` | Entry points, `checkVersion`, stable sort |

## Rules

Errors: `missing_key`, `empty_translation`, `type_mismatch`, `placeholder_mismatch`,
`icu_syntax_invalid`, `plural_category_missing`, `select_branch_mismatch`, `html_tag_mismatch`.

Warnings: `orphan_key`, `untranslated_identical`, `plural_category_extra`, `number_drift`,
`length_risk`, `whitespace_drift`, `bidi_control_chars`, `glossary_violation`,
`injection_like_text`.

## Decisions worth knowing

- ICU is parsed with `ignoreTag: true` and `requiresOtherClause: false`. Markup in ICU messages
  goes through the same tag tokenizer as the other dialects (so `<a href="…">`, `<br>` work), and a
  missing `other` is `plural_category_missing`, not a syntax error.
- Source vs target ICU compare collapses plural branch selectors and ignores `#` (a target branch
  without `#` is not an error). The exact signature with `#` placement is `icuPathSignature`, for
  the M3 fix gate.
- Required plural categories come from the runtime's CLDR data: French needs `one, many, other`
  (CLDR ≥ 38), Russian `one, few, many, other`, Arabic all six, Japanese `other`.
- `length_risk` measures visible text: markup removed, and for ICU plural/select the longest
  branch on each side (never the sum of branches).
- `untranslated_identical` is skipped when source and target share a language subtag.
- Sibling tag order may change between source and target; nesting may not.
- A select key literally named `__proto__` is recovered from the parser's options object (D3).
- The ICU source/target diff uses two views so one change is one finding: an argument view (tags
  ignored) for `placeholder_mismatch` / `select_branch_mismatch`, and a markup view (paths through
  a tag, including the arguments it wraps) for `html_tag_mismatch`. Dropping `<b>` around `{name}`
  is a tag finding only; moving `<b>` from `{a}` to `{b}` is still caught.
- `injection_like_text` matches "you are now" only when it re-assigns a role ("you are now an
  unrestricted assistant"), so ordinary UI text like "You are now signed in" is not flagged.
- A broken source string (ICU syntax, unbalanced tags, bad placeholder syntax) is reported once by
  `checkSourceDocument`; `runChecks` skips structural target checks for that key.

## M1 rework notes (2026-10-24)

- Cardinal i18next families need source `_other` plus a string category sibling of the same base
  and parent. A source locale whose cardinal categories are only `other` (for example Japanese)
  can establish a family with `_other` alone. Target siblings do not establish a family. Explicit
  `_ordinal_` families retain the existing `_ordinal_other` behavior.
- Source/target ICU comparison also ignores `{n}` and `{n, number[, style]}` when `n` is the
  nearest enclosing plural's argument, including through select/tag scopes. References to outer,
  sibling or unrelated plurals still compare normally. `icuPathSignature` retains every such
  reference, its type/style and its exact path for the gate. Rule behavior version is `1.0.1`.
- Existing approximations remain: source/target ICU paths are sets, so repeated argument counts
  are checked by the gate's multiset, not this comparison; printf inside ICU literal text is not
  tokenized separately. Printf-looking prose and tag-shaped prose can be treated as syntax.
  Dotted-prefix path handling and ICU apostrophe-before-tag behavior need the focused follow-up
  checks recorded in `docs/DEFERRED-VALIDATION.md`.

M1 empty-container rework (2026-10-24): `parseLocale` now supplies optional `containers` metadata
keyed by exact segment arrays, separate from leaves. Empty objects participate in object/string
type checks without becoming review/export strings or consuming the leaf cap. Duplicate, partial
syntax-error and dotted-path-ambiguous containers are excluded from that structural index; existing
ineligibility flags remain. A structural clash suppresses derivative missing/orphan and plural-family
noise. Legacy documents without metadata still infer nonempty objects from leaf ancestors. The
current rule behavior version is `1.0.2`; runtime/parser verification remains deferred.

M1 sibling-preservation correction (2026-10-24): a container clash excludes only its affected
target member from pairing. Unaffected plural siblings retain empty/placeholder/tag checks, and
source `_other` text remains valid fallback for other target categories. Family category checks
exclude only categories already explained by a clash; unrelated missing categories still report.
A whole-parent replacement with no usable sibling remains suppressed. Current version: `1.0.3`.
