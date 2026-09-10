# Portal Single-Source — 1A: Catalog is the complete, valid, safe customer-display source

**Status:** DESIGN — awaiting owner review, then design-grill (codex), then plan → executor build → money-gate → owner-run gated cutover.
**Date:** 2026-09-09
**Part of:** the single-source initiative (`2026-09-09-portal-single-source-slice1-design.md`, overview). 1A is the foundation 1B (serve) and 1C (charge) read.
**Base:** `origin/main` (e202e62). Backend/schema + a re-seed cutover; no form or portal-editor changes here.

## Goal
Make the live catalog carry the **complete, internally-consistent, safe-to-serve customer-display dataset**, validated strictly, so it can be the single source that 1B serves to customers and 1C charges against — **without changing any price that is currently charged or served.** Today the catalog is authoritative for *charging dishes* but is missing or only-conditionally-validating most of what a customer *sees*: extras have no display records, La Musa's "desde" price and variants are independently authored, and display prices are validated only when present.

## Core principle
Everything a customer will see or be charged for must live in the catalog source, be **derivable from it alone** (never from the mutable `meta/source` draft or from code literals), and be **validated complete + internally consistent** before it can publish. Anything a publish cannot fully and safely describe must be rejected, not served.

## In scope (1A)
1. **Dish display prices — mandatory + strictly equal (grill #7).** `validateSource` currently checks `price == display.price` only *when `display.price` is present* (`source-store.js:68–99`); a missing display price is accepted for both brands. Change: **every dish must carry `display.price`, and it must strictly equal the authoritative `price`** — no conditional. Reject on missing or unequal.
2. **Extras become a first-class display source (grill #5).** Published extras carry only `{key, price}` today (`catalog-publish.js:208`); `getRestaurantMenu` returns none; forms hold `EXTRAS` literals. Add **extras display records** to the catalog source + published version: `{key, price, display:{name, category}, exposure}`, with the **per-brand exposure/keying model preserved**: X.Pizza name-keyed, count-once (0/1 toggle); La Musa id-keyed, quantity-aware/standalone. `getRestaurantMenu` returns them. Validate: every served extra has a display record with `price == display price`, a valid category, and correct keying for its brand.
3. **La Musa "desde"/variants derived, not authored (grill #8).** The launcher "desde" price is independently authored (`variant_items.*.basePrice`) and can advertise a stale/unavailable start. Change: **derive "desde" from the valid selectable variants** at build time; validate that every launcher references existing variants, every referenced variant exists, and choice sets are complete. Retain `variant_items` and `has_photo` in the display shape.
4. **Structural field validation (grill #6 data half, #7).** Validate the fields that will later reach the DOM so the data can't carry malformed attributes: **unique UI IDs** (safe pattern), **category membership** (every item's category exists in `structure.categories`), **display-identity agreement** (the display record maps to exactly the pricing key — no tile→wrong-key mapping), and format checks on image path / color. (The DOM-render *safety* itself is 1B; 1A guarantees the data is well-formed.)
5. **`getRestaurantMenu` returns the complete display set (grill #7):** dishes (with mandatory display price), extras (with display records + exposure), variants/"desde", categories — and **re-checks identity/price agreement on read** (`catalog-menu.js:30–36` does not today), fail-closed on any mismatch. This is the reader 1B's `getPublicMenu` will wrap.
6. **Generator emits the complete shape:** `rebuildFormMenu`/`generateFormBundle` (`form-menu-source.js:189–212`) emit **extras and variants**, not just dishes, so the generated artifact is a full display source (used by 1B's fail-safe bundle and the manifest).
7. **Re-seed cutover:** re-seed the live catalog to the complete schema (populate extras display records, derived "desde", mandatory display prices), with a **byte-identical serving + charging proof** (2a discipline): the migration adds display data only — **no charged value and no served dish price changes**. Owner-run, gated, with rollback.

## Out of scope (later slices)
- `getPublicMenu` + form live-sourcing + async-init/fallback + cache/CDN (**1B**).
- Safe DOM rendering of authored strings (**1B**).
- `charge == confirmed net quote`, both payment handlers, checkout state machine, client migration (**1C**).
- KDS structural-change compatibility + CI/generator-parity contract (**1D**).
- Portal *editing* of the new fields (extras names, categories, variants) — a later portal slice; 1A only makes the fields exist, valid, and served.

## Key invariants
- **Display price mandatory and strictly `==` the charged price**, per brand, for **dishes and extras**. No conditional, no coercion.
- **"desde" is derived** from selectable variants; never independently authored.
- Every customer-visible field is **derivable from the catalog alone** — never `meta/source`, never a code literal.
- **Unique UI IDs; every item's category exists; display record ↔ pricing key is 1:1** (no tile mapped to the wrong price).
- **The migration changes zero charged/served values** — additive display data only, proven byte-identical.
- Brand-agnostic: extras keying is X.Pizza-name / La Musa-id via the existing key resolver; no `rid==='x_pizza'` literal in the new validation/reader.

## Data flow (1A)
Merchant/seed source → `validateSource` (complete + strict) → published version stores dishes+extras-display+variants → `getRestaurantMenu` returns the complete, re-checked display set → (1B will serve it; 1C will charge from the same version).

## Error handling
- Any incompleteness or inconsistency (missing display price, unequal price, missing extra display record, stale/underivable "desde", dup ID, unknown category, display↔key mismatch) → `validateSource`/publish **rejects**; nothing partial is served.
- `getRestaurantMenu` re-checks on read and **fails closed** (never returns a display set it can't vouch for) — consistent with the pricing resolver's rule.

## Testing
- **Strict validation rejects** (each its own case, mutation-proven): missing `display.price`; `price != display.price`; extra with no display record; extra display price ≠ charged; stale/underivable "desde"; duplicate UI ID; item in an unknown category; display record mapping to a different pricing key. Each must reject for **both brands**.
- **Migration byte-identical:** the re-seeded complete catalog serves and charges **identical** dish and extra prices to today for both brands (originate the comparison from the real serving reader + `computeServerTotal`, not hand-built fixtures; move-the-fact: change a source price → both display and charge follow; change the cheapest variant → "desde" follows).
- **Reader completeness:** `getRestaurantMenu` returns dishes+extras+variants+categories with display records; extras exposure/keying correct per brand.
- **Generator completeness:** `generateFormBundle` emits extras + variants; parity with the reader for a seeded version.
- **No-regression:** serving resolver / `computeServerTotal` / `publishEdited` pricing behavior unchanged except the additive display data; the current parity/CI suites still pass (offline).

## Money-gate focus (closing codex gate)
- The re-seed migration changes **no charged value** — prove it (serving + `computeServerTotal` byte-identical pre/post, both brands, dishes + extras).
- Strict validation **cannot be bypassed** to publish an incomplete/inconsistent display source.
- Display↔pricing-key is 1:1 (a tile can never be mapped to a different item's price), both brands, including the extras name/id keying asymmetry and La Musa variants.
- No customer-visible field is sourced from `meta/source` (the mutable draft) or a code literal.

## Open questions for review
- **Extras `category` / display metadata source:** the forms' `EXTRAS` literals carry categories ("Salsas & Queso", "Carnes", …). 1A must move these into the catalog. Confirm the current form categories are the intended authoritative set to seed from (they will become catalog data).
- **Cutover shape:** same as 2a (seed → parity suite → publish-from-store → verify → prod behavior check), owner-run? Assumed yes.
