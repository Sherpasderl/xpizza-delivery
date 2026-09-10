# Portal Single-Source — 1A: Catalog is the complete, valid, safe customer-display source

**Status:** DESIGN (rev 5, folds grill R1 [9] + R2 [5] + R3 [3] + R4 [1]) — awaiting re-grill, then owner review → plan → build → money-gate → owner-run gated cutover.
**Date:** 2026-09-09
**Part of:** single-source initiative (`2026-09-09-portal-single-source-slice1-design.md` overview). 1A is the foundation 1B (serve) and 1C (charge) read.
**Base:** `origin/main` (e202e62). Backend/schema + a re-seed cutover; no form or portal-editor changes here (form-literal removal is 1B).

## Goal
Make the live catalog carry the **complete, internally-consistent, safe-to-serve customer-display dataset**, validated strictly on every publish path, so it is the single source 1B serves and 1C charges against — **without changing any price currently charged or served, and without reverting any live merchant edit.**

## Core principle
Everything a customer sees or is charged for must live in the catalog version, be **derivable from that immutable version alone** (never from the mutable `meta/source` draft, never from a code literal), and be **validated complete + internally consistent** before it can publish or be read. Anything a publish cannot fully and safely describe is rejected, not served.

---

## Component A — Complete published-payload validator on EVERY path (grill #2, #7)
Today validation is uneven: `validateSource` runs on some paths; `publish-version.js:50–54` bypasses it; `catalog-publish.js:178–229` checks pricing/structure but not a display schema; `previewVersion` and portal publish (`publish-edited-handler.js:143–148`) omit extras entirely. A version that the new strict reader would reject can therefore be activated.

- **One shared validator** for the complete published payload, invoked (a) before any publish AND (b) against the persisted candidate records before the pointer flips, on **all** paths: direct `publish-version`, store publish, portal `publishEdited`, bootstrap/seed, and **rollback**.
- **Schema version** stamped on every version; the reader accepts its known versions.
- **Staged enforcement:** migrate/re-seed the complete schema BEFORE the strict reader is deployed, and ensure the **rollback target is strict-reader-compatible** — deploying strict reads while old versions lack display records would fail closed on a rollback.
- Tests must **deliberately bypass `validateSource`** and still prove the pointer cannot move to an invalid version.
- **Pointer-flip CAS closes the publish race (grill R3 #1 — also the inherited 2b-2b freshness race).** Publishes validate freshness *before* acquiring the lease, but the flip checks only lease ownership/expiry (`catalog-publish.js:140–145`), so publish A can validate against version V, B publishes, then A acquires the lease and overwrites B with its stale candidate. **Carry the expected active version id AND draft revision into publication and check BOTH transactionally at the pointer flip** — if either moved, abort (re-review), do not flip. This applies to every publish path (portal, store, migration). Test an intervening publish and an intervening draft edit, including across the migration cutover.

## Component B — Full source→build→persist→preview→read→generate contract (grill #7)
`sourceToBuildInputs` already produces `extras_display` + exposure maps (`source-store.js:167–171`), but `buildCatalogV2` drops them, `catalogDocsForRestaurant` emits price-only extras (`seed-catalog-core.js:11–21`), portal publish passes only the price table, and `previewVersion` omits extras (`catalog-publish.js:276–285`). Updating only the named reader/publisher leaves other paths incomplete.
- Thread the complete display dataset through **every** stage and update **every caller**: `buildCatalogV2`, both seed tools, both publish modes, portal publish, preview, the display reader, and the generator.
- **Preserve the numeric extras pricing table used for charging** unchanged; carry display metadata **alongside** it (charging namespace and display namespace stay distinct — grill #3).
- **All serving fields come from the selected immutable version**, never `meta/source`.

## Component C — Dish display prices: mandatory + strictly equal (grill #1, #7)
`validateSource` checks `price == display.price` only when `display.price` is present (`source-store.js:68–99`). Change: **every dish carries `display.price`, strictly `==` the authoritative `price`**, no conditional. Local check found no missing/unequal display prices in the committed bundles for either brand — but **production Firestore was not inspected**; the migration (Component G) must inventory live data and handle any real gap.

## Component D — Extras as first-class display records (grill #3, #4)
- **Exact record shape:** `{ id, cat, name, price, exposure }` — mirroring the form literals (`{id, cat, name, price}`) plus exposure. `price` mandatory numeric; **complete extra-display ↔ extra-price bijection**.
- **Separate extra-category namespace** (ordered) — `Carnes`, `Proteínas`, etc. are NOT dish `structure.categories`; do **not** require membership there (that would reject today's valid extras). Validate each extra's `cat` against the extra-category namespace, and validate **exposure-map VALUES** against extra categories (`source-store.js:144–148` checks only keys).
- **Separate pricing namespaces:** a dish and an extra may share a name (X.Pizza has a dish AND an extra "Pepperoni") — never conflate them.
- **Per-brand arithmetic preserved exactly** (`menu-pricing.js:186–222`, `la-musa-orders/index.html:1895–1954`): X.Pizza adds each submitted extra occurrence **once** (no name-dedup, no ×dish-quantity), toggled per pizza instance; La Musa adds `price × qty` independent of dish quantity and **rejects duplicate IDs**.
- **Exposure encodes today's rules exactly**, including item/category exclusions (Nutella excludes extras — `xpizza-orders/index.html:3615,3647`) and additions (`rice_03` protein). Exposure is **display/eligibility only, separate from pricing** — 1A must **not** introduce a new charging restriction as a side effect of display validation.
- **Exposure — committed contract, not "to be designed" (grill R2 #3 / R3 #3).** THE authoritative representation: each **dish/category declares an ordered allow-list of exposed extra-categories**, plus optional **per-item overrides**: a `deny` (remove extra-categories/extras) and an `add` (include extra-categories/extras). The **deterministic resolver** for an item's exposed option set = `(category allow-list) − (item deny) + (item add)`, output ordered by **(extra-category order, then EXTRAS order within a category)**. Concrete required outputs (pinned by test = the contract's proof): **Nutella** deny=ALL → **empty** set; **`rice_03`** add=proteins → its category extras **plus** proteins; a **launcher's exposure is inherited by its variants** unless a variant overrides. Any legacy per-category / per-item maps that must still be emitted are **DERIVED compatibility output** of this resolver, never a second authored source. The migration must reproduce **today's exact option set for every item** (proven per item, both brands).
- **La Musa duplicate rejection is per submitted dish LINE** (`menu-pricing.js:193–203`) — the same extra on two different lines is valid; do not encode it as a global uniqueness rule.

## Component E — Variants / "desde" derived, launcher price preserved (grill #5)
- **Keep the launcher's authoritative price** (Pad Thai launcher = L414, retained for bare-ID compatibility — `menu-pricing.js:83`). Do **not** overwrite `display.price` with the min variant.
- **Derive a SEPARATE starting-price field** ("desde") = the minimum **selectable** variant price (L307 today), for the launcher's display only.
- **Validate the variant graph:** nonempty **unique** choices; reciprocal `variantOf` ↔ launcher membership; valid parent identity; no cycles/orphans; complete selectable coverage; required single selection where applicable; **option prices derived from the authoritative variant prices**.
- **Normalization order made explicit:** authored `basePrice` is **removed from the source** (the launcher keeps its own price; "desde" is derived) — the derived starting price is not stored as an authored value that could drift.
- **Compatibility alias for the currently-served form (grill R2 #1).** 1A ships before 1B, and the LIVE La Musa form reads `variant_items[...].basePrice` (`la-musa-orders/index.html:1974,2165,4136,4144`) for its "desde" and delta math — emitting only a new starting-price field yields "desde L undefined" and wrong deltas. So the **generated bundle must still emit a `basePrice`, now DERIVED** (= the min-selectable "desde"), as a compatibility alias, until 1B updates the consumers. Test the regenerated bundle **through the current form consumers**. Launcher price stays L414.

## Component F0 — Rendering-safety CONTENT constraints, enforced at 1A even though the render fix is 1B (grill R3 #2)
1A ships merchant-authored data to the **current, unsafe** consumers before 1B hardens rendering: La Musa interpolates catalog names/descriptions into `innerHTML` (`la-musa-orders/index.html:2162–2163`) and category IDs into inline handlers (`:2120–2121`). Script-safe *bundle serialization* does not make a later `innerHTML` safe — a structurally valid authored value could become executable markup after regeneration. So the 1A validator **must constrain authored content and reject unsafe candidates before activation**, appropriate to the unchanged consumers:
- **Identifiers** (item/category/extra ids) — strict safe pattern (no chars that break out of an inline handler/attribute).
- **URLs / image paths** — allowed scheme/host/shape only.
- **Colors** — validated format.
- **Free text is SINK-SPECIFIC — both HTML-body AND attribute context (grill R4 #1).** The same field reaches different sinks per brand: La Musa interpolates names/descriptions into `innerHTML` (body context — reject `<`/`>`/executing entities), and X.Pizza interpolates `p.name` into `alt="${p.name}"` (`xpizza-orders/index.html:1731` — **attribute context**), where a value like `" onmouseover="alert(1)` has NO angle brackets yet breaks out of the attribute into an executable handler. So the constraint must reject **attribute-breaking characters (quotes, etc.) in any field that reaches an attribute sink**, in addition to markup in body-sink fields — enumerated per the actual current consumers of each brand. If arbitrary plain text must be supported instead of rejected, the necessary **context-aware escaping (body AND attribute)** is pulled **into 1A scope** (not deferred), so no unsafe value can be activated.
- Tests exercise hostile/malformed authored values **through the current consumers of BOTH brands**, pinning at least: a body-context markup name (La Musa) and an **attribute-breaking name** (X.Pizza `alt="…"`) — both rejected before activation. (The proper render-layer switch to text nodes / event listeners is still 1B; 1A guarantees the *data* can never carry an XSS payload to today's renderer, in either sink.)

## Component F — Field/consumer inventory: bring all menu content into the catalog (grill #6)
"Every customer-visible field" is scoped to **menu content**, and each field gets a documented requiredness + format. Inventory (source of truth = catalog, not literals):
- **Category labels + layout + subcategories** (published categories are `{id}` only today — "12 Inch Pies", `NY Slice · 18"` are HTML literals; La Musa subcategories).
- **Gates:** `pickup_only_cats`, `weekend_only_cats` — **required, validated** (optional today permits silent omission).
- **Ordering:** item order and extra order.
- **Per-item:** name, description, tags, emoji, color, image path, `has_photo` (typed), category membership, **unique UI IDs** (preserve X.Pizza numeric IDs; uniqueness after DOM string conversion), variant photo inheritance.
- **Badges (grill R2 #4):** `TAG_BADGES` (label text) + `TAG_PRIORITY` ordering (`la-musa-orders/index.html:1785–1800`) are customer-visible menu content still in literals — bring the badge definitions + priority into the catalog.
- **Subcategory coverage (grill R2 #4):** an item whose `subcat` is absent from its category's `subcats` **disappears** in the renderer (`la-musa-orders/index.html:2209–2212`) even with valid dish-category membership — validate that every item's subcategory is covered by its category's declared subcategories.
- **Image roles (grill R2 #4):** a singular `image` field does not settle X.Pizza's `img` vs La Musa's separate **card/hero** paths — define explicit image-role mappings (or a versioned rendering convention per role), not one path.
- **Photo-path construction** (La Musa builds paths from literal templates — `la-musa-orders/index.html:2143,4036`): classify explicitly as either a supported *rendering convention* (stays a 1B render detail) or *published metadata*. Recommendation: published per-role `image` paths when present + typed `has_photo`; the template convention is a documented, versioned fallback.
- **Removal of the form literals themselves is 1B** — 1A makes the fields exist, valid, complete, and served (the dataset must be sufficient NOW even though the form still reads literals until 1B).

## Component G — Migration built from the captured ACTIVE VERSION, byte-identical, edit-preserving (grill #1)
🔴 The re-seed must **NOT** rebuild from code literals. `seed-source-store.js` + `publish-version.js` rebuild from code and compare against code — both agree even when the live published price differs from code, silently reverting a merchant's edit.
- **Field-level provenance merge, because the active version does NOT hold the display data (grill R2 #2).** Published extras persist price-only (`catalog-publish.js:208`) and exposure is dropped (`form-menu-source.js:148–184`) — so the captured active version supplies the **authoritative pricing/served values (which win, edit-preserving)**, but the **absent display fields** (extras id/cat/name, exposure, badges, subcats, image roles) must be sourced from the **deployed serving artifacts** (the committed form bundle/literals — the only place they exist today). Build a **separate migration candidate** that merges by field-level provenance: active record wins for any value it has; deployed-artifact supplies what it lacks; **reconcile by the existing pricing resolver and reject any ambiguous match** (never guess which display record maps to which price).
- **Upgrade unpublished drafts to the new schema WITHOUT publishing their edits (grill R2 #2).** Preserving a draft on the OLD schema would fail the new complete validator on the merchant's next portal publish (`publish-edited-handler.js:92`). Schema-upgrade each `meta/source` draft in place (add the display fields from the same provenance merge) while leaving its pending price edits intact and unpublished. Test the **first subsequent portal publish**, not just cutover.
- **Gate before flip:** compare **old vs new** charged tables, served prices, exposure, and ordering; **bind the comparison to the active version id AND draft revision** so a concurrent edit invalidates it (CAS).
- **Inventory missing/unequal live `display.price`:** fill a *missing* value only after proving the served value agrees; an actual *disagreement* requires a documented data correction or an explicit, owner-approved revised "no-change" claim — never a silent overwrite.
- Owner-run, gated, with a **strict-reader-compatible rollback target**.

## Component H — Deterministic offline generation + committed-artifact parity (grill #8)
Adding extras to the generated bundle changes serialized output and immediately fails committed-artifact equality (`catalog-form-bundle.test.js:54–59`). Variants already flow through `rebuildFormMenu` (treat as derivation/validation, not a new emitted field).
- Include **deterministic offline input** support and **regenerate the committed bundles/manifests**, with full reader↔generator parity tests, in 1A.
- Keep runtime generation **free of draft reads and production credentials** (offline CI stays offline). Broader KDS structural compatibility remains 1D; existing KDS parity must stay intact.

## Component I — Version-identity contract for 1B/1C (grill #9)
`getRestaurantMenu` returns `{items, structure}` with no version identity, so a display read from version A and a later charge from version B (or a fallback) can't be detected.
- The complete snapshot contract includes **restaurant id, schema version, version id/sequence, and content identity**, and 1A provides the **version-specific read path** 1B/1C need.
- **Content identity must cover ALL serving metadata, not just pricing (grill R2 #5).** Today's completeness hashes cover the pricing tables only (`catalog-menu.js:64–66`), so two snapshots that differ in display/exposure share a hash — useless for detecting a display/charge skew. Define a **canonical content identity over the complete served payload** (dish + extra prices, display records, exposure, ordering, categories, variants/desde), with **shared verification** used by preview, reader, and generator (one definition, three consumers).
- **Explicit version reads never substitute active/flat data (grill R2 #5).** `getRestaurantMenu` falls back to mutable flat records when the pointer is absent (`catalog-menu.js:80–83`) — an explicit version read must **never** silently return active/flat data (that cannot carry immutable identity). Define strict active-read behavior when the pointer is absent (fail-closed, typed), and a concrete response shape + missing-version behavior for the version-specific read.
- **Boundary:** 1A supplies *versioned menu + extras pricing inputs and the identity/verification interface*; **1C owns** quote binding, discounts/redemption, other net-total adjustments, and stale-version policy. Settle the **interface** here to avoid a 1C redesign; keep the net-quote implementation in 1C.

---

## Key invariants
- Display price mandatory + strictly `==` charged price, per brand, **dishes and extras**; charging namespace ≠ display namespace; dish namespace ≠ extra namespace.
- "desde" is a **derived, separate** starting price; the launcher keeps its authoritative price.
- Every customer-visible field derivable from the **immutable version** alone; never `meta/source`, never a literal.
- The migration changes **zero charged/served value** and **reverts no live edit** (built from the captured active version, CAS-bound).
- One complete validator on **every** publish path; the pointer cannot move to a version the strict reader would reject; rollback targets stay compatible.
- Per-brand extra arithmetic + exposure preserved **exactly**; no new charging restriction introduced.
- Brand-agnostic (extras keying X.Pizza-name/La Musa-id via the existing resolver; no `rid==='x_pizza'` literal in new validation/reader).

## Testing
- **Strict validation rejects** (each own case, mutation-proven, BOTH brands, and on paths that bypass `validateSource`): missing/unequal dish `display.price`; extra without a display record; extra display price ≠ charged; extra `cat` not in the extra namespace; exposure-map value referencing an unknown extra category; duplicate UI ID; item in unknown dish category; display record ↔ pricing key not 1:1; underivable/incomplete variant graph (orphan, cycle, empty choice, missing coverage); missing required gate array.
- **Migration byte-identical + edit-preserving:** re-seed built from a captured active version that **includes a live price differing from code** serves and charges **identically** afterward (dishes + extras, both brands) — proven from the real serving reader + `computeServerTotal` over **serialized carts** (multi-pizza instances, repeated X.Pizza extra occurrences, La Musa quantity extras, malformed inputs), not hand-built fixtures. Move-the-fact: change a captured price → display and charge follow; change cheapest variant → "desde" follows; launcher price unchanged.
- **Caller completeness:** `buildCatalogV2`, both seed tools, both publish modes, portal publish, preview, reader, generator all carry extras+exposure+variants+identity; `publish-parity` extended to hash extras + exposure (dish-display-only today).
- **Reader/generator parity + offline determinism:** committed bundles regenerated; reader == generator for a seeded version; runtime generation credential-free.
- **Version identity:** the snapshot carries rid + schema version + version id/seq; a read exposes it so 1B/1C can bind.

## Money-gate focus (closing codex gate)
- Migration changes **no charged value** and reverts **no live edit** — proven over serialized carts, both brands, dishes + extras, incl. a live-≠-code case.
- Strict validation **cannot be bypassed** on any publish path; pointer never moves to an invalid version.
- Display ↔ pricing key is 1:1 (a tile can never map to another item's price), incl. extras name/id asymmetry and variants; dish/extra namespaces never conflate.
- No customer-visible field sourced from `meta/source` or a literal; exposure introduces no new charging restriction.

## Open questions for review
- **Extra-category namespace source:** seed the ordered extra categories from today's form `EXTRAS` `cat` values (Salsas & Queso / Carnes / Vegetales & Hierbas / … ; La Musa Proteínas / …) — confirm these become the authoritative set.
- **Photo path:** publish `image` metadata vs keep the template convention as a 1B render detail (recommendation: publish when present + typed `has_photo`, convention as fallback).
- **Cutover shape:** 2a-style owner-run (capture active → seed → parity suite over serialized carts → publish-from-store → verify → prod behavior check), CAS-bound to the active version. Assumed yes.
