# REVISE-2 → EXECUTOR — Phase 1a: fix ONE overclaiming comment (codex, claim-accuracy)

**Gate: the code is CORRECT (12/12 emulator green, both fixes verified) — one comment overclaims fail-safety.** Codex: the delete-before-set "fail-closed / never a stale price" claim is wrong for a MULTI-BATCH chunk failure — multi-batch reconcile is NOT atomic. On a re-seed with >450 stale deletes, if the 2nd delete batch fails, the first 450 deletes apply, the REMAINING stale docs SURVIVE, the fn throws → a surviving stale doc is an item at an old price. So it can leave the catalog inconsistent (stale OR missing), not fail-closed.

## Fix (comment/claim only — do NOT change the chunking behavior)
In `seed-catalog-core.js`, replace the "delete-before-set is fail-safe / never a stale price" comment with the honest version:
```js
    // Chunked at 450 (Firestore caps a batch at 500 ops). NOTE: a sequence of batches is NOT atomic — a
    // partial failure (e.g. the 2nd delete chunk throws) can leave the catalog INCONSISTENT: stale docs
    // survive or current docs are missing. This is acceptable ONLY because (a) 1a's real seeds are single-
    // batch (x_pizza 24, la_musa 43 << 450 → atomic in practice), and (b) the REQUIRED post-seed
    // `verify-catalog.js` gate byte-compares prod vs code and blocks deploy on any mismatch. Atomic cutover
    // under a LIVE reader (a real large-menu re-seed) needs the 1b versioned-publish precondition — NOT this.
```
(Keep the delete-before-set ORDER — it's the better-of-the-two partial states — just stop calling it a guarantee.)

## Definition of done
Comment corrected; no behavior change; `npm run test:catalog-parity` still 12/12, `npm test` still green. Handback (new SHA) → advisor confirms the one-line-scope delta → APPROVED. (This is the last item — the code is done.)
