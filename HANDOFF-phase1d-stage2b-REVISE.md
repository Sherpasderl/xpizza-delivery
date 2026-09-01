# REVISE RELAY — Phase 1d Stage 2b: the ladder must fail closed on corrupt mirror VALUES + warm in prod

**To:** executor session · **From:** advisor. **Base:** `feat/phase1d-stage2b-snapshotfor-ladder @ 2baed28`. The codex money gate returned **REVISE** — 1 BLOCKING HIGH + 1 rollout gap. The ladder sequencing (rungs 1-3, K via seq, absent-seq fail-closed, cold-disaster, deadline-bounded), the recorder wiring + its records-assertion test, INERT, and the flipPointer seq-check are all CONFIRMED SOUND — do NOT touch them. Fix the two below.

## 🔴 BLOCKING (HIGH) — `snapshotFor` can serve corrupt mirror PRICES
`mirrorUsable` (catalog/snapshot-fallback.js:41) checks `Number.isInteger(seq)` + that `menu`/`extras` are objects, but NOT the price VALUES — so a mirror with a `0`/negative/non-integer price (or a non-string key) is served at the mirror rung (:88) or the cold-mirror rung (:96). The disaster-fallback pricer must **fail closed on a corrupt table at the ladder**, not serve it and rely on the 1a calculator-guard downstream — the ladder's contract is "never serve a price it can't vouch for."

**Fix — validate the table VALUES with the SAME shared rule the whole platform uses.** Import the 1a helper (`const { isValidPrice } = require('../price-valid')`) and extend `mirrorUsable` (or a new `tablesUsable`) so a mirror is usable ONLY if EVERY `menu` and `extras` value passes `isValidPrice` (positive integer) AND every key is a non-empty string:
```js
const pricesOk = (t) => t && typeof t === 'object'
  && Object.entries(t).every(([k, v]) => typeof k === 'string' && k.length > 0 && isValidPrice(v));
function mirrorUsable(m) {
  return !!m && Number.isInteger(m.seq) && pricesOk(m.menu) && pricesOk(m.extras);
}
```
- This gates BOTH the known-active mirror path AND the cold-mirror path (both go through `mirrorUsable`). A corrupt mirror → `mirrorUsable` false → the existing `catalog_mirror_unusable` alarm + fall through to fail-closed (rung 3), exactly like an absent seq.
- **Apply the same to `recordGood`/`lastGood`** for symmetry: don't record a `lastGood` whose tables contain a corrupt value (so rung 1 can never serve one either). A served happy-path table can't be corrupt today (the reader + 1a already reject it), but the ladder should not *depend* on that.

## 🟡 ROLLOUT GAP (codex Medium, fold in) — prod never warms `lastGood`
`index.js:280` creates the resolver with `{ reader, codeFor, alarm }` and **no `ladder`** — so in production the recorders never run and `lastGood` never warms. The relay's whole point of an additive/inert 2b was "record in prod during 2b so 2c drops onto WARM state." As built, 2c would inherit a COLD ladder (rung 1 empty; it'd work via rung 2/the mirror, but the warm-path benefit is lost).

**Fix — inject the ladder into the prod resolver, recording-only:** in `index.js` where `createPricingResolver` is built, construct the fallback (`createSnapshotFallback({ mirrorReader: <the RTDB /catalog_snapshot reader>, alarm: paymentAlert-wired })`) and pass it as `ladder`. This STAYS INERT: `getPricingTables` never CALLS `snapshotFor` in 2b (the failure path still returns `codeResult`), so the mirrorReader is wired but never read — only `recordActive`/`recordGood` (in-memory) run. Net: prod warms `lastGood`/`lastKnownActive` during 2b, and 2c's flip is the one-line swap onto a ladder that's been fed real state.
- The `mirrorReader` for prod reads RTDB `/catalog_snapshot/{rid}` via `getDatabase()` (bounded) — but since it's unread in 2b, a trivial correct reader is fine; just wire it so 2c doesn't have to add it under money-grill pressure.
- **Add a test that prod actually injects a ladder** (the class of "silently not wired" bug that already bit the recorders once) — assert `createPricingResolver` is called with a `ladder`, or that after a real order the resolver's `lastGood` is populated.
- If you'd rather keep 2b strictly library-only and wire in 2c, that's acceptable — but then state EXPLICITLY in the handback that 2c inherits a cold ladder and must warm before the flip is load-bearing. (I recommend injecting now; it's inert and realizes the intent.)

## 🔒 Guards
- The BLOCKING fix touches ONLY `mirrorUsable`/`recordGood` value-validation (+ the `price-valid` import). The rung sequencing / deadline / alarms / distance math stay byte-unchanged.
- The rollout fix touches ONLY `index.js`'s resolver construction (add the `ladder` arg) — still INERT (`snapshotFor` unreached; failure path returns `codeResult`). Prove `getPricingTables` behavior byte-identical.
- 1a value-guard at the calculators remains the final backstop; this makes the ladder fail-closed on corrupt values FIRST (defense in depth), never serving one.

## Tests
- **Corrupt mirror fails closed** — on BOTH the known-active and cold paths: a mirror with a `0` / negative / non-integer price, or a bad key → `mirrorUsable` false → `catalog_mirror_unusable` + fail-closed (`snapshot_fallback_unavailable`), never served. Mutation-check: reverting the value-validation makes these RED.
- **`lastGood` refuses a corrupt table** (rung 1 never serves one).
- **Prod wires a ladder** (the injection test above).
- The existing 2b suite (ladder rungs, INERT, recorder-records, real-projection reader) stays green.
- `node --check`; full suite green.

## Gate & deploy
- LOCAL-ONLY → advisor re-audit + codex re-gate on the delta (corrupt-mirror fail-closed both paths; the value rule == `isValidPrice`; prod injects the ladder recording-only + stays inert; behavior byte-identical).
- Deploy (owner): full `--only functions` (resolver + index.js on the per-order path; still INERT). Prove-in-prod: pricing identical; after some real orders, confirm the resolver is warming (a debug/log check is fine) OR at minimum that no new alarms fire; the still-pending **la_musa heartbeat**.

## Handback DoD
Branch@SHA (on 2baed28); the `mirrorUsable`/`recordGood` value-validation diff + the corrupt-mirror fail-closed tests (both paths, mutation-checked); the `index.js` ladder-injection diff + the prod-wires-a-ladder test + the INERT proof (byte-identical `getPricingTables`); full suite green.

---
*REVISE relay (advisor→executor). Blocking: the ladder must fail closed on corrupt mirror values, not serve them. Plus wire the ladder in prod so 2b actually warms the state 2c inherits.*
