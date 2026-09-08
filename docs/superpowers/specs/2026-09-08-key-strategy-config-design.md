# Key-Strategy → Per-Merchant Config — Design Spec

**Date:** 2026-09-08
**Status:** DESIGN — awaiting owner review
**Why:** the item/extra **pricing key** is the money authority, and it's derived from a hardcoded `restaurantId === 'la_musa' ? id : name` ternary duplicated across six places. To make the platform (and the portal editor's write path) brand-agnostic — onboard a merchant by config, not code — that derivation must read a per-merchant flag. This unblocks the portal write slices (2b-2b/c/d) and a third delivery merchant.
**Prior art:** this is the **2a source-inversion pattern applied to keying** — config becomes the authority, the ternary becomes a frozen fallback, and the cutover is a parity-proven byte-identical no-op.

---

## 1. Goal

Move the item/extra/availability **key-derivation strategy** (name vs id) from hardcoded per-brand logic to a **per-merchant config flag**, read through one resolver, as a **byte-identical no-op for the two live brands** and **pure-config for any future merchant**.

**Non-goal (deferred, §9):** id-keyed *fiscal* (the factura line-pricer re-derives by name), and the *redemption model* axis (punch/single-name vs points/multiset-id) — a key flag alone does not generalize those.

---

## 1a. GLOBAL CONSTRAINTS (money-critical)

- **Byte-identical no-op for x_pizza + la_musa.** The seeded values already encode today's behavior (§2.1); the cutover must change *nothing* observable for the two live brands, proven against the existing parity suites.
- **Fail CLOSED on the money path.** A config-read failure rejects (`pricing_unavailable`), never guesses a key — matching `pricing-tables.js`. No new fail-open hole, no unbounded await.
- **The ternary survives as the FROZEN fallback,** not deleted — for legacy `tables=null` calculators and any pre-config version, exactly as `menu-pricing.js` is the frozen fallback post-2a.
- **BRAND-AGNOSTIC (hard):** after this, no `rid === 'la_musa'`/`'x_pizza'` literal decides a key anywhere except the single frozen-fallback helper. A third config-only merchant keys correctly with zero code change.
- **No-regression:** every existing parity/pricing/availability/fiscal/rewards suite stays green; money handlers and the 2a cutover path are otherwise untouched.

---

## 2. Grounding (source-mapped 2026-09-08 — file:line verified)

### 2.1 The headline: the config already exists, unread
`pricing_key_mode` = `'name'` (x_pizza) / `'id'` (la_musa) is **already written to each restaurant's profile doc** by the seed (`tools/seed-catalog.js:18-19`), allowlisted (`catalog/seed-catalog-core.js:25`), and pinned by test to match the live resolver (`catalog/seed-catalog-core.test.js:28-31`). **Nothing reads it** — every key decision is still the ternary. So this is *wiring a flag that's already in production*, not a data migration.

### 2.2 The six derivation sites (all must read one config or the fallback)
- `menu-pricing.js:127` `itemPricingKey(item, rid)` — the canonical money-path resolver.
- `catalog/form-menu-source.js:109` `pricingKeyOf(rid, dish)` — build/seed side.
- `catalog/source-store.js:20` `extrasKeyOf(rid, display)` — extras.
- inline `byId = rid === 'la_musa'` branches: `menu-pricing.js:165,244`, `reorder-normalize.js:25`.

### 2.3 Consumers, and the re-derivers (the risk surface)
- **Central-resolver consumers (safe):** `computeServerTotal` (order total), `summaryLines` (tracker cents), `checkItemAvailability` (86 gate), `reorder-normalize` — all via `itemPricingKey`.
- 🔴 **Re-derivers (hardcode the key, don't call the resolver):** `factura/pricing.js:19,21,42,52` keys **only by name** (safe *only* because `usesPlatformFactura = {x_pizza}`); `catalog/source-store.js:70,87` `validateSource` re-derives via `pricingKeyOf`/`extrasKeyOf` (a *second* authority on the rule); `buildCatalogV2` + `seed-source-store` re-derive on the build side.
- **Key-agnostic (read the stored `key` — safe):** `catalog-transform`, `seed-catalog-core` (`docId(key)`), factura `build-record`, availability-reset, the KDS write (`setItemAvailability` takes a caller-supplied raw key).

### 2.4 The rename coupling (fiscal-sensitive — preserve exactly)
Because x_pizza keys by name, **renaming an item changes its pricing key** — asserted in `source-store.js:68-71` (`pricingKeyOf(rid, display) === it.key`) and `form-menu-source.js:107`. For `keyMode:'name'` the key *is* the display name (a rename is a reprice/new-key, which fiscal depends on); for `keyMode:'id'` the key is the stable slug (rename-safe). `validateSource`'s `derived === it.key` check must derive through the **configured** mode, never a fixed ternary.

---

## 3. Scope

**In:** the item/extra/availability/build/validate key derivation → per-merchant config, byte-identical no-op, `id` default for new merchants. **NOTE (codex major):** the same `byId` flag today also selects the *extras cardinality model* (`id ⇒ qty-aware/standalone/dedup`, `name ⇒ count-once`); `keyMode` therefore currently *also* selects it, and only those two combos are supported (byte-identical for x_pizza/la_musa). Decoupling the extras model is a deferred axis (§9.3), and the plan asserts the supported combinations rather than silently generalizing.
**Out (§9):** id-keyed platform-fiscal; the redemption-model config axis.

---

## 4. Design

### 4.1 One resolver, config-or-fallback
Give each derivation function an explicit `keyMode` parameter that, **when absent, falls back to the single frozen helper**:

```
// the ONLY place the brand ternary survives — the frozen bootstrap default
function defaultKeyMode(rid) { return rid === 'la_musa' ? 'id' : 'name'; }   // ← frozen fallback

function itemPricingKey(item, rid, keyMode) {
  const mode = keyMode || defaultKeyMode(rid);
  return mode === 'id' ? (item && item.id) : (item && item.name);
}
// extrasKeyOf(rid, display, keyMode) and pricingKeyOf(rid, dish, keyMode) identically.
```

All six sites collapse to: the three resolver functions (read `keyMode`) + `defaultKeyMode` (the one frozen ternary). No other brand literal decides a key.

### 4.2 `keyMode` lives IN THE SOURCE it was built from — one value, no drift
**Codex money-gate blocker (2026-09-08):** an earlier draft had *publish* read the profile separately from *build*, so a profile flip between build and publish could snapshot a `keyMode` that disagrees with the keys actually stored — rejecting every order. Fix: **`keyMode` is a field of the source** (`meta/source`), set once when the source is built/seeded, and *everything downstream uses that one value* — the profile is read ONLY at build/seed time to set it.

- **BUILD / SEED:** a source's `key_mode` is set **from the merchant's profile `pricing_key_mode`** — the authority — and written into `source` as `source.key_mode`. Two seed rules (codex minor, round-3): (i) the **legacy code-seed of x_pizza/la_musa** (`seed-source-store.js`) may derive `source.key_mode` from `defaultKeyMode(rid)`, which *equals* their already-seeded profile value → byte-identical; (ii) **generic merchant source creation MUST read/pin `pricing_key_mode` from the profile**. `validateSource` derives `it.key` / `ex.key` **through `source.key_mode`** — the stored keys and the source's `keyMode` are provably the same value (a source whose `key_mode` contradicts its keys fails). Legacy sources with no `key_mode` → `defaultKeyMode(rid)` fallback → byte-identical, until re-seeded/edited.
- **PUBLISH (snapshot from the source, NOT a fresh profile read):** `publishVersion` snapshots `source.key_mode` (the exact value the keys were built with) into the **version record**. No profile read at publish → no drift.
- **SERVING / MONEY path (zero new reads):** `readVersionDocs` returns `keyMode` from the version record it already reads (`recSnap` — confirmed `catalog-firestore.js:62-64`); **`createCatalogReader` (`catalog/catalog.js:41,47` — the actual tables constructor) attaches it to the cached tables** `{menu, extras, versionId, seq, keyMode}`; `resolvePriceTables` carries it; `computeServerTotal`/`summaryLines`/`checkItemAvailability` read it. A pre-snapshot version has `keyMode` absent → `defaultKeyMode` → byte-identical.
- **ROLLBACK (must carry it too):** rollback re-derives the snapshot/mirror from `readVersionDocs → snapshotOf → writeMirror` (`catalog-publish.js:261-267`); `snapshotOf` carries `keyMode` in the rollback flow exactly as in publish, so a rollback never strips or drifts it.

One `keyMode` per source, threaded source → version → serving, with `defaultKeyMode(rid)` as the frozen fallback wherever it's absent.

### 4.3 The factura invariant — assert the EFFECTIVE mode (don't false-reject live x_pizza)
`factura/pricing.js` re-derives by name unconditionally and is safe only because the fiscal brand is name-keyed. This design **adds an assertion** rather than solving id-fiscal: wherever `usesPlatformFactura(rid)` is true, assert the **effective** mode is name.
**Codex money-gate blocker (2026-09-08):** it must be `(keyMode || defaultKeyMode(rid)) === 'name'`, **not** raw `keyMode === 'name'` — current live x_pizza versions have no snapshot yet, so `keyMode` is `undefined`, and a raw check would **reject every live factura on deploy**. The assertion goes before **both** non-redeem `pricedLineItems` call sites (`index.js:898,1361`) **and** the redeemed `applyXPizza` path (`rewards-redeem-pricing.js:46`) — no path reaches the name-keyed pricer unguarded. Today's invariant holds (x_pizza effective mode = name); a future id-keyed fiscal merchant is explicitly blocked until §9.1 routes the factura pricer through the configured key.

### 4.4 New-merchant default
A newly onboarded merchant's profile gets `pricing_key_mode: 'id'` (stable slug) — the recommended default; onboarding is pure config.

---

## 5. Money-safety invariants (the gate checks these)
1. **No behavior change for x_pizza/la_musa** — proven byte-identical (§6).
2. **Config is authority; ternary is frozen fallback** — the fallback is reachable only when `keyMode` is absent, and reproduces today's mapping.
3. **Serving adds no read / no fail-open** — `keyMode` rides the version the money path already reads; a config-read failure on the build/publish side fails closed.
4. **Rename coupling preserved** — `validateSource` derives through the configured mode; `keyMode:'name'` keeps key ≡ name.
5. **Fiscal invariant** — `usesPlatformFactura ⇒ (keyMode || defaultKeyMode(rid)) === 'name'` (EFFECTIVE mode), asserted before every name-keyed factura pricer.
6. **One frozen ternary** — `defaultKeyMode` is the only surviving brand literal that decides a key.

---

## 6. No-op proof + cutover (2a-grade)
- **No data migration** — x_pizza `'name'` / la_musa `'id'` are already the seeded `pricing_key_mode` and already equal the ternary output.
- **Regression test (the missing bridge):** `seed-catalog-core.test.js:28-31` today only asserts the seeded string equals the ternary; **extend it so the resolver, driven by `keyMode`, produces the same keys** — the proof the flag is now *honored*, not just present.
- **Parity surface to hold green:** `menu-parity.test.js`, `menu-pricing-catalog.test.js:65`, `availability-gate.test.js:104,112`, `catalog-schemav2.test.js:76`, `source-store.test.js`, `publish-parity.test.js`, `verify-vs-active.test.js`, the `*-catalog-cutover` + `*-parity.guard` suites, and the emulator `pricing-cutover` / `catalog-parity` / `intake-availability` tests.
- **Cutover is trivially safe:** deploying the resolver change is a no-op for both brands (serving versions have no snapshot → fallback → today). The snapshot begins populating on the next publish. No flip, no forced republish.

---

## 7. Components / decomposition (buildable slices)
- **Task 1 — the resolver + frozen fallback.** `defaultKeyMode` + `keyMode` param on `itemPricingKey`/`extrasKeyOf`/`pricingKeyOf`; route the inline `byId` branches through it. Byte-identical unit proof (keyMode omitted ⇒ ternary). *Gate: no derivation site left on a raw literal; fallback reproduces today.*
- **Task 2 — serving read.** `catalog-firestore` returns `keyMode`; `resolvePriceTables` carries it on the tags object; `computeServerTotal`/`summaryLines`/`checkItemAvailability` pass it. Absent-snapshot ⇒ fallback. *Gate: no new per-order read, no fail-open, byte-identical serving.*
- **Task 3 — publish + rollback snapshot.** `publishVersion` (and the rollback flow) snapshots `source.key_mode` → the version record — NOT a fresh profile read. *Gate: snapshot matches stored keys; rollback carries it; pre-snapshot versions unaffected.*
- **Task 4 — build/validate side.** `buildCatalogV2` / `seed-source-store` / `validateSource` derive through the profile's configured mode (fail-closed). *Gate: a config-only third merchant validates + builds; rename coupling intact.*
- **Task 5 — fiscal invariant.** Assert `usesPlatformFactura ⇒ keyMode==='name'`. *Gate: today passes; an id-keyed fiscal is rejected.*
- **Task 6 — the honored-flag regression test + full parity sweep + emulator no-op.** *Gate: the whole §6 surface green; the bridge test proves the resolver reads the mode.*

Each: TDD, LOCAL-ONLY (executor), per-task advisor audit + the **heaviest codex money-gate**, owner deploys (no-op).

---

## 8. Testing
- **Unit:** `keyMode` omitted ⇒ ternary (both brands); a hypothetical `merch_3: 'id'` keys by id with no code change; rename under each mode (name ⇒ new key, id ⇒ stable).
- **Integration/parity:** the full §6 surface stays byte-identical; the extended bridge test.
- **Regression guards:** serving adds no read (assert the money path reads `keyMode` from the version, not the profile); fiscal-invariant guard; the frozen-fallback is the only brand literal deciding a key (grep-guard).

---

## 9. Deferred (each its own spec → plan → gate)
1. **id-keyed platform fiscal** — route `factura/pricing.js` through the configured key so an id-keyed merchant can carry a SAR factura. Until then, §4.3 asserts the invariant.
2. **Redemption model as a config axis** — punch/single-name vs points/multiset-id is a *model*, not a key; making redemption brand-agnostic is separate work (`rewards-redeem.js`, `rewards-redeem-pricing.js`).
3. **Extras cardinality/quantity model as a config axis** — `byId` (`menu-pricing.js:189-222`) couples id-vs-name keying with qty-aware/dedup vs count-once extras. This slice keeps them coupled (id⇒qty-aware, name⇒count-once — the only supported combos, asserted) and defers a standalone `extras_model` flag so a third id-keyed merchant could choose count-once.

---

## 10. Resolved decisions
- **Scope → key strategy only** (owner-approved 2026-09-08); id-fiscal + redemption-model deferred.
- **Config home → profile `pricing_key_mode` is the seed-time SOURCE of truth; the built `source` carries `key_mode` (set from it), and the version snapshots the source's value** — so build/validate/publish/serve/rollback all use the ONE value the keys were built with (no build↔publish drift — codex blocker). The money path reads it version-pinned via `createCatalogReader`, adding no read.
- **Frozen fallback → keep the ternary as `defaultKeyMode`,** the only surviving key-deciding brand literal.
- **New-merchant default → `id`.**
