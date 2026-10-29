# Rulings

Human decisions form an append-only JSONL log validated line by line. Invalid lines are reported with line numbers. `l10n_finding` is the provisional kind, pending D15 compatibility review. Each entry binds the finding ID, current item fingerprint and, for `approve_fix`, the specific suggestion hash. Key and locale enable invalidation display after a finding disappears.

Replay uses the last log entry per finding and reports contradictory simultaneous or out-of-order decisions. Changed text or a changed suggestion invalidates approval. Multiple active approvals for one string are blocked until `pickCompetingApproval` supplies append-only rejection entries for the alternatives. `exportableApprovals` excludes unresolved competitors; patched export independently repeats the bindings and gate checks.

No clock is read by core: callers supply timestamps. Tests are written but unexecuted in Dirty Mode.
