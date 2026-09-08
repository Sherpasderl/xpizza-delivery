# Key-Strategy → Per-Merchant Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes. Governance: **executor builds LOCAL-ONLY**; advisor source-audits + **HEAVIEST codex money-gate** each task; **owner** deploys (a byte-identical no-op). Do NOT push/deploy.

**Goal:** Make the item/extra/availability pricing-key derivation read a per-merchant `keyMode` (from the already-seeded `pricing_key_mode`), as a byte-identical no-op for x_pizza+la_musa and pure-config for any future merchant.

**Architecture:** One resolver reads `keyMode`; a single `defaultKeyMode(rid)` frozen fallback is the only surviving brand literal. `keyMode` lives in the **source** (`source.key_mode`, set from the profile at build), is snapshotted from the source into the **version** at publish + rollback, and serving reads it version-pinned (no new per-order read). Fiscal asserts `usesPlatformFactura ⇒ (keyMode || defaultKeyMode(rid)) === 'name'` (effective mode). `keyMode` drives ONLY the key — the coupled extras-cardinality model stays as-is (deferred axis).

**Tech Stack:** Node, Firebase Cloud Functions, Firestore (catalog versions + profile).

## Global Constraints (money-critical — every task)

- **BYTE-IDENTICAL no-op for x_pizza+la_musa** — the seeded `pricing_key_mode` already equals the ternary; prove nothing observable changes (§6 parity surface of the spec).
- **Fail CLOSED on the money path**; the ternary survives as `defaultKeyMode` (frozen fallback), never deleted; serving adds **no new read**.
- **BRAND-AGNOSTIC:** after this, no `rid === 'la_musa'`/`'x_pizza'` literal decides a key except `defaultKeyMode`. A config-only third merchant keys correctly with zero code change.
- **No-regression:** all existing pricing/availability/fiscal/rewards/parity suites stay green.
- **Test cmd (from `xpizza-functions/`):** `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test`
- **Spec:** `docs/superpowers/specs/2026-09-08-key-strategy-config-design.md`.

---

## File Structure
- Modify `menu-pricing.js` — `defaultKeyMode`, `itemPricingKey(item,rid,keyMode)`, thread `keyMode` through `resolvePriceTables`/`computeServerTotal`/`summaryLines` + the inline `byId` branches.
- Modify `catalog/source-store.js` (`extrasKeyOf(rid,display,keyMode)`, `validateSource` derive-through-mode) + `catalog/form-menu-source.js` (`pricingKeyOf(rid,dish,keyMode)`, `buildCatalogV2`).
- Modify `availability-gate.js`, `reorder-normalize.js` — pass `keyMode`.
- Modify `catalog/catalog-firestore.js` — return `keyMode` from the version record; thread into the serving tables.
- Modify `catalog/catalog-publish.js` — snapshot `pricing_key_mode` into the version record + snapshot.
- Modify `factura/pricing.js` (or its call site) — the `usesPlatformFactura ⇒ name` assertion.
- Modify `tools/seed-source-store.js` — derive through config.
- Extend `catalog/seed-catalog-core.test.js` — the honored-flag bridge test.

---

## Task 1: The resolver + frozen fallback (pure, byte-identical)

**Files:** Modify `menu-pricing.js:127`, `catalog/form-menu-source.js:109`, `catalog/source-store.js:20`; Test: `menu-pricing.test.js` (+ a new `key-strategy.test.js`).

**Interfaces — Produces:** `defaultKeyMode(rid) → 'name'|'id'`; `itemPricingKey(item, rid, keyMode?)`, `pricingKeyOf(rid, dish, keyMode?)`, `extrasKeyOf(rid, display, keyMode?)` — `keyMode` optional, absent ⇒ `defaultKeyMode(rid)`.

- [ ] **Step 1: Failing test** (`catalog/key-strategy.test.js`)

```js
const { itemPricingKey, defaultKeyMode } = require('../menu-pricing');
// 1. keyMode ABSENT ⇒ today's ternary, both brands (the no-op guarantee)
assert.strictEqual(itemPricingKey({ id: 'i', name: 'N' }, 'x_pizza'), 'N');
assert.strictEqual(itemPricingKey({ id: 'i', name: 'N' }, 'la_musa'), 'i');
// 2. explicit keyMode drives it
assert.strictEqual(itemPricingKey({ id: 'i', name: 'N' }, 'x_pizza', 'id'), 'i');
assert.strictEqual(itemPricingKey({ id: 'i', name: 'N' }, 'la_musa', 'name'), 'N');
// 3. a THIRD config-only merchant keys by id with NO brand literal
assert.strictEqual(itemPricingKey({ id: 'i', name: 'N' }, 'merch_3', 'id'), 'i');
assert.strictEqual(defaultKeyMode('merch_3'), 'name');  // frozen fallback default for an unknown rid
assert.strictEqual(defaultKeyMode('la_musa'), 'id');
```

- [ ] **Step 2: Run → FAIL** (`node catalog/key-strategy.test.js`).

- [ ] **Step 3: Implement** in `menu-pricing.js`:

```js
// the ONLY surviving brand literal that decides a key — the frozen bootstrap default (post-2a pattern)
function defaultKeyMode(restaurantId) { return restaurantId === 'la_musa' ? 'id' : 'name'; }
function itemPricingKey(item, restaurantId, keyMode) {
  const mode = keyMode || defaultKeyMode(restaurantId);
  return mode === 'id' ? (item && item.id) : (item && item.name);
}
```
Mirror in `form-menu-source.js` (`pricingKeyOf(rid,dish,keyMode)`) and `source-store.js` (`extrasKeyOf(rid,display,keyMode)`), each `const mode = keyMode || defaultKeyMode(rid)`; export `defaultKeyMode` from `menu-pricing.js` and import it (single definition). Route the inline `byId` branches (`menu-pricing.js:165,244`, `reorder-normalize.js:25`) to `const byId = (keyMode||defaultKeyMode(rid)) === 'id'`.
  - **⚠️ codex major #3 — `byId` couples KEY + extras MODEL.** At `menu-pricing.js:189-222` / `:257-273` / `reorder-normalize.js:36-58`, `byId` also selects the extras cardinality model (`id ⇒ qty-aware/standalone/dedup`, `name ⇒ count-once`). Routing it through `keyMode` is acceptable ONLY because the two supported combos (`id`+qty-aware, `name`+count-once) are byte-identical for x_pizza/la_musa. **Add a guard-test asserting exactly those two combos are the supported set** (a `keyMode:'id'` merchant gets qty-aware extras — documented, not silently generalized); decoupling is deferred (§9.3 of the spec). Do NOT introduce a third combo here.

- [ ] **Step 4: Run → PASS**; then `node menu-pricing.test.js` (unchanged behavior) → PASS.
- [ ] **Step 5: Commit** — `feat(pricing): keyMode-aware resolver + frozen defaultKeyMode fallback (no-op)`

---

## Task 2: Serving reads keyMode from the version — via createCatalogReader, no new read

**Files:** Modify `catalog/catalog-firestore.js:60-77` (`readVersionDocs` returns `keyMode`; `getRestaurantDocs` flat path returns `undefined`), **`catalog/catalog.js:41,47` (`createCatalogReader` — the ACTUAL tables constructor; codex major)**, `menu-pricing.js` (`resolvePriceTables`/`computeServerTotal`/`summaryLines`); Test: `catalog/catalog.test.js`, `snapshot-fallback.test.js`, `quote-order.test.js`.

**Interfaces — Consumes:** `itemPricingKey(...,keyMode)`. **Produces:** the cached tables object gains `keyMode`: `{ restaurantId, menu, extras, versionId, seq, keyMode }`.

- [ ] **Step 1: Failing test** — (a) `readVersionDocs` surfaces `keyMode` from the version record (`record.key_mode`), undefined-safe; (b) **`createCatalogReader` carries `keyMode` into the cached tables across ALL four paths — cold read, version-cache hit, flat fallback, pointer-probe warm hit** (codex major: unless the constructor carries it, `resolvePriceTables` never sees it); (c) `computeServerTotal(items, rid, tablesWithKeyMode)` keys by `tables.keyMode`; (d) a tables object WITHOUT `keyMode` (pre-snapshot version) keys by `defaultKeyMode(rid)` — byte-identical:

```js
const legacyTables = { restaurantId:'la_musa', menu:{ i1:100 }, extras:{} };            // no keyMode
assert.strictEqual(computeServerTotal([{ id:'i1', qty:1 }], 'la_musa', legacyTables).total, 100);
// (e) FLAT path: a pre-publish merchant with profile pricing_key_mode:'id' surfaces keyMode:'id' (not undefined→name)
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - `catalog-firestore.js:64` already reads `record = recSnap.data()` — add `keyMode: record.key_mode` to the `readVersionDocs` return (`:77`). **`readFlatDocs`/`getRestaurantDocs` (`:83`) already reads the profile → return `keyMode: profile.pricing_key_mode` (codex major #1 round-3) so a pre-publish id-keyed merchant serves id-correct — NO new read.** Neither path adds a profile read that wasn't already happening.
  - **`createCatalogReader` (`catalog.js:41,47`) destructures `keyMode` from the docs source and attaches it to the object it builds AND caches** — so every warm/cold/flat path carries it.
  - `resolvePriceTables` returns `keyMode: tables ? tables.keyMode : undefined`; `computeServerTotal` computes `const keyMode = resolved.keyMode` once and passes it to every `itemPricingKey`/extras keying; same for `summaryLines`.
- [ ] **Step 3b: Outage ladder carries keyMode (codex major #1).** The last-good + mirror fallback ladder returns `{menu, extras}` only — on a Firestore timeout an id-keyed merchant would price under the wrong effective mode. Carry `keyMode` through `pricing-tables.js` `recordGood`/`lastGood` + `createPricingResolver`'s ladder return, and `snapshot-fallback.js:87-126` mirror payload validation/return. Test: a degraded/last-good/mirror read still surfaces `keyMode` (absent ⇒ fallback, byte-identical for both brands).
- [ ] **Step 4: Run → PASS**; full `npm test` → EXIT 0 (serving byte-identical, incl. the degraded ladder).
- [ ] **Step 5: Commit** — `feat(pricing): serving + outage-ladder read keyMode (no new read, no-op)`

---

## Task 2b: Availability call sites pass keyMode (codex major #4)

**Files:** Modify `availability-gate.js:26` (`checkItemAvailability` signature), `index.js:737,1256` (the intake call sites); Test: `availability-gate.test.js`.

- [ ] **Step 1: Failing test** — `checkItemAvailability(db, items, restaurantId, keyMode)` derives the availability key via `itemPricingKey(it, restaurantId, keyMode)`; with `keyMode` absent, byte-identical to today (both brands, pinned like `availability-gate.test.js:104,112`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add the `keyMode` param; **all THREE call sites** pass it from the already-resolved `pricingTables` (no new read): `index.js:737,1256` (order intake) **and `rewards-redeem-intake.js:70-72`** (the redeemed free-item 86 gate — codex major #2, missed in the first draft). Availability key must never drift from the pricing key.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(availability): thread keyMode from pricingTables to the 86 gate`

---

## Task 3: Publish + ROLLBACK snapshot keyMode FROM THE SOURCE (codex blockers #1, #2)

**Files:** Modify `catalog/catalog-publish.js:53` (`snapshotOf`), `:188` (`writeVersion`), the `publishVersion` entry, **and the ROLLBACK flow `:261-267` (`readVersionDocs → snapshotOf → writeMirror`)**; Test: `catalog/publish-parity.test.js`.

- [ ] **Step 1: Failing test** — (a) publishing writes `key_mode` onto the version record AND the snapshot, taken from **`source.key_mode`** (the value the keys were built + validated against — NOT a fresh profile read, which could drift; codex blocker #1); a source without `key_mode` (legacy) writes nothing → serving fallback; (b) **rollback to a prior version re-emits its snapshot/mirror carrying that version's `key_mode`** (codex blocker #2 — rollback is production serving state; stripping keyMode would misprice a config merchant).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**
  - `writeVersion` (`:188`) receives `key_mode` (from the source build input, Task 4) and writes it on the version record; `snapshotOf` (`:53`) carries it: `{version, seq, rid, menu, extras, key_mode, at}`. The `--from-store` CLI path (2a cutover) carries it identically.
  - **Rollback** (`:261-267`): `readVersionDocs` already returns `keyMode` (Task 2); pass it through `snapshotOf`/`writeMirror` so a rollback re-materializes the same `key_mode` the rolled-back version was published with. No profile read anywhere in publish OR rollback.
- [ ] **Step 4: Run → PASS**; `node catalog/publish-parity.test.js` + `node catalog/verify-vs-active.test.js` + `node snapshot-fallback.test.js` → PASS.
- [ ] **Step 5: Commit** — `feat(catalog): snapshot source.key_mode into published + rolled-back versions`

---

## Task 4: `key_mode` is a field of the SOURCE — set at build, validated against (codex blocker #1)

**Files:** Modify `catalog/source-store.js` (`validateSource`:68-88 + the source schema/allowlist), `catalog/form-menu-source.js` (`buildCatalogV2`), `tools/seed-source-store.js:33,47`, `catalog/seed-catalog-core.js` (write `key_mode` into the built source); Test: `catalog/source-store.test.js`.

**Interfaces — Produces:** `source.key_mode` (`'name'|'id'`), set from the profile `pricing_key_mode` when a source is built/seeded; the single value every downstream step (validate, publish snapshot, serving) uses. This is the value Task 3 snapshots.

- [ ] **Step 1: Failing test** — (a) a config-only `merch_3` source with `key_mode:'id'` **validates** (keys derived by id) and **builds**; (b) a source whose `key_mode` **contradicts its stored keys FAILS** (e.g. `key_mode:'name'` but keys are the ids) — proving `validateSource` derives through `source.key_mode`, so the stored keys and the mode can never disagree (this is what closes the build↔publish drift); (c) a rename under `name` mode yields a NEW key (fiscal-critical), under `id` mode a stable key; (d) a legacy source with **no** `key_mode` validates via `defaultKeyMode(rid)` — byte-identical.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement — the EXACT seam (codex major #4):** (a) `tools/seed-source-store.js:77` writes `key_mode` into the source object `{restaurant_id, schema_version, key_mode, items, extras, structure}`. **Seed rule (codex minor round-3):** the 2 legacy code-seeded brands derive `key_mode = defaultKeyMode(rid)` (= their profile value, byte-identical); **generic merchant source creation MUST read/pin `pricing_key_mode` from the profile** — the config authority, not a fallback. (b) `catalog/source-store.js:154` `sourceToBuildInputs(source)` propagates `source.key_mode` into the build inputs so `publishVersion`/`publish-version.js --from-store` carry it (Task 3). (c) `validateSource` reads `source.key_mode` (fallback `defaultKeyMode(rid)`) and passes it to `pricingKeyOf`/`extrasKeyOf` so the `derived === it.key` check (`source-store.js:71,87`) derives through the configured mode; `buildCatalogV2` derives identically. (d) Allowlist `key_mode` in `SOURCE_COVERED_LITERALS` / the source schema.
- [ ] **Step 4: Run → PASS**; the full catalog/source suite → PASS.
- [ ] **Step 5: Commit** — `feat(catalog): key_mode is a source field, keys validated against it`

---

## Task 5: Fiscal invariant — usesPlatformFactura ⇒ EFFECTIVE mode is name (codex major #5)

**Files:** Modify the factura pricing call sites `index.js:898,1361` (non-redeem `pricedLineItems`) **and** `rewards-redeem-pricing.js:46` (`applyXPizza`, redeemed); Test: `factura/pricing.test.js`.

- [ ] **Step 1: Failing test** — (a) a name-keyed fiscal brand (x_pizza) prices a factura fine; (b) **a current x_pizza version with `keyMode` ABSENT (pre-snapshot) still passes** — the assertion resolves the effective mode, it does NOT false-reject live facturas (codex major #5: raw `keyMode==='name'` would reject every live x_pizza factura on deploy); (c) a (hypothetical) id-keyed brand with `usesPlatformFactura` true throws `fiscal_key_mode_unsupported` (fail closed), NOT a mispriced line.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — before EACH name-keyed factura pricer (both non-redeem `pricedLineItems` call sites AND `applyXPizza`), assert `!usesPlatformFactura(rid) || (keyMode || defaultKeyMode(rid)) === 'name'` else throw fail-closed. Assert on the **effective** mode (`keyMode || defaultKeyMode(rid)`), never raw `keyMode`. No path reaches the name-keyed pricer unguarded.
- [ ] **Step 4: Run → PASS**; `node factura/pricing.test.js` + `node factura/eligibility.test.js` + `node rewards-redeem-pricing.test.js` → PASS.
- [ ] **Step 5: Commit** — `feat(factura): fence non-name fiscal on the EFFECTIVE key mode (both paths)`

---

## Task 6: The honored-flag regression test + full parity sweep

**Files:** Modify `catalog/seed-catalog-core.test.js:26-33`; then the full suite + emulator.

- [ ] **Step 1: Extend the bridge test** — it currently asserts the seeded string equals the ternary. Add: `itemPricingKey(probe, rid, mode)` (driven BY the mode) equals `probe[mode]`, AND `itemPricingKey(probe, rid)` (absent) equals the same — proving the flag is now *honored*, not merely present.
- [ ] **Step 2: Full parity sweep** — `npm test` EXIT 0; then the emulator no-op: `npm run test:rules`-style emulator suites `pricing-cutover` / `catalog-parity` / `intake-availability` (from `xpizza-functions/`, openjdk on PATH). Every §6 spec suite green.
- [ ] **Step 3: Scoped guard (codex minor #6)** — assert no KEY-DECIDING `=== 'la_musa'`/`'x_pizza'` literal survives except in `defaultKeyMode`. **Scope the guard to the key-derivation functions** (`itemPricingKey`, `pricingKeyOf`, `extrasKeyOf`, the `byId` branches) — NOT a blanket grep. Legitimate non-key brand branches stay allowed and must not trip it: `weekendOnlyViolation` (`menu-pricing.js:62`), redemption model (`redeem-source.js:22`, `rewards-redeem-pricing.js:31`), display, and routing. The guard catches a re-introduced *key* literal, not all brand behavior.
- [ ] **Step 4: Commit** — `test(pricing): honored-keyMode regression + parity sweep`

---

## Self-Review
- **Spec coverage:** resolver+fallback → T1; serving-no-new-read → T2; publish snapshot → T3; build/validate → T4; fiscal invariant → T5; honored-flag + no-op proof → T6. All §7 tasks mapped.
- **Placeholder scan:** none — every step has concrete code or a concrete command.
- **Type consistency:** `keyMode` is the same optional 3rd param on `itemPricingKey`/`pricingKeyOf`/`extrasKeyOf`; `defaultKeyMode(rid)` single definition in `menu-pricing.js`, imported elsewhere; the serving tag object gains `keyMode` consistently (T2) and the version record/snapshot carry `pricing_key_mode` (T3).
- **Money-safety:** the no-op is proven three ways — keyMode-absent ⇒ ternary (T1 unit), pre-snapshot version ⇒ fallback (T2 unit), full parity sweep (T6). Serving adds no read (T2 asserts keyMode rides the version). Fiscal fenced (T5). Frozen fallback is the only surviving literal (T6 grep-guard).

## Execution Handoff
Per governance, built by the executor session, gated by the advisor's **heaviest codex money-gate** (this is the pricing authority), then the owner deploys — a byte-identical no-op (serving versions have no snapshot → fallback → today; the snapshot populates on the next publish). Relay after the codex design-grill folds.
