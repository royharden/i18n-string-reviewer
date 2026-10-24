# i18n String Reviewer

A review-only React app for localisation files: upload one source locale JSON and up to 10
targets, get deterministic findings with stable rule ids, optionally run a context-aware model
review over **masked, redacted** text, then approve, reject or skip each finding and fix. Downloads
contain only approved fixes that passed a structural gate. Nothing is written in place.

## Status — read this first

**Source-complete for Dirty Mode construction — runtime unverified.**

- This repository was written under **Dirty Mode**: static checks only. **Nothing has been
  installed, built, type-checked, linted, tested or run.** No `npm install` has happened and there
  is **no lockfile**.
- The only check performed is `node scripts/syntax-check.mjs .`, which strips TypeScript types
  and asks Node to parse each `.ts` file. It does not type-check, resolve imports or cover `.tsx`.
- **Not import-ready** (Bolt or otherwise) until a lockfile exists and the deferred validation in
  [`docs/DEFERRED-VALIDATION.md`](docs/DEFERRED-VALIDATION.md) (D1, D2 first) has passed.
- No accuracy is claimed. The evaluation table does not exist yet.

## What is built (milestone M1)

- Project scaffold: `package.json` (exact version pins, unverified — D1), TypeScript strict
  configs, Vite, Vitest, ESLint, a placeholder React shell (`src/App.tsx`), CSP `<meta>` in
  `index.html`, `.env.example` (names only).
- `src/core/l10nchecks/` — the deterministic core: strict locale-file import (caps, fatal UTF-8,
  duplicates, path-segment keys), `context.json` / `glossary.json` validation, a validation report,
  dialect detection (`icu | i18next | plain`), placeholder tokenizer, ICU path signature, tag tree
  compare, plural categories via `Intl.PluralRules`, number normalisation, and **all 17 rules**.
  See [`src/core/l10nchecks/README.md`](src/core/l10nchecks/README.md).
- `src/core/shared/hash.ts` — SHA-256 via Web Crypto.
- Tests **written, not run**: `tests/l10nchecks/**` (one file per rule plus parser, metadata and
  helper tests) and `tests/traps/**` (the deterministic demo traps).

Not built yet: masking/redaction and the fix gate, model reviewers, the review UI, rulings,
patched export, the edge function and budget ledger, the evaluation script and results.

## Planned scripts (none has been run)

| Script | Purpose |
|---|---|
| `npm run dev` / `build` | Vite dev server / production build |
| `npm run typecheck` | `tsc --noEmit -p .` |
| `npm run lint` | ESLint |
| `npm test` | `vitest run` |
| `npm run demo` | Mock-only demo, no keys, no network (M3) |
| `npm run eval` | Evaluation table (M6) |
| `npm run sync:function` | Copy `src/core/shared` into the edge function (M4) |
| `npm run syntax-check` | The static type-strip parse used in Dirty Mode |

## Licence

MIT — see [LICENSE](LICENSE). Prior-art ideas are listed in [VENDORED.md](VENDORED.md); no
third-party source is vendored.
