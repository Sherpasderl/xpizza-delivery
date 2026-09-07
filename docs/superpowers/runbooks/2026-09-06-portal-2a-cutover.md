# Runbook — Portal Phase 2a cutover: complete source inversion

**Owner-run. Local build is complete and audited; nothing has been pushed or deployed.**

After this cutover, `restaurants/{rid}/meta/source` in Firestore is the single authority for everything
menu-derived: prices, display, categories, the weekend gate, redemption eligibility, the reorder-recipe
allowlist, and which restaurants exist. `menu-pricing.js` and `rewards-redeem-config.js` become
**fallback-only** — read solely when the catalog is unreadable or a field is unauthored.

**The cutover is designed to be a byte-identical no-op.** Nothing a customer can see should change. If
anything does change, that is a bug, not a successful migration — stop and roll back.

---

## 0. What makes this safe (read before starting)

Three independent properties, each proven by a test that fails if the property breaks:

1. **The parity gate.** `publish-version.js --from-store` builds the catalog from the store, builds it
   again from code, and refuses to publish unless they are canonically identical — same prices, same
   extras, same structure, same display hash. The gate runs **before** `publishVersion`, so a mismatch
   writes nothing and moves no pointer.
2. **Every consumer falls back to today.** Weekend gate, redemption eligibility, reorder allowlist and
   the restaurant registry each degrade to their in-code constant on any failure — read error, timeout,
   un-migrated restaurant, or a version that predates the field. None of them can fail open.
3. **The landmine guard.** `catalog/no-code-authority.guard.test.js` fails the suite if any production
   file reads a retired constant as a live authority.

**Deploying the code is safe on its own.** The currently-active catalog versions predate this phase and
carry no `redeem_eligible_*` fields, so every gate reads "unauthored" and uses its static fallback —
today's exact behaviour. **The publish in step 4 is what actually activates the catalog-sourced gates.**
That is the step to be awake for.

**No Firestore rules change is required.** `meta/source` sits under `restaurants/{restaurantId}` with no
matching sub-rule and there is deliberately no recursive wildcard, so it is already deny-by-default to
clients. The server reads it through the Admin SDK, which bypasses rules. Do not add a rule "to be
safe" — a rule that grants read would world-expose the store.

**Prerequisites:** ADC configured for the production project (`gcloud auth application-default login`),
run from `xpizza-functions/`, on the merged 2a commit.

---

## 1. Pre-flight — everything green, nothing written

```bash
cd xpizza-functions
npm test                                  # expect EXIT 0
node tools/verify-catalog.js              # expect "production catalog == code tables ✓"
```

`verify-catalog` on a pre-2a store prints `no source store yet (pre-2a) — skipping store parity`. That
is expected here and **must** disappear after step 2.

**Stop if:** the suite is not EXIT 0, or `verify-catalog` reports any MISMATCH or COUNT line.

---

## 2. Seed the source store — writes the store, publishes nothing

```bash
node tools/seed-source-store.js
```

Expected exactly (these counts are what the current code holds — a different number means the store was
built from something other than today's menu, so stop and investigate):

```
x_pizza: 24 items + 14 extras — created
la_musa: 44 items + 14 extras — created
source store seeded — NOTHING published; run the parity suite, then publish --from-store
```

This writes `restaurants/{rid}/meta/source` only. **No version is created and no pointer moves**, so
production is still serving exactly what it served a minute ago. The command is idempotent: re-running
prints `unchanged (idempotent)` if the content matches.

**Rollback:** none needed — nothing is being read from the store yet. If the seed throws
(`source_malformed: …`), it wrote nothing; that message names the exact field.

---

## 3. Verify the store equals code — the no-op proof, before anything reads it

```bash
node tools/verify-catalog.js              # now expect "source store == code (build-parity ✓)" per brand
```

**Stop if** you see `parity_mismatch`. It names the differing field. The store and the code disagree,
so the cutover would not be a no-op — do not proceed to step 4.

---

## 4. Deploy the functions

```bash
firebase deploy --only functions
```

Still a no-op behaviourally: the active versions predate this phase, so every catalog-sourced gate reads
"unauthored" and uses its static fallback.

**Smoke-check before step 5** (this is the last easy stopping point):

- place a test order on X. Pizza → total correct, order lands
- place a test order on La Musa → total correct
- attempt an 18" NY pizza on a **weekday** → still rejected with the weekend message
- a redemption quote for a 12" pizza → still offered

**Rollback:** redeploy the previous functions revision. Nothing in Firestore has changed since step 2,
and the store is inert.

---

## 5. Publish from the store — the real cutover

```bash
node tools/publish-version.js --from-store
```

Expected, per brand:

```
x_pizza: parity gate PASSED — build-from-store is byte-identical to build-from-code
  x_pizza: published <versionId> — N items + M extras
```

The parity gate runs first. If it throws, **nothing was written and no pointer moved** — you are still
on the old version, safe, and the message names the differing field.

Once the pointer flips, propagation is bounded by the readers' TTLs: **45s** for the pricing pointer and
the gate reader, **5 min** for the restaurant registry. A warm instance picks up the new version within
those windows; a cold one reads it immediately.

---

## 6. Verify the cutover — the checks that matter

```bash
node tools/verify-catalog.js              # serving via active_version <new id>, both parities ✓
```

Then, in production, confirm each migrated consumer still behaves as it did yesterday:

| Consumer | Check | Expected (unchanged) |
|---|---|---|
| Pricing | order on both brands | totals identical to step 4 |
| **Weekend gate** (pre-charge) | 18" NY pizza on a weekday | still rejected, same Spanish message |
| Weekend gate | 18" NY pizza Fri/Sat/Sun | still accepted |
| **Reward eligibility** | redeem a 12" pizza | still offered and still redeemable |
| Reward eligibility | attempt to redeem an 18" NY pizza | still refused (`ineligible_item`) |
| Reward eligibility (La Musa) | redeem a dish, then a beer | dish offered; **beer refused** |
| Reorder | reorder a past order | same lines, same extras |
| Registry | both brands accept orders | no `unknown restaurant_id` |

**The La Musa beer check is the single most important line in this table.** Redemption eligibility for
La Musa moved from a denylist ("everything except `beer_*`") to a store-authored allowlist. If a beer
becomes redeemable, the allowlist is wrong and alcohol is being comped for free — roll back immediately.

Watch the logs for these, which mean a consumer is silently on its fallback rather than the catalog:

- `menu_gates_read_failed`, `menu_gates_unauthored`
- `redeem_eligibility_read_failed`, `redeem_eligible_malformed_set`
- `restaurant_registry_read_failed`
- `weekend_gate_malformed_set`

A handful during the propagation window is normal. A steady stream is not — the behaviour is still
correct (fallbacks are today's answers) but the migration is not actually live.

---

## 7. Rollback

The pointer flip is the only cutover, and it is atomic and reversible.

```bash
node tools/rollback-version.js --rid=x_pizza                 # LIST retained versions, changes nothing
node tools/rollback-version.js --rid=x_pizza --to=<versionId>  # one atomic flip back
node tools/verify-catalog.js
```

Roll back **both brands** if the cause is not clearly brand-specific. The target is explicit and never
inferred: mid-incident, after more than one publish, "the previous version" is ambiguous exactly when
being wrong is most expensive. The tool refuses an unretained or already-active target, and re-emits the
snapshot and RTDB mirror for the version rolled **to**.

Retention keeps at least 10 versions or 30 days, whichever is larger, so a rollback target exists.

**If rollback is not enough** — the store itself is wrong — redeploy the previous functions revision.
Every consumer then reads its in-code constant again, which is the pre-2a behaviour, regardless of what
the catalog says.

---

## 8. After the cutover

The store is now authoritative, which means **`menu-pricing.js` no longer changes anything a customer
sees.** Editing a price there and deploying will not change a price; it will only change what the parity
gate compares against, and the next `--from-store` publish will then fail the gate.

To change a price from here on: edit the store, then `node tools/publish-version.js --from-store`. The
gate will fail — correctly, because the store now differs from code. That is the point at which
`--from-store` needs its gate relaxed to allow intentional divergence, which is Phase 2b's work
(the portal write path). **Until 2b lands, treat the menu as frozen** rather than editing the store by
hand and defeating the gate.

### Known gaps, recorded not hidden

- `test/claim-order.emulator.test.js` and `test/claim-prefill.emulator.test.js` are referenced by no npm
  script. Pre-existing, claim-flow, unrelated to this phase; recorded in `KNOWN_UNWIRED` in the landmine
  guard, which requires that list to shrink and never grow. CI-hygiene task, not a 2a blocker.
- The landmine guard is static: it catches a code constant being read, not a reader-coupling bug or a
  per-brand short-circuit (the class that made the redemption gate inert for La Musa during Task 6, and
  which only a test that went through the reader could see). That class stays a review target.
