# Vendored code and prior art

**No third-party source code is vendored in this repository.** Every module is a fresh
implementation. Where an idea came from prior art, it is a **concept port, no source vendored**.
Runtime dependencies are ordinary npm packages pinned in `package.json` (licences to be verified
in D6, `docs/DEFERRED-VALIDATION.md`).

| Module | Status | Ideas taken (no code) |
|---|---|---|
| `src/core/l10nchecks/` | concept port, no source vendored | compare-locales (MPL-2.0): errors must never be false positives; i18n-check (MIT): rule families; Weblate (GPL — ideas only): check categories and severities |
| `src/core/maskgate/` (M3) | concept port, no source vendored | Locallingo (MIT): mask/restore placeholders before a model sees text — avoiding its dot-joined key flattening |
| `src/core/cited/` (M3) | concept port, no source vendored | own `cited` finding schema, ported to TypeScript |
| `src/core/rulings/` (M3) | concept port, no source vendored | Weblate (GPL — ideas only): fingerprint invalidation when text changes; suggestion approval separate from finding acceptance |
| `src/core/review/` (M3–M5) | concept port, no source vendored | jta (MIT): reflection-style prompt idea — avoiding its rewrite-everything design |
| `src/core/sarif/` (M7, optional) | concept port, no source vendored | KAERIS (MIT): RED/YELLOW severity mapping and SARIF output |
| `scripts/eval.ts`, `src/core/evalkit/` (M2/M6) | original | LocaleCI (FSL — idea only): CI-style reporting |

No GPL or FSL code is used. COMET / ACES learned metrics are excluded.
