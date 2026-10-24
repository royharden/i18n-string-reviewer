# Recorded replies

All replies are synthetic, authored examples, not captured provider output. `demo-icu.json` and `demo-i18next.json` bind to dev-only demo keys. `adversarial.json` holds self-contained gate cases for every reason, literal token collisions, missing `#`, branch mutation and valid nonvacuous controls. Synthetic cases are separate from the frozen evaluation corpus.

Each reply contains findings and optional regeneration alternatives. Expectations document evidence/gate/drop behavior and are checked by source tests. A reply with `item` is never served by the mock reviewer. The invariant test enumerates every JSON file and every suggestion, including alternatives and unsupported/dropped evidence cases, then checks any accepted fix against the current target.

No test or replay has run during Dirty Mode.
