# Bolt handoff — i18n String Reviewer

## Readiness and target

**M4 source inventory statically reviewed — runtime unverified.** No dependencies, lockfile, build, database, function, auth session or provider integration has been validated. **Not import-ready until D1**, followed by D2 and applicable [deferred validation](docs/DEFERRED-VALIDATION.md). Do not provision or publish during this Dirty Mode run.

Target: **fresh Bolt Database**, Supabase-compatible SQL/Auth/Deno boundaries. No project ID, remote database, GitHub remote, hosted URL or existing applied baseline is bound. A future operator must verify the actual target and migration history before changes; preserve any existing connection/data and apply only pending migrations. Files are construction specifications, not deployment receipts.

## Source inventory

The listed source paths are present and statically reviewed for Dirty Mode construction. Confirm the accepted source revision and complete deferred checks before later setup:

| Resource | Source / purpose |
|---|---|
| Accounting schema | `supabase/migrations/20261024000100_create_accounting.sql`: server-only `daily_budget`, `call_ledger`; RLS enabled, no public/anon/authenticated access |
| Budget RPCs | `supabase/migrations/20261024000200_create_budget_rpcs.sql`: reserve/reconcile; service-role execution only; atomic reservations and duplicate ownership marker |
| Review function | `supabase/functions/review-strings/index.ts`, `handler.ts`, `_shared/`; gateway `verify_jwt = true` in `supabase/config.toml` |
| Shared function source | `src/core/shared/`; `scripts/sync-function-shared.ts` produces header-stamped copies; drift regression source compares copies |
| Browser connection | `src/lib/supabase.ts`; public config absent means explicit mock mode |
| Node eval journal | `src/core/callledger/`; separate local persistent budget under ignored `.cache/`, not browser code |

Apply the two migrations in the listed order only after an authorized fresh target is confirmed. Tables contain accounting metadata and numeric usage only, no source/target strings, model responses or locale/ruling files. Request hashes cover whole provider requests, never individual strings. Same-attempt reserve returns an ownership marker; duplicate attempts cannot dispatch another provider call. Reconciliation uses the reservation's own UTC day. Unknown usage remains charged in full; overruns fault the budget and stop later calls.

## Function and access

One browser function: `review-strings`. Caller must supply a valid signed-in user JWT; handler verifies with `auth.getUser`, requires confirmed email and exact normalized `ALLOWED_EMAILS` membership before any privileged accounting call. A project anon key is not user authentication. Public/unauthenticated/non-allowlisted access must fail.

Strict request: requestId, attempt, schemaVersion, reviewer (`llm` or `jev`), withContext, and at most twenty masked items. Client model/provider fields are rejected. Server re-redacts all model-visible strings. Request/response bytes and provider duration/output are bounded; provider calls do not retry inside the function. Each new attempt reserves separately.

The same function supports an authenticated no-charge cost preview (`x-review-mode: preview`): build/estimate/hash only, no accounting reservation/admin/provider call. Browser gives a transfer notice before preview and requires fresh paid-run confirmation afterward. Execute can bind the preview with `x-review-estimate-hash`; stale body/model/price configuration fails before reservation. CORS must allow the implemented auth/public-client/content headers and both preview headers only for configured origins. Preview sends masked product text to the backend; actual review sends it to the selected provider.

## Configuration names — never values

Frontend public placeholders only:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Server settings, consumed by `review-strings`:

- `ANTHROPIC_API_KEY` and server-owned `ANTHROPIC_MODEL_ID` for live generative review; choose a model supported by the committed dated price table. Unknown/unpriced models must fail closed.
- `TYPESAFE_API_KEY` only for experimental Jev; model pin `jev-1.13.0`, no browser key. Multilingual quality and inclusion remain unproven.
- `ALLOWED_EMAILS`: exact confirmed-email allowlist.
- `ALLOWED_ORIGINS`: actual frontend origins, no wildcard fallback for protected live calls.
- `DAILY_BUDGET_USD`: explicit server cap (plan proposal 2.00 USD/UTC day); keep operator intent and price assumptions visible.
- Platform-provided `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: verify function availability in the actual target; do not copy credentials from another project.

Node-only eval names: `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `ANTHROPIC_MODEL_ID`, `EVAL_MAX_USD`. No real credentials belong in this repo or handoff. Missing live configuration must produce explicit errors; never silently substitute mock results.

## Auth and other resources

Configure email OTP sign-in, confirmed emails, Site URL and allowed redirect origin for the actual frontend. Validate request/verify/session/signout behavior later with an allowlisted and a non-allowlisted account. Confirm legacy gateway JWT/key compatibility in the chosen target without removing handler authorization.

Storage buckets, Realtime, schedules, jobs, webhooks and persistent application workers: **not required**. Locale files and decisions stay in browser memory/exports. External accounts: Anthropic; optional TypeSafe. No cloud resource, account or provider call was created by local construction.

## Validation still required

D1/D2 first: dependency resolution and lockfile, typecheck, lint, tests, build. D7/D8: apply migrations to the authorized isolated target, SQL/RPC access tests, separate true concurrency driver (single-session SQL is not concurrent), function bundle/import/JWT/allowlist/CORS/error/preview tests. D9–D11: OTP redirect/session behavior, provider contracts/model/prices/usage and capped calls. D12–D14: actual evaluation and full browser journey, cancellation/partial results, approved patch byte identity and downloads. Node journal recovery on Windows/OneDrive is D17. Nothing is certified by static construction review.

Local journal lock recovery: never automatically remove another session's lock. After a crash, an operator must verify no owning eval remains before deliberate recovery; stale reserved entries are charged in full when a lock can be reacquired. The Node journal cap spans UTC midnight; choosing a fresh journal directory is a deliberate separate evaluation run.

## Prompt for a future authorized Bolt inspection

> Read BOLT-HANDOFF.md and inspect the accepted inner-repository revision. This is source-only construction with no lockfile or runtime validation; do not infer backend readiness. Confirm actual files/resources against the inventory, resolve dependency/build/function-bundle gaps and report required owner settings. Target a fresh Bolt Database unless a real existing connection is found, in which case preserve it and inspect its applied baseline read-only. Prepare a concrete setup/validation plan. Do not create or change cloud resources, apply migrations, deploy functions, enter secrets, run paid calls or publish. Provisioning and publication require a later explicit instruction after the deferred validation boundary is addressed.
