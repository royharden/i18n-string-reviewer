# Limitations and measurement boundaries

## Construction is not runtime validation

This app was constructed in Dirty Mode using source inspection and syntax parsing only. All mandatory source milestones passed separate static subagent reviews. No dependencies, lockfile, JSX compilation, tests, build, browser journey, database, edge deployment or provider call has been validated. The test and evaluation sources are not passing execution receipts. Follow [DEFERRED-VALIDATION.md](DEFERRED-VALIDATION.md), D1/D2 first; the repo is not import-ready until that boundary is addressed.

## What the table proves

What the table proves: structural recall shows the rules fire on known mutation shapes, not that they cover real-world files; the semantic table is on agent-written translations by a possibly related model family, so absolute recall is not comparable to human-labelled data. The `android-l10n` slice (open question 3) is the mitigation.

TaskBoard translations, semantic errors and structural mutation shapes are synthetic and agent-authored. The source-key partition was selected before reviewer/prompt/threshold results existed, with key-placement and held-out label-count criteria disclosed in `fixtures/manifest.json`; it is not a blind random draw. Terminology labels can also trigger the deterministic glossary rule. Coverage of seeded shapes is not coverage of arbitrary locale files.

There are no measured results or generated failure lists yet. Future dev unplanted findings go to adjudication; held-out unplanted findings count as false positives. Report sample sizes, nullable zero-denominator metrics and Wilson intervals. The small matched context subset supports an indicative comparison only. Mock rows describe replay/gate behavior, never model accuracy. Fix quality has no automatic gold score; sample proposed fixes for human reading rather than inventing quality numbers.

## Experimental methods and scope cuts

The local heuristic is a limited non-model semantic floor, not a structural competitor or a translation-quality oracle. It sees trusted local policies plus masked item identity and can miss meaning errors. LLM context-off/on source paths are required; their quality and cost remain unmeasured.

Jev and cascade contracts are experimental and disabled by default. Thresholds, recall floor and injection tolerance in `config/thresholds.json` are proposed placeholders, not tuned results. Synthetic probability fixtures check code composition only. Actual multilingual dev probes, injection robustness and the held-out recall/cost inclusion rule remain pending. Do not enable a locale or promote a default merely because fixture tests later pass. Unavailable live experimental evaluation rows must be explicitly N/A with a reason.

M7 tier-B SARIF export and the localecheck CLI are cut. The optional i18n-check comparator is cut. Live Jev/cascade evaluation rows and automated dev-probe execution are also cut under the plan scope line; reviewer/provider contracts and synthetic composition fixtures are present, but the evaluation CLI intentionally does not dispatch them. Their rows remain N/A with a reason. PO/gettext, XLIFF/ARB/Fluent/platform formats, translation generation, PR bots, unused-key scans, learned QE, translation memory and visual overflow/RTL layout checks are outside this MVP.

## Parser and workflow boundaries

One comparison requires distinct target filenames and a common explicitly confirmed dialect. Empty-container/type alignment and ICU comparison have focused regression sources, but formatjs/jsonc-parser behavior and runtime CLDR plural data remain D3–D5 validation. Known approximations include dotted-prefix ambiguity, printf-shaped prose, printf inside ICU literals, tag-shaped prose and repeated ICU arguments in source/target comparison. The stricter fix gate preserves the current target's structural multiset even where the cross-language diagnostic comparison is more permissive.

Nested plural/select, any redacted model-visible field, empty sources and unsupported/ambiguous evidence deliberately do not receive fixes. The app is review-only: decisions bind current text and exact suggestions, patches are download-only, and original files are not overwritten. Regex redaction is pattern-based; live transfer notice and explicit confirmation remain required. Bidi glyphs are a display aid, not an RTL layout check.

## Infrastructure and accounting assumptions

The Bolt inventory is source-only and no target is provisioned. Auth/allowlist/RLS/budget behavior must be exercised on an authorized isolated target. Prices/models are dated assumptions; verify them before live use. Conservative accounting can reserve more than a call ultimately costs; unknown usage retains the full reservation and an overrun faults the budget. It is not a guarantee about an external invoice.

The Node evaluation journal has a persistent cumulative cap across midnight. Choosing a fresh journal directory is a deliberate separate run. A crashed lock needs verified operator recovery; the app never automatically removes another session's lock. Windows/OneDrive durability remains unverified.

See [BOLT-HANDOFF.md](../BOLT-HANDOFF.md) for the inspection-only provisioning inventory and [EVALUATION.md](EVALUATION.md) for evaluation discipline.
