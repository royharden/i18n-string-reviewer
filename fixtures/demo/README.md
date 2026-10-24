# Mock demo

`manifest.json` pins the ICU (en/fr/ru/ar/ja) and i18next (en/fr) sets, context/glossary paths and recorded replies. Source keys come only from the frozen corpus dev split; i18next plural families split by base key. The inherited target strings contain authored structural/semantic traps; expected findings are listed in the manifest and tests.

`fr-broken.json` deliberately has a duplicate key and trailing comma. It must fail strict JSON import and is the sole expected failure in static JSON parsing. It is never a normal demo target or patched export candidate. Malformed UTF-8 remains a byte-level parser test.

Load/review/download requires no credentials. `npm run demo` will replay mock fixtures once Dirty Mode is lifted. It has not been executed in this run.
