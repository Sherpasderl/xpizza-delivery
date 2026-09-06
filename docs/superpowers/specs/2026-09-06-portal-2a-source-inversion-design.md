# Merchant Portal — Phase 2a: The Complete Source Inversion (code → data) — Design

**Date:** 2026-09-06 · **Surface:** `xpizza-functions/` (catalog build + publish + every menu-derived server consumer) — **backend only, NO UI.** **Type:** the pricing/menu source-of-truth migration. **🔴 MONEY/FISCAL-ADJACENT — codex-gate HARDEST.** Part of [[merchant-portal-initiative]]; the foundation the editor UI (2b) sits on. **Robustness bar (owner): airtight, end-to-end, no silent-drift landmines — a build that looks like it cost a billion dollars.** Refined after a codex design-grill (REVISE → all findings folded in).

## Goal
Make an editable Firestore store `restaurants/{rid}/source` the **single authority for everything menu-derived** — the publish pipeline AND every server consumer that reads menu membership/prices/categories today from `menu-pricing.js` or the form's embedded literals. Cut over as a **provable no-op** (store seeded from code → build-from-store proven byte-identical to build-from-code, per brand, as a hard pre-flip gate). After 2a, **`menu-pricing.js` is a frozen bootstrap/fallback only** — and there is **no production path that silently defaults to stale code once the store is edited.** No UI, no write-validation surface yet (2b); the CLI remains the publish trigger and no *actual* menu edit happens in 2a (2a only proves the inverted pipeline reproduces today's menu).

## Current state (verified + grill-confirmed)
Menu source is **split across two code locations**: prices in `menu-pricing.js` (`MENU_BY_RESTAURANT` `{key→price}`, key = `dish.name` x_pizza / `dish.id` la_musa; `EXTRAS_BY_RESTAURANT`), structure/display parsed from the form `index.html` text via `buildCatalogV2`'s `readLiteral(...)`. `publish-version.js` → `buildCatalogV2(rid, opts)` (already source-agnostic: `opts.priceTable` + `opts.formSource`) → `{items, structure}` → `publishVersion(...)` (writeVersion → readVersionDocs[counts+both hashes] → verifyVersionStructure → **atomic** flipPointer → mirror). **The live resolver/serving path is independent of the publish input (grill C4 confirmed)** — post-2c the catalog serves authoritatively, `menu-pricing.js` is only the ladder's deep fallback.

## The data-source store (COMPLETE schema — grill C1)
**Path:** `restaurants/{rid}/source` (Firestore) — server-only (same posture as `catalog_snapshot`; 2b writes via a Cloud Function, never client-direct). Must hold **everything** the build + every consumer needs — a missing field is silent divergence:
```
restaurants/{rid}/source = {
  schema_version: 1,
  items: [ {id, cat, name, price, emoji, color, desc, img?, has_photo?, tags?, ...verbatim display} ],  // the form MENU array, EXACT, order preserved
  item_order: [ <pricingKey>... ],                 // explicit — Firestore returns hashed-id order (grill C2)
  prices:  { <pricingKey> : <int lempiras> },       // = MENU_BY_RESTAURANT[rid]
  extras:  {                                        // FULL extras shape (grill C1), not just key→price:
    prices: { <key> : <int> },                      //   = EXTRAS_BY_RESTAURANT[rid]
    display: [ ... ],                               //   the form EXTRAS display array(s)
    by_category?: { ... },                          //   la_musa EXTRAS_BY_CATEGORY
    by_item?: { ... },                              //   la_musa EXTRAS_BY_ITEM
  },
  categories: [ {id, name?, subcats?, layout?}... ],// CATEGORIES, in order
  variant_items: { <launcherId>:[<variantId>...] }, // VARIANT_ITEMS
  pickup_only_cats: [...], weekend_only_cats: [...],
  redeem_eligible?: {...},                          // reward-eligibility source (see consumers) — brand-shaped
}
```
`pricingKey` = `name` (x_pizza) / `id` (la_musa), per `pricingKeyOf`. **Canonical serialization** (stable key ordering) is defined explicitly so store-authored nested objects reproduce the same descriptor/hashes the code path produces (grill C2 — the byte proofs are `deepStrictEqual`+JSON; property order must be pinned).

## Components
1. **Store schema + reader** (`catalog/source-store.js`): `readSource(db, rid)` → the object above; **throws on missing/malformed** (fail-closed, never partial). `sourceToBuildInputs(source)` → `{priceTable, formData, extras}` where `formData` is the **structured** equivalent of the parsed literals. `validateSource(source)` — a strict schema/shape/price-type check (positive-int prices, required fields, key↔item bijection) reused by both the seed and (later) 2b writes.
2. **`buildCatalogV2` structured path**: add `opts.formData` (structured) as an alternative to `opts.formSource` (text); when given, use it directly (no `readLiteral`). **Must produce identical `{items, structure}`** as the text path — proven by test.
3. **Seed migration** (`tools/seed-source-store.js`, idempotent): assemble the store from `menu-pricing.js` + the form literals (via existing `formSource`/`readLiteral`) and write `restaurants/{rid}/source`; re-runnable; logs a diff if an existing store differs.
4. **Publish-from-store** (`publish-version.js` gains a `--from-store` path, becomes the default after cutover): build `{priceTable, formData, extras}` via `readSource`+`sourceToBuildInputs` → `buildCatalogV2(rid,{priceTable,formData})` + `publishVersion(...,{extras})`. Same verify-before-flip, same mirror.
5. **The pre-flip PARITY GATE (grill C3 — the cornerstone):** the cutover publish computes the **code-built** descriptor and the **store-built** descriptor and **fail-closes unless they are canonically identical** (counts + both content hashes + structure), BEFORE `flipPointer`. `publishVersion`'s self-integrity is necessary but NOT sufficient (a wrong-but-positive price hashes fine); this explicit code-vs-store compare is what guarantees the no-op. `verify-catalog.js` becomes store-aware and asserts the same.
6. **Consumer migrations — no silent-drift landmines (grill C5, folded in):** every server path that derives menu membership/price/category now sources from the store/catalog, not static code:
   - **`weekendOnlyViolation`** (`menu-pricing.js:35-52`, static `X_PIZZA_WEEKEND_ONLY`) → read weekend cats from the resolved catalog/store (both intake paths, index.js:699/1202). Pre-charge enforcement must track store edits.
   - **Reward eligibility** — X.Pizza `X_PIZZA_REDEEM_ELIGIBLE` (`rewards-redeem-config.js:25-43`) and La Musa accompaniments (`:36-55`) → derive from the store/catalog (eligible set + accompaniments), not static literals.
   - **`reorder-normalize`** (`:9-16`, reads `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT`) → source from store/catalog so reorder never drops a store-added item/extra.
   - **`restaurant-id`** (`:3-8`, derives known brands from `MENU_BY_RESTAURANT`) → make the known-restaurant set store/registry-driven (needed for a data-added merchant #3; fine for our two today but a landmine for onboarding).
   Each migration: source from store/catalog, keep `menu-pricing.js` as the frozen fallback ONLY, and add a **per-consumer parity test** proving identical behavior at store==code.
7. **`menu-pricing.js` → frozen bootstrap**: unchanged in code; remains the seed origin + the resolver ladder's deep emergency fallback. After 2a, **no production consumer treats it as the live authority.**

## Robustness bar (the "airtight" requirements)
- **Fail-closed everywhere:** `readSource`/`validateSource` throw → publish aborts before any write; a consumer that can't resolve from store falls to the frozen code fallback ONLY as a last resort, never silently for a value that should track edits.
- **The no-op is PROVEN, not assumed:** the pre-flip code-vs-store parity gate (C3) blocks any non-identical cutover. Per-brand, per-consumer parity tests. Canonical serialization pinned (C2).
- **Complete schema (C1):** every `readLiteral` field + every consumer input is in the store; a test enumerates the code's literal set and asserts the store schema covers it (guards against a future field being added to code but not the store).
- **No landmine for 2b:** after 2a, enabling a real edit in 2b cannot silently break the weekend gate, reward eligibility, reorder, or restaurant resolution — because they all read the store. A test asserts no production consumer imports `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` as a live authority (only as fallback).
- **Full suite green + all existing catalog/fiscal/rewards tests unchanged** (the produced catalog is byte-identical, so every downstream consumer is unaffected at cutover).

## Cutover procedure (owner-run, gated)
Seed store → run build-parity + publish-descriptor-parity + per-consumer parity tests (all must be identical, both brands) → publish `--from-store` with the pre-flip parity gate armed → `verify-catalog.js` (store-aware) shows *"production catalog == code ✓"* → data is now the authority. Any parity failure = DO NOT cut over; nothing customer-facing is touched (the flip never happened).

## Gate
🔴 Hardest codex money-gate: *build/publish from the store is byte-identical to code per brand (pre-flip parity gate proven); EVERY menu-derived consumer (pricing, weekend gate, reward eligibility, reorder, restaurant-id, fiscal lines) resolves from the store/catalog with no silent code default; the serving/resolver/fallback/mirror paths and `menu-pricing.js`-as-fallback are untouched; schema is complete; canonical serialization pinned.* Then advisor source-audit + owner-run cutover with parity confirmation.

## Out of scope (later phases)
- The editor UI, auth, write-validation-as-a-surface, preview (2b) — though `validateSource` (component 1) is built now and reused by 2b.
- Any actual menu CHANGE (2a proves the inverted pipeline reproduces today's menu identically; first real edit is 2b).
- Stats / order-record enrichment / rollups.
- Retiring the `catalog_parity_mismatch` alarm / `menu-parity` guard (they stay meaningful until 2b introduces intentional divergence; at that point they're repurposed).
