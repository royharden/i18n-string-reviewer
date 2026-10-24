# Cited findings

`validateModelFindings(raw, batch, reviewer)` accepts only items whose ID, masked key and locale match the producing batch. Invalid replies are dropped and counted by reason. The finding ID binds key, locale, source/target text, category and review check version with SHA-256.

Evidence must occur once in the masked target and, after restoration, once in the original target. Evidence overlapping any part of an `R` token is unsupported. Missing, ambiguous, malformed and redacted evidence stays visible as an unsupported claim with no proposal. Supported proposals remain masked until the pipeline gate accepts them; a human must then approve the specific suggestion hash.

Static findings share the schema and retain their rule ID/severity for sorting. They are not model proposals. Runtime validation is deferred; tests are source only during Dirty Mode.
