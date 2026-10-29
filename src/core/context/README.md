# Context pack

`buildContextPack` takes masked fields only. Its deterministic priority is source, target locale/plural categories, context entry, description, glossary, then siblings. It truncates the first section that does not fit and drops all lower-priority sections. List sections keep whole lines. Safe text cuts split neither surrogate pairs nor bracket tokens. The hard cap is 2,000 UTF-16 code units even when a caller requests a larger cap.

`matchGlossary` and `selectSiblings` operate locally on original text. `maskItem` masks their selected output before packing it. Runtime and worst-case tests are deferred in Dirty Mode.
