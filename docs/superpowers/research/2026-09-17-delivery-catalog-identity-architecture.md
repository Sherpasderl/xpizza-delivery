# Industry research — delivery/commerce catalog & item-identity architecture (informing 1D)

**Date:** 2026-09-17. **Purpose:** deep-dive on how industry leaders designed menu/item identity, to inform Portal 1D (brand-agnostic stable-key migration). Two parallel research streams: (A) delivery marketplaces' engineering (Uber Eats INCA/Menu 2.0, DoorDash, Deliveroo, Grubhub); (B) commerce/POS public API data models (Square, Stripe, Toast, Shopify, Olo, Deliverect, Otter). All claims sourced; inferences marked in the source reports.

## Bottom line
The industry **converged on exactly the migration v2 specs.** Opaque platform-minted item IDs with the name as a mutable label; modifiers/extras as first-class ID'd entities; one generic multi-tenant model with per-merchant behavior in *config/override rows, not code*; versioned catalog publish with fast rollback; persisted quote + versioned read for display==charge; and an immutable order-line snapshot. Uber's own history is the documented proof the pattern we're leaving behind fails: **Menu 1.0 keyed items by name/copy → ~25% duplicate items, wrong metrics, out-of-stock edits touching every copy.** That is X.Pizza today.

## What CONFIRMS our v2 (pattern → source → our contract)
- **Opaque minted ID + mutable label.** Square `CatalogObject{id,type,version}` with `name` inside `*_data` (no uniqueness); Toast platform `guid`; Otter UUID; Uber internal `entityUUID` walled off from merchant `externalID`. → validates D1 identity + invariant "id never human-facing, name is a label."
- **Modifiers/extras are first-class ID'd entities → name collision dissolves by construction.** Square `MODIFIER`/`MODIFIER_LIST` distinct types; Uber "a modifier option is just an Item with a UUID"; Deliverect/Otter modifiers are ID'd objects. A "Pepperoni" dish and "Pepperoni" extra are two IDs sharing a label — non-event. → validates §8-#5 (namespace collision) and the extras half of D1.
- **One generic multi-tenant model; per-merchant behavior in config, not code.** Uber INCA = generic "entity + extensions (Protobuf)" + Starlark transforms; DoorDash = **catalog (shared, `global_catalog_id`) vs inventory (per-store price/availability, `menu_item_id`+`store_id`)** split. → validates "one brand-agnostic code path"; directly against per-brand hardwiring ([[brand-agnostic-no-hardwiring]]).
- **Versioned publish with fast rollback.** INCA puts **the version in the primary key** → O(1) rollback at global or single-store granularity; Deliveroo full-replace with content-hash no-op (`MATCH_EXISTING_MENU`). → matches our version-aware catalog; suggests version-pinned reads + content-hash no-op guard.
- **Display==charge via persisted quote + versioned read.** DoorDash Pricing Framework **persists the quote and replays it**; INCA reads price from the versioned snapshot. → exactly our 1C charged==confirmed.
- **Immutable order-line snapshot.** Unanimous across all 7 platforms. Best-in-class = Square `OrderLineItem` pins `catalog_object_id` + **`catalog_version`** + copied `name`/`base_price_money`, same for each modifier. → our §8-#3 (historical records immutable) — and pin the VERSION, not just id.
- **Integer minor units for money** (Square/Deliverect cents). → we already use cents.

## Concrete UPGRADES to fold into our stages (deltas beyond v2)
1. **[D1] Dual-ID framing + "ID churn detection" (Uber INCA).** Merchant supplies an external key (name/slug/PLU); platform owns the opaque internal ID; a rename or POS re-key **remaps to the existing ID instead of forking a duplicate.** This is the named, proven form of our D1 "mint-once / immutable creation handle" contract — adopt it explicitly, including for future POS onboarding.
2. **[D1 authoring] Square `#`-temp-id → `id_mappings`.** Create an item + its extras and wire references atomically in one request before real IDs exist. Useful for the mint/backfill and portal authoring.
3. **[§8-#3] Pin `catalog_version` on the order line snapshot**, alongside id + copied name/price. Lets us later prove which catalog revision produced a given historical charge — invaluable for the SAR factura audit trail.
4. **[price integrity] Consider Stripe immutable-Price discipline.** Stripe never mutates a price: *create a new Price, archive the old (kept indefinitely as the immutable record of past transactions).* A published price becomes an immutable record the confirmed quote pins by id+version → an out-of-band edit cannot move a still-open quote. Strengthens 1C beyond mutable-price+snapshot (Square/Shopify), and is the stronger guard for a fiscal platform.
5. **[D4 + possible 86 improvement] Time-boxed availability with auto-expiry + 3-state.** Square `sold_out_valid_until`, Deliverect snooze windows, Otter `suspendedUntil`; Deliveroo's 3-state **available / temporarily-unavailable-auto-reset / hidden-persistent**. Settable at the **modifier** level too (Otter `{id, isModifier}`). Beats a bare boolean someone must remember to un-flip — fits [[seamless-customer-ux-priority]] and staff UX.
6. **[config-ization slice; 1D sets it up] One shared identity + per-scope OVERRIDE ROWS.** Square `location_overrides[]` (per-location price/availability on a shared variation), Toast `multiLocationId`, Olo chain→store, DoorDash catalog-vs-inventory. For us the override scope is the **brand/merchant**: one global item definition; per-brand price/availability/rules as override rows. This is the structural cure for "two brands mask literals" — 1D mints the shared identity, the config-ization slice adds the override rows and retires the hardcoded per-brand tables.

## Anti-patterns to avoid (from research)
- Mutating price in place with **no order-line snapshot** (only safe *because* Shopify snapshots) → our "form showed 340 / charged 350" class.
- **Decimal/float money** (Otter `7.65`) — prefer integer minor units.
- **Boolean 86 with no expiry** → "forgot to un-86" stockouts; use time-boxed windows.
- **86 only at item level** — must reach modifiers/extras.
- **Using merchant code / PLU / referenceId as identity** (Toast `referenceId` explicitly not 1:1 with `guid`; Deliverect `plu` is a merchant code) → keep our slug/name strictly separate from platform identity.
- **Losing the catalog version on the order** — id alone can't reconstruct the exact revision sold.

## OPEN DECISION (owner) — modifier/extra identity model
Two industry camps, both dissolve the name-collision via IDs:
- **Modifier IS an item** (Uber, Otter): one identity primitive; "Mushroom" defined once, reused across dishes and as a side. Max reuse; heavier relational model.
- **Modifier is a DISTINCT type** attached to items (Square, Toast): `MODIFIER`/`MODIFIER_LIST` separate from `ITEM`; cleaner semantics (an extra is clearly not orderable alone); matches our current separate-extras namespace.
Advisor lean: **distinct type** — cleaner, matches our code today, avoids implying an extra is independently orderable; we can still get cross-dish reuse via a shared modifier-list reference.

## Sources
Uber INCA: uber.com/us/en/blog/scaling-uber-eats-for-everything/ ; infoq.com/news/2025/08/ubereats-inca-inventory-catalog/ · Menu 2.0: uber.com/blog/introducing-menu-maker/ · menu API: developer.uber.com/docs/eats/guides/menu-integration
DoorDash: careersatdoordash.com inventory-platform / product-knowledge-graph / rebuilding-our-pricing-framework ; developer.doordash.com item_status
Deliveroo: api-docs.deliveroo.com/docs/menu-api-overview · Grubhub: grubhub-developers.zendesk.com menu docs
Square: developer.squareup.com/reference/square/objects/CatalogObject ; catalog-api/batch-upsert ; OrderLineItem ; ItemVariationLocationOverrides
Stripe: docs.stripe.com/products-prices/how-products-and-prices-work ; api/idempotent_requests
Toast: doc.toasttab.com apiUnderstandingGuids... · Shopify: shopify.dev ProductVariant · Olo: developers.raydiant.com/docs/on-brand-menu-api/olo · Deliverect: developers.deliverect.com · Otter: connect.tryotter.com/docs
Line-item snapshot: docs.commercetools.com/api/carts-orders-overview ; craftcms.com/docs/commerce purchasables
