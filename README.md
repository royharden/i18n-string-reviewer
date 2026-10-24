# i18n String Reviewer

Review locale JSON, inspect deterministic and optional model findings, decide what to accept, and download only explicitly approved fixes that pass a structure-preserving gate. Original files stay local and are never overwritten.

## Construction status

**Dirty Mode source construction in progress — runtime unverified.** M1–M5 deterministic checks, synthetic corpus, mock workflow/UI, live integration and hard-case reviewer source are statically reviewed. Evaluation source remains next.

No dependencies have been installed; no application, test suite, lint, typecheck, build, browser, database or provider call has run. Static checks consist of source tracing and TypeScript type-stripping/syntax parsing. They do not resolve imports, type-check, or parse TSX. There is **no lockfile**. This repo is **not import-ready until D1**, followed by D2 and the remaining applicable checks in [deferred validation](docs/DEFERRED-VALIDATION.md).

## Try it after validation is authorized

From this inner repository, first follow D1/D2. Then:

```sh
npm run dev
npm run demo
npm run eval
```

The intended default is mock mode, with synthetic fixtures and no API keys or network. These commands have not been run during construction. A successful future install/build alone will not verify the backend.

## Data and architecture

- `src/core/l10nchecks`: strict UTF-8 JSON import, segment-array paths, locale/dialect checks, metadata validation and seventeen deterministic rules.
- `src/core/maskgate`, `cited`, `context`, `rulings`, `export`, `review`: masked review, evidence validation, structural fix gate, fingerprint-bound decisions and download-only patches (statically reviewed construction).
- `fixtures`: agent-authored MIT TaskBoard translations and planted semantic labels. Seed selection and the frozen source-key split are disclosed in `fixtures/manifest.json`; this partition was selected before model/rule outputs existed, rather than drawn blindly.
- `src/core/review/{heuristic,jev,cascade}.ts`: local baseline and experimental screening contracts; Jev/cascade are disabled by default with unmeasured provisional configuration. Synthetic probability examples test composition only.
- `src/core/providers`, `src/core/callledger` and `supabase/`: provider transports, atomic SQL accounting, persistent Node eval journal and authenticated preview/review function source. See [BOLT-HANDOFF.md](BOLT-HANDOFF.md); none has been deployed or exercised.
- The backend design stores only paid-call accounting. Locale text and rulings are not persisted server-side. Provider credentials belong in server/eval environment variables, never frontend variables.

JSON only; PO and other formats, translation generation, visual overflow/RTL layout verification and translation memory are outside the MVP. Files in one comparison must use a common confirmed dialect and distinct target filenames; rename same-named target files before importing. Known parser/tokenizer approximations are described in the core README and deferred validation.

## Results and cost

**Pending — no evaluation has run.** There are no measured quality, invariant, latency or cost results. Mock replay demonstrates intended fixture/gate behavior only after it is actually executed; it cannot measure model accuracy. Live context-off/on and experimental Jev/cascade comparisons remain unmeasured.

What the table proves: structural recall shows the rules fire on known mutation shapes, not that they cover real-world files; the semantic table is on agent-written translations by a possibly related model family, so absolute recall is not comparable to human-labelled data. The `android-l10n` slice (open question 3) is the mitigation.

## Development

Exact dependency pins are unverified until installation. Declared commands: `npm run typecheck`, `npm run typecheck:node`, `npm run lint`, `npm test`, `npm run build`. `node scripts/syntax-check.mjs <directory>` is syntax-only and does not execute application/test modules.

Coding agents authored the source and fixtures. Independent subagents reviewed construction statically; runtime validation is deferred. See [VENDORED.md](VENDORED.md) for prior-art concepts; no third-party source was copied. MIT — [LICENSE](LICENSE).
