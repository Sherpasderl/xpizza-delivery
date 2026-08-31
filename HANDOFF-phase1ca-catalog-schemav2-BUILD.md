# BUILD RELAY — Phase 1c-a: schema-v2 lossless full-menu catalog + bootstrap-seed + parity proof

**To:** executor · **From:** advisor. **Spec:** `docs/superpowers/specs/2026-08-31-phase1c-forms-source-catalog-design.md` (front half of the portal-serving arc; 1c/1d design GATED SOUND after 4 codex money+fiscal rounds — see the spec's revision banner + [[sherpa-platform-initiative]]). **Type: ADDITIVE, ZERO live-path risk** — 1c-a extends the catalog SCHEMA + seed + adds a display reader + proves parity. It does NOT cut the forms, does NOT touch the pricing path, does NOT retire anything. Codex-always gate on the built diff (additive, so lighter than the 1d money-gate — but still gated; never self-approve). **Commit LOCAL-ONLY; owner executes all merges/deploys.**

## ⚠️ BUILD BASE
Fresh worktree off **`origin/main` @ current** (`git fetch` + confirm origin/main SHA first — 1b-2 is the last landed money phase). Branch `feat/phase1ca-catalog-schemav2`. **Re-anchor every line number below** (they are as-of this writing and will drift).

## What & why
Today the menu lives in 4 hand-synced places; the catalog holds only `{key, price}` per item. 1c-a makes the Firestore catalog a **LOSSLESS FULL-MENU store** so that (1c-b) the form bundle + KDS manifest can be GENERATED from it byte-identically. 1c-a is the schema + seed + parity foundation ONLY — no generation, no versioned-publish (that's 1c-b), no form cutover.

## The build — 4 pieces, all additive

### 1. schema-v2 — extend each `menu_item` doc with its COMPLETE form record + a `menu_structure` doc
- **Per item (`restaurants/{rid}/menu_items/{docId}`):** keep `{ key, price }` EXACTLY as today (the 1b pricing reader depends on it — see PIN 1), and ADD the full form record verbatim: `name, description, cat, subcat, tags, emoji, color, has_photo`, plus the variant relationship fields (`variantOf` / `choice` / launcher config — la_musa `VARIANT_ITEMS`, `itemIsLauncher`). Every field the form dish object carries so the bundle regenerates byte-identical by construction.
- **A `menu_structure` doc** (`restaurants/{rid}/meta/menu_structure` or a top-level field — your call, document it): the CATEGORIES in order, their labels, the la_musa `subcats` layout (form `subcats` block ~la-musa:1769), and the variant map (`VARIANT_ITEMS` ~la-musa:1935). Also the category gate flags the FORM keys off: x_pizza `PICKUP_ONLY_CATS`/`WEEKEND_ONLY_CATS` (~xpizza:1609/1614) — carry them as structured data so 1c-b's bundle can reproduce the gates.
- **`profile` doc:** add `schema_version: 2` (and add it to `PROFILE_FIELDS` in `seed-catalog-core.js:15` — the allowlist wipes any field not listed). Extras stay `{ key, price }` (unchanged).
- **🔒 PIN 2 — `key` is IMMUTABLE identity, `name` is DATA.** x_pizza prices by NAME (`itemPricingKey` → `key === name` for x_pizza today); la_musa by `id` (`key === id`). Store `key` as the pricing identity and `name` as a display field. A rename is a gated key-migration, never a silent copy edit. Pin `key===name` for x_pizza with a guard test (PIN in tests below).

### 2. Bootstrap — extract today's menu INTO schema-v2, PRICE from `menu-pricing.js` (the authority)
- Extract each item's DISPLAY fields from the form dish array (`xpizza-orders/index.html:1435` `const MENU`; `la-musa-orders/index.html` dish array ~:1872 + `HAS_PHOTO` ~:1956 + `VARIANT_ITEMS`), and its PRICE from `menu-pricing.js` `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` (the authoritative yardstick — NOT the form's `price` field, though they must match; see parity). Map form item → pricing key correctly (x_pizza: form `name` → pricing key; la_musa: form `id` → pricing key).
- Extend `seed-catalog-core.js` `seedCatalog` to write the full record onto the `menu_items` docs (currently `catalogDocsForRestaurant` emits `{id,key,price}` at :10 and the seed writes `{key,price}` at :42 — extend BOTH to carry the display fields, keeping `key`/`price` byte-identical). Keep the reconcile (stale-doc delete) + profile-LAST + 450-chunk + full-overwrite-no-merge invariants already there.
- The bootstrap is a one-time extraction, but the seed must remain idempotent + deterministic (`docId = sha1(key)` unchanged).

### 3. Two readers, one store
- **🔒 PIN 1 — the PRICING reader stays BYTE-UNCHANGED.** `catalog/catalog-firestore.js` `getRestaurantDocs` returns `{ key, price }` ONLY — it must IGNORE the new fields and be diff-empty except (optionally) the `price > 0` alignment noted below. The whole 1b money path (createCatalogReader → resolvePricingTables → the seams) is UNTOUCHED. This is the additive guarantee: the new schema fields are invisible to pricing.
- **NEW display reader `getRestaurantMenu(db, rid)`** — returns the full per-item record + the `menu_structure` doc (for 1c-b's bundle generation). Read by NOTHING in 1c-a (wired in 1c-b). Same trust-boundary discipline as `getRestaurantDocs`: throws on not-found/empty/malformed, never a plausible-empty.
- **(Optional, aligns with the 1d grill):** you MAY tighten `catalog-firestore.js:18` from `price >= 0` to `price > 0` here (1d requires it; harmless additively). If you do, note it in the handback; if not, 1d-a will.

### 4. Parity — the money + display proof (emulator round-trip, non-vacuous)
- **Pricing parity (must still hold, regression guard):** the schema-v2 seed reproduces the `{key,price}` tables byte-identical both brands via the REAL reader (the existing 1a/1b emulator parity — extend it so it runs against the schema-v2 docs). [[no-regression-hard-rule]].
- **NEW display parity:** the schema-v2 catalog's items + `menu_structure`, read via `getRestaurantMenu`, reconstruct today's form dish array + category structure **byte-identical, both brands** — every field (`cat/subcat/name/desc/tags/emoji/color/has_photo/variant`), category order, item order, la_musa subcats/variants. **Non-vacuous + sentinel** (a display-only field set only in the catalog proves the display reader is exercised, not the form).
- **`key===name` guard (x_pizza):** a test asserting every x_pizza item's `key` equals its `name`.

## 🔒 Invariants / PINs (summary)
- **PIN 1:** pricing reader `getRestaurantDocs` → `{key,price}` BYTE-UNCHANGED; 1b money path diff-empty.
- **PIN 2:** `key` immutable identity, `name` display data; x_pizza `key===name` guarded.
- **ADDITIVE GUARDRAIL:** `index.js`, `menu-pricing.js`, and BOTH order forms are BYTE-UNTOUCHED in 1c-a (grep-prove). The diff is confined to `catalog/` + `tools/` (seed) + tests.
- Keep every existing seed invariant: reconcile-stale, profile-LAST, 450-chunk, full-overwrite `set()` no-merge, `PROFILE_FIELDS` allowlist (add `schema_version`).

## Tests (all required, wired into `npm test`)
- Pricing parity (regression): schema-v2 seed → `{key,price}` byte-identical both brands, real reader (emulator).
- Display parity: `getRestaurantMenu` round-trips the full record + structure to the form dish array + categories, byte-identical both brands, **non-vacuous + sentinel**.
- `key===name` x_pizza guard.
- Additive proof: a test/grep asserting `index.js` + `menu-pricing.js` + forms are untouched (or assert in the handback with the diff stat).
- Full `npm test` EXIT 0; the 1b-1/1b-1b/1b-2 pricing + factura tests UNCHANGED.

## Gate & deploy
LOCAL-ONLY → advisor source-audit (additive guardrail holds, PIN 1 byte-unchanged, parity non-vacuous) → **codex gate on the built diff** ([[codex-gate-always]]; additive-scope, but money-adjacent because it touches the catalog the pricing reader consumes → confirm PIN 1). Deploy (owner, post-gate): the schema-v2 re-seed via `tools/seed-catalog.js` + `tools/verify-catalog.js` (the seed re-runs additively — new fields, same `{key,price}`; verify-catalog must still show `production catalog == code tables` for pricing). NO functions deploy (1c-a ships no code the live path reads — the display reader is dormant). **Prove-in-prod:** `verify-catalog` green (pricing parity intact) + the schema-v2 docs present with full records — before 1c-b.

## Handback DoD
Branch@SHA; the schema-v2 doc shape + `menu_structure`; the extended seed; the new `getRestaurantMenu`; PIN 1 byte-unchanged statement (diff stat proving `index.js`/`menu-pricing.js`/forms untouched); the pricing-parity + display-parity(+sentinel) + `key===name` tests; whether you applied the `price > 0` alignment; `npm test` EXIT 0.

---
*Relay artifact (advisor→executor), not part of the build branch — remove from the main tree before any ff-merge (diff-confirm identical first) per the established handoff-cleanup.*
