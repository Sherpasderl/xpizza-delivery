# xpizza-functions/factura — deploy-bundled copies

These four modules are **byte-identical copies** of the tested source in
`xpizza-factura/src/`. They live here because Firebase Functions only bundles code inside
the functions source directory at deploy time — the trigger (`allocateFacturaOnSale` /
`voidFacturaOnCancel` in `index.js`) requires them via `./factura/...`.

| File | Source of truth |
|------|-----------------|
| `money.js` | `xpizza-factura/src/money.js` |
| `allocate.js` | `xpizza-factura/src/allocate.js` |
| `build-record.js` | `xpizza-factura/src/build-record.js` |
| `factura-helpers.js` | `xpizza-factura/src/factura-helpers.js` |

**Edit the originals in `xpizza-factura/src/`** (that's where the unit tests live), then
re-copy here. A drift-check test (`factura/sync.test.js`) fails if these copies diverge
from the source, so the two can't silently get out of sync.

The print-side modules (`renderer`, `escpos`, `num-to-words`, `print-claim`) are NOT copied
here — they run only in the print agent on the Surface, not in Cloud Functions.
