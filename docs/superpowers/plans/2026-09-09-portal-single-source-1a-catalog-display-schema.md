# Portal Single-Source 1A — Catalog as Complete Display Source: Implementation Plan

> **For agentic workers:** relay-driven. The executor SESSION builds each task LOCAL-ONLY; the advisor source-audits + codex money-gates each task before the next; the owner runs the cutover (Task 9) and all deploys. Steps use `- [ ]` for tracking. TDD, frequent commits, nothing pushed.

**Goal:** Make the live catalog carry the complete, valid, safe customer-display dataset (dishes, extras, variants/desde, categories, badges, images), validated strictly on every publish path, so it is the single source 1B serves and 1C charges against — **without changing any charged/served value and without reverting any live merchant edit.**

**Architecture:** Additive display schema on the existing catalog version + one shared complete-payload validator (incl. rendering-safety) wired into every publish path + a pointer-flip CAS + a provenance-merge migration that builds from the captured active version. Charging namespace (`computeServerTotal` numeric tables) stays byte-untouched; display data is carried alongside.

**Tech Stack:** Node (Firebase Functions), `node --test`, Firestore catalog (`restaurants/{rid}/meta/active_version`→`versions/{id}`, `meta/source` draft), the existing `catalog/*` modules. Offline CI (no live Firestore) for generation.

**Spec:** `docs/superpowers/specs/2026-09-09-portal-single-source-1a-catalog-display-schema-design.md` (rev 5, design-grill APPROVED). Read it fully before starting.

## Global Constraints (every task implicitly includes these)
- **Zero charged-value change:** `computeServerTotal` and the numeric pricing/extras tables it reads produce byte-identical results pre/post, both brands. Display data is additive.
- **No reverted live edit:** never rebuild authoritative prices from code literals; the migration builds from the captured active version.
- **Brand-agnostic:** no `rid==='x_pizza'` literal in new validation/reader/resolver; keying (X.Pizza-name / La Musa-id) goes through the existing key resolver.
- **Derivable-from-version-alone:** no served/display field sourced from `meta/source` (mutable draft) or a code literal.
- **Fail-closed:** any incompleteness/inconsistency/unsafe-content rejects at validate/publish/read; nothing partial or unsafe is served.
- **Tests originate from the real writer/reader** (not hand-built fixtures) where they assert parity; mutation-verify discriminating tests.
- Run `cd xpizza-functions && npm test` (or the scoped `node --test <file>`); keep offline CI offline.

---

## File Structure
- **New:** `xpizza-functions/catalog/extras-exposure.js` — the exposure resolver (pure). `xpizza-functions/catalog/display-safety.js` — rendering-safety content constraints (pure). `xpizza-functions/tools/migrate-catalog-display.js` — the provenance-merge migration. `docs/superpowers/runbooks/2026-09-09-portal-1a-cutover.md` — cutover runbook.
- **Modify:** `catalog/source-store.js` (validateSource → complete validator + desde derivation hook), `catalog/form-menu-source.js` (buildCatalogV2 + rebuildFormMenu carry display data), `catalog/generate-form-bundle.js` (emit extras/variants/basePrice-alias, deterministic offline), `catalog/catalog-menu.js` (getRestaurantMenu complete set + re-check + version identity + no-fallback for version reads), `catalog/catalog-publish.js` (validator wired into publishVersion/previewVersion/rollback + flipPointer CAS), `catalog/publish-edited-handler.js` (validator on portal publish + CAS), `catalog/seed-catalog-core.js` (persist display records), `catalog/publish-parity.js` (hash extras+exposure), `tools/seed-source-store.js` + `tools/seed-catalog.js` + `tools/publish-version.js` (thread display data; pass expected-active-version for CAS).

---

## Task 1 — Exposure resolver (the committed contract)
**Files:** Create `catalog/extras-exposure.js`; Test `catalog/extras-exposure.test.js`.
**Interfaces — Produces:** `resolveExposure(item, categoryAllow, extraCategoriesOrder, extrasOrder) → orderedExtraKeys[]` (pure). `deriveLegacyMaps(items, …) → {byCategory, byItem}` (derived compatibility output).

- [ ] **Step 1 — failing tests (the contract, pinned):** for each real item, `resolveExposure` = `(category allow-list) − (item deny) + (item add)`, output ordered by (extra-category order, then EXTRAS order). Assert exact ordered output for: **Nutella → `[]`** (deny=ALL); **`rice_03` → its category extras + the protein extras** in canonical order; a **launcher inherits its exposure to variants** unless overridden; a plain dish → its category's extras in order. Both brands. Plus: legacy maps are DERIVED (round-trip `deriveLegacyMaps(resolve(...)) == today's maps`) — never a second source.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement `extras-exposure.js` (pure, no I/O, brand-agnostic).
- [ ] **Step 4:** run, verify PASS; mutation-check (swap deny/add order, drop the sort) each kills a test.
- [ ] **Step 5:** commit `feat(catalog): exposure resolver — committed contract (Nutella/rice_03/variant inheritance, ordered, legacy=derived)`.

**Gate focus:** exact per-item option sets match today for BOTH brands; exposure introduces no charging change (display/eligibility only); no `rid` literal.

---

## Task 2 — Complete display-payload validator + rendering-safety
**Files:** Modify `catalog/source-store.js` (extend `validateSource`); Create `catalog/display-safety.js`; Test `catalog/source-store.test.js` (+ `display-safety.test.js`).
**Interfaces — Consumes:** `resolveExposure` (Task 1). **Produces:** `validateSource(source, rid)` now enforces the complete schema + stamps/accepts `schema_version`; `assertDisplaySafe(record, sinkContext)` in display-safety.js.

- [ ] **Step 1 — failing rejection tests (each its own case, BOTH brands, mutation-verified):**
  - dish missing `display.price` → reject; `price != display.price` → reject (today only checked when present — `source-store.js:68–99`).
  - extra without a display record; extra display price ≠ charged; extra `cat` not in the ordered **extra-category namespace**; exposure-map VALUE referencing an unknown extra category (today only keys checked — `:144–148`).
  - duplicate UI id; item in an unknown dish category; item `subcat` not in its category's `subcats` (else it vanishes — La Musa `:2209–2212`); display record ↔ pricing key not 1:1 (dish "Pepperoni" vs extra "Pepperoni" must not conflate).
  - variant graph invalid (orphan / cycle / empty choice / missing coverage / bad parent).
  - **rendering-safety:** a **body-context** name with markup (`<img onerror=…>`) → reject (La Musa `innerHTML` sink `:2162–2163`); an **attribute-context** name with a quote breakout (`" onmouseover="alert(1)`) → reject (X.Pizza `alt="${p.name}"` `:1731`); a category id that breaks an inline handler → reject (`:2120–2121`). Enumerate fields per each brand's actual sinks.
  - a valid complete source (both brands, from the real seed) → PASS.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement the complete validator + `display-safety.js` (identifier pattern; URL scheme/host; color format; body-markup rejection; attribute-breaking-char rejection for attribute-sink fields). Stamp `schema_version`.
- [ ] **Step 4:** run, verify PASS; mutation-check each rule.
- [ ] **Step 5:** commit `feat(catalog): complete display-payload validator + rendering-safety (mandatory strict prices, extras/variants/subcats/ids, body+attribute XSS)`.

**Gate focus (money + safety):** no incomplete/inconsistent/unsafe source can pass; display↔pricing-key 1:1; both XSS sinks (body + attribute) rejected; both brands; no charging restriction introduced.

---

## Task 3 — "desde" derivation + basePrice compat alias
**Files:** Modify `catalog/form-menu-source.js` (variant/desde derivation); Test `catalog/form-menu-source.test.js`.
**Interfaces — Produces:** `deriveStartingPrice(launcher, variants) → number` (min selectable). Launcher keeps its authoritative `price`/`display.price` (L414); a **derived** `basePrice` (= desde) is emitted in the bundle shape for pre-1B compat.

- [ ] **Step 1 — failing tests:** desde = min selectable variant (L307 today); launcher `display.price` unchanged (L414); the generated bundle still carries a `basePrice` field = desde (compat); move-the-fact: lower the cheapest variant → desde follows, launcher unchanged; removing a referenced variant → validation (Task 2) rejects.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement derivation; authored `basePrice` removed from source, derived `basePrice` alias emitted by the bundle path.
- [ ] **Step 4:** run, verify PASS.
- [ ] **Step 5:** commit `feat(catalog): derive La Musa desde from variants; keep launcher price; emit derived basePrice compat alias`.

**Gate focus:** launcher charge unchanged; desde derived not authored; the LIVE La Musa form (reads `.basePrice` `:1974,2165,4136,4144`) still works off the regenerated bundle.

---

## Task 4 — Thread the complete dataset through build → persist
**Files:** Modify `catalog/form-menu-source.js` (`buildCatalogV2`), `catalog/seed-catalog-core.js` (`catalogDocsForRestaurant`), `tools/seed-source-store.js`, `tools/seed-catalog.js`; Test the corresponding `*.test.js` + `catalog/source-store.test.js`.
**Interfaces — Consumes:** validator (Task 2), exposure (Task 1), desde (Task 3). **Produces:** `buildCatalogV2` output + persisted version now carry `extras_display`, exposure, variants/desde, badges, images, categories/subcats, `schema_version`, **alongside the unchanged numeric charging tables**.

- [ ] **Step 1 — failing tests:** `buildCatalogV2` no longer drops `extras_display`/exposure (today it does — `sourceToBuildInputs` produces them at `source-store.js:167–171`); `catalogDocsForRestaurant` persists display records (today price-only — `seed-catalog-core.js:11–21`); both seed tools carry them. **Charging table byte-identical** (assert the numeric extras/menu tables `computeServerTotal` reads are unchanged).
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement threading; keep the numeric charging table exactly as-is, metadata alongside.
- [ ] **Step 4:** run, verify PASS.
- [ ] **Step 5:** commit `feat(catalog): thread complete display dataset through build+persist+seed; charging table byte-unchanged`.

**Gate focus:** charging table unchanged; no display field from `meta/source`; both brands.

---

## Task 5 — Reader returns the complete set + version identity + no fallback
**Files:** Modify `catalog/catalog-menu.js` (`getRestaurantMenu` + hashes); Test `catalog/catalog-menu.test.js`.
**Interfaces — Produces:** `getRestaurantMenu(db, rid)` returns `{ items, extras, variants, structure, identity }` where `identity = { rid, schema_version, version_id, seq, content_hash }`; `content_hash` covers the **whole served payload** (prices + display + exposure + ordering + categories + variants), not pricing-only (today `:64–66`). A **version-specific read** never falls back to active/flat records (today `:80–83` does); absent pointer → typed fail-closed.

- [ ] **Step 1 — failing tests:** reader returns extras+variants+identity; `content_hash` DIFFERS for two versions that differ only in a display/exposure field (today they'd collide); re-check identity/price agreement fail-closed on a planted mismatch; a version-specific read with an absent pointer → typed error, NOT flat data.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement; shared canonical `content_hash` used by preview/reader/generator (one definition).
- [ ] **Step 4:** run, verify PASS.
- [ ] **Step 5:** commit `feat(catalog): reader returns complete display set + whole-payload version identity; no active/flat fallback on version reads`.

**Gate focus:** identity detects a display-only change (so 1B/1C can spot a version skew); no fallback substitutes immutable identity.

---

## Task 6 — Generator emits the complete bundle; deterministic offline; committed-artifact parity
**Files:** Modify `catalog/generate-form-bundle.js`, `catalog/form-menu-source.js` (`rebuildFormMenu`); Test `catalog/catalog-form-bundle.test.js` (+ regenerate committed bundles/manifests).
**Interfaces — Consumes:** Tasks 1–3, 5. **Produces:** `generateFormBundle` emits dishes + **extras** + **variants** + derived **basePrice** alias; reader↔generator parity.

- [ ] **Step 1 — failing tests:** generated bundle includes extras + variants + basePrice alias; **reader == generator** for a seeded version (originate both from the same version); offline `catalogSnapshot` path stays credential-free; the committed-artifact equality test (`catalog-form-bundle.test.js:54–59`) is updated to the new shape and passes on regenerated bundles.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement; regenerate the committed bundles/manifests; keep runtime generation free of draft reads/prod credentials.
- [ ] **Step 4:** run, verify PASS (offline).
- [ ] **Step 5:** commit `feat(catalog): generator emits complete bundle (extras/variants/basePrice); reader↔generator parity; regenerate committed artifacts`.

**Gate focus:** offline CI stays offline; the current form consumers work off the regenerated bundle (esp. La Musa `basePrice`); existing KDS manifest parity intact.

---

## Task 7 — Wire the validator into EVERY publish path + pointer-flip CAS
**Files:** Modify `catalog/catalog-publish.js` (`publishVersion`, `previewVersion`, `rollbackVersion`, `flipPointer`), `catalog/publish-edited-handler.js`, `tools/publish-version.js`; Test `catalog/catalog-publish.test.js` (+ handler tests).
**Interfaces — Consumes:** validator (Task 2). **Produces:** every publish path runs the complete validator (pre-publish AND against persisted candidate pre-flip); `flipPointer` CAS-checks `expected_active_version_id` + `draft_revision` transactionally.

- [ ] **Step 1 — failing tests:** (a) each path — `publish-version` (bypasses `validateSource` today `:50–54`), store publish, portal `publishEdited`, `previewVersion`, `rollback` — **cannot move the pointer to an invalid version** (deliberately feed an invalid candidate; assert no flip); (b) **CAS race:** publish A validated against V, an intervening publish B flips, A's flip **aborts** (no overwrite of B) — reproduce with A's expected version stale; same for an intervening draft edit.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement one shared validator call on all paths + `flipPointer` transactional CAS on expected active version id + draft revision.
- [ ] **Step 4:** run, verify PASS; mutation-check (remove a path's validator call; remove the CAS) each kills a test.
- [ ] **Step 5:** commit `fix(catalog): validate on every publish path + pointer-flip CAS (closes publish-freshness race)`.

**Gate focus (money):** pointer can never move to an invalid/unsafe version on ANY path; no stale publish overwrites a newer one; rollback target strict-reader-compatible.

---

## Task 8 — Provenance-merge migration + draft schema-upgrade
**Files:** Create `tools/migrate-catalog-display.js`; Test `tools/migrate-catalog-display.test.js` + a parity suite over serialized carts.
**Interfaces — Consumes:** validator, reader, `computeServerTotal`. **Produces:** builds a migration candidate = **captured active version (prices/served values win) + display fields merged from deployed serving artifacts by field-level provenance** (reject ambiguous matches, reconciled via the pricing resolver); **upgrades each `meta/source` draft in place** to the new schema without publishing its edits.

**Carried from Task 1 (exposure resolver) — fold into the migration:**
- **X.Pizza exposure must be AUTHORED, not extracted:** X.Pizza has NO exposure data today — its rule is implicitly "all extra-categories" minus the `pizza.name === 'Nutella'` exclusion. So the provenance merge cannot *extract* an X.Pizza allow-list; it must **author** it: allow = all extra-categories, plus the Nutella item-level `deny: ALL`. (La Musa has real `EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM` to extract.)
- **Legacy maps are OUTPUT-ONLY:** `deriveLegacyMaps` is lossy (can't express a deny, e.g. Nutella) — never read a legacy map back as an exposure *source*. The migration reads the shipped literals ONCE to construct the new exposure model, then the model is authoritative; `deriveLegacyMaps` only produces compatibility output for pre-1B consumers.

**Carried from Task 3 (desde derivation) — fold into the migration:**
- **STRIP the authored `variant_items[…].basePrice` from every captured active version + every upgraded draft.** Captured active versions carry an authored `basePrice` (that's what ships today), but Task 3 made the validator REFUSE a present authored `basePrice` (desde is derived, never authored). So the provenance merge must strip it (exactly as `seed-source-store.js` now does) — otherwise the upgraded draft **fails validation on the merchant's next portal publish**. The bundle re-emits `basePrice` DERIVED via `deriveStartingPrice`, so the served output is unchanged; only the authored copy in the source is removed.

- [ ] **Step 1 — failing tests:** (a) migration built from a captured active version that **includes a live price differing from code** serves + charges **identically** afterward (dishes + extras, both brands) — assert over **serialized carts** (multi-pizza instances, repeated X.Pizza extra occurrences, La Musa qty extras, Nutella-exclusion, rice_03), originated from the real reader + `computeServerTotal`; (b) an ambiguous display↔price match → migration **rejects** (no guess); (c) an upgraded draft **validates on the next portal publish** (Task 7) while its pending price edit is preserved and unpublished; (d) the migration is **CAS-bound** — a concurrent active-version change invalidates it.
- [ ] **Step 2:** run, verify FAIL.
- [ ] **Step 3:** implement the provenance merge + draft upgrade; never rebuild prices from code.
- [ ] **Step 4:** run, verify PASS.
- [ ] **Step 5:** commit `feat(catalog): provenance-merge migration (captured active version + deployed display artifacts) + draft schema-upgrade; byte-identical over serialized carts`.

**Gate focus (money, HARDEST):** zero charged/served change; no live edit reverted; ambiguous matches rejected; drafts upgraded without publishing edits; parity proven over real carts incl. a live-≠-code case.

---

## Task 9 — Cutover runbook (owner-run)
**Files:** Create `docs/superpowers/runbooks/2026-09-09-portal-1a-cutover.md`.

- [ ] **Step 1:** write the runbook, pinned to code (exact counts, CLI output tags, log tags; a suite fails if they drift): pre-check `git fetch`+confirm origin/main → capture active version → run migration (provenance merge, CAS-bound) → parity suite over serialized carts (both brands, incl. live-≠-code) MUST pass → `publish-version --from-store` with the strict validator + pointer-flip CAS → verify (reader identity + serving byte-identical) → prod behavior check (both brands order priced correct; La Musa desde shows; a form still renders off the regenerated bundle). Rollback: `tools/rollback-version.js --to <prior>` to a strict-reader-compatible target.
- [ ] **Step 2:** commit `docs(catalog): portal 1A cutover runbook (provenance migration + parity gate + strict-reader rollback)`.

**Gate focus:** the runbook's parity gate REFUSES a non-identical / edit-reverting cutover; rollback target is strict-reader-compatible.

---

## Self-Review
- **Spec coverage:** Component A→Task 7 (validator every path + CAS); B→Task 4; C→Task 2; D→Tasks 1,2,4; E→Task 3; F0→Task 2 (rendering safety); F→Tasks 2,4 (inventory/validation), 6 (emit); G→Task 8 (migration/provenance/draft-upgrade); H→Task 6 (offline/parity); I→Task 5 (identity/no-fallback). All components covered.
- **Placeholder scan:** none — each task names exact files, interfaces, and the specific test assertions (the contract); the executor authors implementation code per the relay model and the advisor gates each.
- **Type/name consistency:** `resolveExposure`/`deriveLegacyMaps` (T1) used in T2/T4/T6; `validateSource`/`assertDisplaySafe` (T2) used in T4/T7/T8; `deriveStartingPrice`/`basePrice` alias (T3) used in T6; `getRestaurantMenu` `{items,extras,variants,structure,identity}` + `content_hash` (T5) used in T6/T8; `flipPointer` CAS (T7) used in T8/T9. Consistent.

## Execution posture
Relay-driven per governance: executor builds each task LOCAL-ONLY → advisor source-audit → codex money-gate (heaviest: T2, T7, T8) → next task. Then the closing full-slice money-gate → owner runs Task 9 cutover. Nothing pushed until the owner deploys.
