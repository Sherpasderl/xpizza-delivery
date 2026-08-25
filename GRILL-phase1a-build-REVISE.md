# REVISE → EXECUTOR — Phase 1a built code (advisor audit + codex money-adjacent gate)

**Gate result: REVISE — 2 fixes, both in `xpizza-functions/catalog/seed-catalog-core.js`.** Everything else CLEAN + verified: additive (live pricing path byte-untouched), money proof 9/9 (emulator, advisor-run: parity both brands + falsifiable + rename-reconcile + all validation throws), rules 12/12 (payouts deny-by-default), reader fail-signal contract, predeploy binds both suites. Branch `feat/phase1a-catalog` @ `11c2cb3`.

## 🔴 Fix 1 (SECURITY, must-fix) — profile allowlist doesn't protect the FINAL doc
`seedCatalog` writes `await rref.set(meta.profile, { merge: true })`. `{merge:true}` leaves any PRE-EXISTING field on the doc — so a payout/`bank_account` field that ever lands on `restaurants/x_pizza` (future phase / manual write) SURVIVES on the public-read profile → exposed. The allowlist blocks what WE write, not the doc's final contents.
**Fix:** full overwrite (NO merge) — the public profile must contain EXACTLY the allowlisted fields; the profile is fully seed-owned, private data lives on a separate server-only path:
```js
    await rref.set(meta.profile);   // profile LAST, FULL overwrite (no merge) — a stale private field is REMOVED, not merged under
```
**Add an emulator test** (in `test/catalog-parity.emulator.test.js`): pre-write `restaurants/x_pizza = { name:'X. Pizza', tier:'flagship', bank_account:'SECRET' }`, run `seedCatalog(db, R())`, then read the profile doc and assert `bank_account` is ABSENT (full overwrite scrubbed it). This locks the invariant.
(Note in a comment: any FUTURE seed-managed public profile field must be added to `PROFILE_FIELDS` AND `meta.profile`, since full-set replaces the doc.)

## 🟠 Fix 2 (robustness) — chunk the batch at ≤450 ops (Firestore 500-op limit)
Each subcollection commits one batch (reconcile-deletes + sets) with no chunking. Not triggered by 1a's small tables, but a future large menu + stale docs could exceed 500 ops → the whole subcollection commit fails. Chunk it:
```js
    // commit in chunks (Firestore batch cap 500) so a large future menu can't fail the whole subcollection
    const ops = [];
    existing.forEach((snap) => { if (!wantIds.has(snap.id)) ops.push((b) => b.delete(snap.ref)); });
    for (const d of docs) ops.push((b) => b.set(col.doc(d.id), { key: d.key, price: d.price }));
    for (let i = 0; i < ops.length; i += 450) {
      const b = db.batch();
      for (const op of ops.slice(i, i + 450)) op(b);
      await b.commit();
    }
```
(Keep the reconcile semantics identical — delete stale + set current; just chunked.)

## Definition of done
Both fixes in `seed-catalog-core.js`; the new profile-overwrite emulator test added; `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-parity` green (now 10 cases incl. the scrub test) + `npm run test:catalog-rules` green (12) + the 3 pure tests + full `npm test` green. Handback (new SHA) → advisor re-verify (re-run the emulator suites) + a final codex confirm on the delta → owner deploy steps (Firestore us-central1, seed, verify-catalog green, rules).
