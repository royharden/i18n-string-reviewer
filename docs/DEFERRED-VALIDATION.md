# Deferred validation (Dirty Mode)

This repository was constructed under Dirty Mode: **static checks only**. Nothing below has been
done. Each item says what must be validated, why it was deferred and the exact command or steps.
Later milestones append detail under the relevant item (append, never rewrite history).

Static checks that WERE run during construction: `node scripts/syntax-check.mjs .` (Node 24
`stripTypeScriptTypes` + `node --check`; parses `.ts` only, no type-check, no import resolution,
`.tsx` not covered — `.tsx` files got source inspection only), `node --check eslint.config.js`,
`JSON.parse` of JSON config files.

| ID | What | Why deferred | Command / steps |
|---|---|---|---|
| D1 | Install dependencies; create the lockfile; confirm every exact pin in `package.json` exists | No installs in Dirty Mode | `npm install` (commit `package-lock.json`), then `npm ls --depth=0` |
| D2 | Type-check, lint, unit tests | No builds/test runs in Dirty Mode | `npm run typecheck && npm run typecheck:node && npm run lint && npm test` |
| D3 | `@formatjs/icu-messageformat-parser` behaviour | Parser never executed | Run `tests/l10nchecks/icu.test.ts` and `tests/traps/*.test.ts`; confirm the items listed under D3 below |
| D4 | `jsonc-parser` strictness and `applyEdits` byte identity | Parser never executed | Run `tests/l10nchecks/parse.test.ts` (M1) and `tests/export/patch.test.ts` (M3) |
| D5 | `Intl.PluralRules` / `Intl.NumberFormat` data in Node, Chromium and Firefox | Runtimes never exercised | Run `tests/l10nchecks/plural.test.ts` and `numbers.test.ts` in Node; in each browser console run `new Intl.PluralRules('fr').resolvedOptions().pluralCategories` (expect `one, many, other`), same for `ru`, `ar`, `ja`, and `{type:'ordinal'}` for `en`, `fr` |
| D6 | npm licences of all dependencies | Needs installed tree | After D1: `npx license-checker --production --summary`; confirm no GPL/AGPL/FSL in runtime deps |
| D7 | SQL migrations + RPCs, concurrency | No databases in Dirty Mode | Apply both migrations to a fresh Supabase project; run `supabase/tests/budget_concurrency.sql`; run a separate parallel driver (N concurrent `reserve_budget` calls near the cap) — single-session SQL is not concurrency |
| D8 | Edge function `review-strings` | No Deno/Supabase runtime | `supabase functions serve review-strings`; check `_shared` resolution, `verify_jwt = true`, contract tests |
| D9 | Auth: email OTP, redirect URLs, allowed origins | Needs a live project | Configure OTP + site URL; sign in with an allowlisted and a non-allowlisted email; expect 200 / 403 |
| D10 | Anthropic adapter, estimator, `ANTHROPIC_MODEL_ID`, `prices.ts` | No paid calls | One capped live call through `scripts/eval.ts --live` with `EVAL_MAX_USD`; compare usage with the estimate; re-verify model id and prices on the vendor pages |
| D11 | TypeSafe Jev adapter (`jev-1.13.0`, endpoint, 64k limit, price) dated 2026-10-13 | No paid calls; vendor details may change | Re-read docs.typesafe.ai; one capped probe call; compare with the build-time defaults |
| D12 | Evaluation numbers | Eval never run | `npm run eval` (mock), then the live run under D10/D11 caps |
| D13 | Context ablation (llm context-off vs context-on) | Needs live runs | Part of the D12 live run; matched pairs, indicative only |
| D14 | UI manual pass | No dev server/browser | `npm run dev`: keyboard a/r/s/j/k, bidi glyphs, CSP in console (see D14 note), cancel between batches, downloads |
| D15 | Rulings `kind: 'l10n_finding'` compatibility with sibling apps (S2–S4) | Cross-app decision pending | Compare with sibling ruling schemas; adjust `kind` and bump `schemaVersion` if needed |
| D16 | Response cache stays gitignored | Cache never written | After an eval run: `git status --ignored` shows `.cache/` ignored, nothing under it staged |
| D17 | Node eval journal lock on Windows/OneDrive | Never run | Run two `npm run eval -- --live` processes concurrently in a OneDrive folder; second must refuse on `.cache/eval.lock`; check temp+rename on OneDrive |
| D18 | Bolt import, build and provisioning | Not import-ready before D1/D2 | After D1/D2 pass: import the repo in Bolt with "Inspect and prepare only", then provision backend per `BOLT-HANDOFF.md` |

## Detail

### D1 — exact pins (M1)

Versions were chosen from memory as versions known to exist; none was checked against the npm
registry: `react` 18.3.1, `react-dom` 18.3.1, `@supabase/supabase-js` 2.45.4, `zod` 3.23.8,
`jsonc-parser` 3.3.1, `@formatjs/icu-messageformat-parser` 2.7.8; dev: `typescript` 5.6.3,
`vite` 5.4.10, `@vitejs/plugin-react` 4.3.3, `vitest` 2.1.4, `jsdom` 25.0.1, `tsx` 4.19.2,
`eslint` 9.14.0, `@eslint/js` 9.14.0, `typescript-eslint` 8.13.0, `globals` 15.12.0,
`eslint-plugin-react-hooks` 5.0.0, `eslint-plugin-react-refresh` 0.4.14, `@types/node` 22.9.0,
`@types/react` 18.3.12, `@types/react-dom` 18.3.1. If one is missing, pick the nearest existing
patch of the same minor and record it here. Newer majors were not chosen deliberately: the code
was written against these APIs.

### D2 — type-check notes (M1)

- `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `allowImportingTsExtensions` (imports use `.ts` extensions so the same files run under Vite,
  tsx, Node type-stripping and Deno). Expect a first `tsc` run to surface a handful of
  strictness errors; fix them without loosening the flags.
- `tests/corpus/clean-zero-fp.test.ts` (M2) awaits `runChecks`, which is synchronous; `await`
  on a non-promise is valid.
- `src/core/shared/hash.ts` reads `globalThis.crypto`; if a script that imports it is checked
  with `tsconfig.node.json` (no DOM lib), confirm `@types/node` supplies the `Crypto` type.
- `.tsx` files (`src/main.tsx`, `src/App.tsx`) were not parsed by the syntax check at all.
- M1 tests were written to match the implementation by hand-tracing; expect a few expectation
  fixes on the first `vitest run` (most likely areas: jsonc-parser partial trees after syntax
  errors in `parse.test.ts`, formatjs error kinds in `icu.test.ts`, CLDR data in `plural.test.ts`).

### D3 — formatjs items to confirm (M1)

1. Exports used: `parse`, `isLiteralElement`, `isArgumentElement`, `isNumberElement`,
   `isDateElement`, `isTimeElement`, `isPluralElement`, `isSelectElement`, `isPoundElement`.
2. Options `ignoreTag: true`, `requiresOtherClause: false`, `captureLocation: true` are honoured.
3. Errors are thrown as `SyntaxError` whose `message` is the `ErrorKind` name and which carry
   `location.start.offset` (`parseIcu` falls back to kind `EXCEPTION`, offset 0 otherwise).
4. Apostrophe quoting: `d'{count}` yields a literal (no argument) — the French trap.
5. Number skeleton styles expose `tokens[{stem, options}]`; date skeletons expose `pattern`.
6. A select key `__proto__` — `optionEntries` recovers it from the options object's prototype.
7. Plural `offset` and `pluralType: 'ordinal'` for `selectordinal`.

### D5 — plural data note (M1)

Required categories come straight from the runtime. French needs `many` (CLDR ≥ 38); the M2
corpus already includes it. A runtime with older CLDR data would report different categories.

### D14 — CSP note (M1)

`index.html` sets `script-src 'self'; style-src 'self'`. Vite's dev server and
`@vitejs/plugin-react` inject an inline React-refresh preamble and inline styles in development;
check whether `npm run dev` works under this policy and, if not, relax it for development only.
Production builds emit external files only. When live mode is configured, add the Supabase
project URL to `connect-src`.

### M1 blocker rework — 2026-10-24

Written regression sources (not executed): `tests/l10nchecks/pairs.test.ts` covers lone cardinal
`_other` labels, target-only siblings, sibling scope/type/string restrictions, English-to-Japanese
and Japanese-to-English families, and explicit ordinal families. `tests/l10nchecks/icu.test.ts`
and `tests/traps/plurals.test.ts` cover self argument/number references in both comparison
directions, nearest nested plural ownership, unrelated arguments, and strict signature retention.
After Dirty Mode closes, run D1, then D2; in D3 confirm the nested select/tag AST behavior, and in
D5 confirm the source locale's cardinal category data. These cases have only been source-inspected
and syntax-parsed during construction; no test, parser dependency or application code was run.

The prior review's nonblocking limitations remain deferred: dotted-prefix path ambiguity,
printf-looking prose, printf within ICU literals, tag-shaped prose, repeated argument counts in
the source/target set comparison, and apostrophe-before-tag parsing. Add focused examples under
D2–D4 before deciding whether these need rule changes; do not infer support from syntax parsing.

Rework author: 0584_Codex_GPT-61Sol_Sub_S34-M1-Coder.

### M1 empty-container rework — 2026-10-24

`LocaleDocument.containers` is optional metadata; parser-produced documents always supply the
segment-keyed map. Export/review consumers still use unchanged leaf entries and value offsets.
Written regressions in `tests/l10nchecks/parse.test.ts` and `tests/traps/containers.test.ts` cover
empty-object clashes in both directions, nesting, equal empties, literal dotted paths, duplicate /
syntax / dotted-container ambiguity, unchanged leaf caps and offsets, ordinary alignment, and
suppression of derivative family findings at structural clashes. Rule behavior is now `1.0.2`.
Only source inspection and type-strip syntax parsing were performed; run these sources under
D2/D4 after D1 when Dirty Mode closes. No app, tests or parser imports were executed.

Rework author: 0584_Codex_GPT-61Sol_Sub_S34-M1-Coder.

### M1 sibling-preservation correction — 2026-10-24

The family-wide suppression introduced in the empty-container rework was too broad. It is now
limited to affected target members and directly clashing categories. Written full-run sources in
`tests/traps/containers.test.ts` cover sibling empty/renamed-placeholder/tag errors, independently
missing Russian categories, empty/nonempty source-container clashes, source-other fallback, and
the retained whole-parent case. `checkVersion` is `1.0.3`. Source inspection and syntax parsing
only; D2 after D1 must exercise these sources. No application/test/parser imports were executed.

Rework author: 0584_Codex_GPT-61Sol_Sub_S34-M1-Coder.

## M3 construction — checks still deferred

The mock review/gate/export/UI source and regression sources are being completed under Dirty Mode; none has executed. After D1, use `npm test -- tests/maskgate tests/cited tests/context tests/rulings tests/export tests/pipeline` and `npm run demo`, then `npm run typecheck && npm run typecheck:node && npm run lint && npm run build`. Check every recorded reply and regenerated proposal through the invariant suite; verify only approved/current suggestions patch original value ranges and bad imports cannot export.

TSX receives focused source inspection only in this run (PLAN common-check policy); no JSX parser/compiler has been installed or invoked. D2 must validate React/Vite imports, types and JSX; D14 must exercise uploads/confirmed dialects, same-dialect enforcement, demo sets and broken files, evidence/diffs, a/r/s/j/k input guards, bidi display-only mapping, rulings JSONL errors/replay/invalidation/competing approval selection and findings/rulings/patched downloads. Start no browser/server during Dirty Mode.

### M3 demo branch-attack rework — 2026-10-24

The manifest-served ICU reply file now binds the cross-branch token move to French `task.overdue`
and an added plural branch to French `search.results`, separate existing demo/dev keys with
supported masked-target evidence. Synthetic standalone cases remain in the all-reply invariant
suite. The written full-pipeline regression in `tests/pipeline/demo-snapshot.test.ts` loads the
manifest's actual files through `createMockReviewer` and `runPipeline`, then asserts the supported
findings have no suggestion, both rejection reasons (`token_moved_branch`, `structure_changed`)
are exposed, counters reach the CLI summary and invariant violations are empty.

These assertions have not executed. After D1 and Dirty Mode closure, run
`npm test -- tests/pipeline/demo-snapshot.test.ts tests/maskgate/invariant.test.ts`, then
`npm run demo`; under D14, Load demo → Review strings must display both attacks in Gate rejections.
Runtime dependency/parser behavior and UI execution remain unverified; only source inspection,
JSON parsing and TypeScript syntax parsing are authorized in this rework.

Rework author: 0685_Codex_GPT-61Sol_Sub_S34-M3-Rework (GPT-6.1 Sol, xhigh).

## M4 construction — activation boundary

Source work adds accounting/provider/function and authenticated preview/UI integrations; all behavior remains unexecuted. After D1/D2, run the written handler/drift/callledger regression sources, then follow D7–D11 on an explicitly authorized isolated backend. Confirm `reserve_budget` created=false for duplicate attempts (including in-flight reserved), no second provider dispatch/reconcile, daily concurrency limits, own-day midnight settlement and overrun fault. Verify preview auth/allowlist/redaction and that preview never creates an admin/budget/provider operation; stale estimate hash must fail before reservation.

D14 must confirm the configured backend origin survives the CSP transformation in a production build, development-only CSP exceptions remain development-only, OTP/session/signout work, transfer notice precedes preview, fresh paid confirmation binds actual prepared scope/hash, edits never auto-trigger paid review, cancellation/error returns usable partial results, and old rulings become invalid after text changes. No build/browser is run in Dirty Mode.

D17 lock recovery: exclusive `eval.lock` is never automatically removed on suspicion of staleness. After a crash, an operator first verifies no live owner exists, then performs explicit recovery before resuming; acquired-session journal recovery marks prior reserved rows unknown and charges them in full. Node maxUsd is cumulative for the persistent journal across midnight; a deliberately chosen fresh cacheDir denotes a separate run. Validate Windows/OneDrive atomic rename and concurrent-session refusal after activation.

### M4 exact accounting validation commands (not run)

On an explicitly authorized fresh disposable database, apply the two migrations in order, then run `psql --no-psqlrc --set ON_ERROR_STOP=1 --file supabase/tests/budget_concurrency.sql` as the appropriate database owner. The single-session scenario fixtures roll back and do not prove concurrency. On a separate fresh disposable target, set `BUDGET_TEST_DATABASE_URL` without committing its value, then run `node supabase/tests/budget_concurrency.mjs --disposable`; this driver commits synthetic fixtures, deletes nothing and coordinates twenty independent connections. Verify near-cap behavior, duplicate ownership and single-refund settlement. Neither SQL nor driver has executed. After D1, run `npm test -- tests/callledger/budget.test.ts`; validate Windows/OneDrive rename/fsync/wx lock behavior separately.
