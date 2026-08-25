# Plan Review Log: Phase 1a — Catalog schema, seed, reader, parity

Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md + ADR 0005 written. MAX_ROUNDS=5.

## Act 1 summary — 6 questions, 6 findings, all applied

| Q | Finding | Resolution |
|---|---|---|
| 1 | `merchants/{x_pizza}` collided with `CONTEXT.md`'s **Merchant** = Sherpa S. de R.L.; would invert meaning at the Phase-4 ledger | Renamed to `restaurants/{restaurant_id}` across plan, spec, relay; `merchants/` reserved; ADR 0005 |
| 2 | The stated parity invariant is `Object.fromEntries(Object.entries(T))` — a tautology; passes on an all-zero menu. `getRestaurantDocs` never implemented, so 1b would run the first real Firestore read on the money path | Task 6 added: emulator round-trip (seed → real read → deepStrictEqual live tables, both brands), falsifiable + drift case. Seed refactored to importable `seedCatalog(db)` with stale-doc reconcile |
| 3a | `match /{sub=**} { allow read: if true }` published every future subcollection — incl. Phase-4 payouts/ledger — with no rules change | Enumerated `menu_items` + `extras`; wildcard dropped; regression assertion that `restaurants/x_pizza/payouts/x` is read+write denied; payout fields removed from the public-read profile doc |
| 3b | Task 5 targeted a root `firebase.json` and a `hosting` key that do not exist; contradicted Task 6 | Re-pathed to `xpizza-functions/firebase.json` (`database`+`functions` only) |
| 3c | Firestore rules would deploy unguarded while RTDB rules run `check:rules` predeploy | `firestore.predeploy` added |
| 3d | Firestore location is permanent; console defaults to `nam5` while all functions and RTDB are `us-central1` | Owner runbook pins Native mode / `us-central1`, flagged irreversible |
| 4 | No CI in this repo — `npm test` is the only automated gate, and none of the 5 new tests were wired in; the money proof would prove-once-then-rot | Task 7: pure tests into `npm test`, both emulator tests into `firestore.predeploy` |
| 5 | Reader returned `{menu:{},extras:{}}` for not-seeded / error / empty alike and cached it. (Correction: `computeServerTotal` fails closed, so this is availability + diagnosability, not mispricing) | `getRestaurantDocs` throws `restaurant_not_found`; errors propagate uncached; cache only on success |
| 6 | 1b's cutover surface is 4 consumers, not 1 — incl. factura `pricedLineItems`, which prints on a Void-only SAR document | Spec's 1b names all four; **Phase 1b reclassified as tripping the fiscal owner gate** |

Plan grew 5 tasks → 7. No code written. Proceeding to Act 2 (Codex, read-only).

---

## Round 1 — Codex (thread `01a03a76-249b-79d1-9a75-74a81b262753`)

`VERDICT: REVISE` — 10 findings (4 High, 5 Medium, 1 Low).

**High**
1. Stale-doc reconcile is claimed proven but never exercised — the drift case mutates an existing key's price, and `docId = sha1(key)` means the same key writes to the same doc id, so no orphan is created and `batch.delete` never runs.
2. `getRestaurantDocs` treats "profile exists, `menu_items` empty" as a successful catalog, which the reader then caches.
3. `buildTablesFromDocs` silently drops docs lacking a string `key` and accepts arbitrary `price` types, so malformed Firestore data reads back as success.
4. The profile doc is world-readable and "no private fields here" is enforced only by a comment — rules cannot constrain Admin SDK writes.

**Medium** — 5. plan line 7 still calls the pure transform round-trip "the money-safety proof". 6. rules test asserts `get` by known doc id, but hashed ids mean real clients must `list`. 7. profile is written before the subcollection batches, so an interrupted seed leaves a profile that reads as an empty success. 8. emulator parity never requires a post-seed production readback. 9. seed CLI logs only "complete" — no counts, source SHA, or table hash.

**Low** — 10. `pricing_key_mode` is written but never asserted against `itemPricingKey`.

### Claude's response — 9 accepted, 1 partially rejected

**Accepted (1, 2, 3, 4, 5, 6, 8, 9, 10).** Finding 1 is correct and was verified against the plan source: the drift case reuses the same Pricing key, therefore the same hashed doc id, therefore an in-place overwrite — the reconcile branch added in Act 1 Q2 is dead code under its own test. The drift case must **rename** a key. Findings 2 and 3 are the Act 1 Q5 hole reappearing one level down: "not found" was fixed, "found but empty" and "found but malformed" were not. Finding 3 carries a concrete money consequence in Phase 1b — a non-integer price flows into `total += menu[key] * qty`, and `computeServerTotal` would return `{ total: NaN, error: null }`, which callers gate on `error`, not on `total`. Finding 4 is right that Admin SDK writes bypass rules, making the profile allowlist the only real enforcement. Finding 8 is the largest remaining gap and the most valuable of the ten: the emulator proves the code path, nothing proved the production seed.

**Placement adjusted on finding 3:** validation goes in `getRestaurantDocs` (the trust boundary for untrusted stored data), not in `buildTablesFromDocs`, so the pure transform stays a pure lossless codec. Same protection, cleaner seam.

**Partially rejected — finding 7.** The diagnosis is accepted; the proposed remedy is not. A versioned catalog snapshot plus an active-pointer flip is the right pattern for a live read path, but Phase 1a has two Restaurants, ~67 documents, no reader, and an explicit mandate to stay minimal — that machinery belongs to 1b/1c, where the catalog is actually read. Taking the cheap 90%: **write the profile last**, after both subcollection batches commit, so a profile's existence implies a complete seed. Combined with finding 2's `catalog_empty` throw, the dangerous read is closed without introducing a pointer protocol nobody reads yet.

Plan grew to 8 steps (added post-seed production verification). Proceeding to round 2.

---

## Round 2 — Codex

`VERDICT: REVISE` — 1 High (blocking), 1 Medium (non-blocking). Both prior pushbacks conceded:
Codex agreed `profile last + catalog_empty + required prod verify` is a reasonable non-versioned
bridge for a phase with no live reader, and did not contest moving validation to `getRestaurantDocs`.

**High (blocking):** the executable task-by-task plan at
`docs/superpowers/plans/2026-08-25-phase1a-catalog-schema-parity.md` is stale and contradicts
`PLAN.md` — it still calls the transform round-trip the money proof (line 7), writes the profile
before the subcollections (line 239), lacks `catalog_empty` and document validation (line 327),
and mutates a price instead of renaming a key in the drift case (line 362). An executor follows
*that* file, not `PLAN.md`.

**Medium:** `PLAN.md` should state that the unversioned seed order is Phase-1a-only.

### Claude's response — both accepted

The blocking finding is correct and is the sharpest kind of process bug: two documents disagree
and the one an executor actually builds from is the unsafe one. Codex offered two remedies —
update the file, or mark it superseded. The detailed plan is the advisor session's artifact and
is theirs to revise, so the minimal safe action was taken: a **stop banner** at the top of that
file naming each stale item and instructing the executor to halt and request the updated plan.
The banner is trivially removable once the tasks are updated.

The Medium is accepted as written: a Phase 1b precondition now appears in `PLAN.md`'s risks —
either no live Catalog reads during a seed, or versioned publish semantics.

Proceeding to round 3.

---

## Round 3 — Codex

`VERDICT: APPROVED`

Codex confirmed all prior findings resolved at the controlling-plan level, judged the stop banner
sufficient ("at line 1, names the stale dangerous items explicitly, points to `PLAN.md`, and tells
executors to stop rather than improvise"), and agreed the versioned-publish remedy was correctly
deferred out of Phase 1a given the Phase 1b precondition now recorded in `PLAN.md`.

Two minor issues raised, both accepted and applied:
- "Seven TDD tasks" was stale after the plan grew to eight → corrected.
- "A profile's existence implies a complete seed" is true only on a *first* seed; on a re-seed the
  profile already exists, so write order proves nothing there. Softened: completeness on re-seed
  rests on the post-seed production verification step, not on write order. This one was a genuine
  logical error in my own round-1 revision, not a wording nit.

**Converged at round 3 of 5. No code written during either act.**
