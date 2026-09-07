# Portal Phase 2a — Complete Source Inversion Implementation Plan

> **For the executor session:** build task-by-task, LOCAL-ONLY, off current `origin/main`. Each task ends in a green test + a commit. This is 🔴 MONEY/FISCAL-adjacent (the pricing/menu source of truth) — advisor source-audits + runs the HARDEST codex money-gate on the built diff; owner runs the gated cutover. Do NOT push/deploy/cut-over. Spec: `docs/superpowers/specs/2026-09-06-portal-2a-source-inversion-design.md`.

**Goal:** Make `restaurants/{rid}/source` (Firestore) the single authority for everything menu-derived — publish pipeline + every server consumer — with a **provable byte-identical no-op cutover** and **no production path that silently reads stale `menu-pricing.js` after a store edit**.

**Architecture:** Seed the store from code → build/publish source from the store via the already-source-agnostic `buildCatalogV2` (new structured `formData` path) → a **pre-flip code-vs-store parity gate** guarantees the no-op → migrate the four drift-prone consumers (weekend gate, reward eligibility, reorder, restaurant-id) to the store/catalog → `menu-pricing.js` becomes a frozen fallback only.

**Tech Stack:** Node (`xpizza-functions/`), Firestore (Admin SDK), the existing `catalog/` publish pipeline, Node test files (`node <file>.test.js`) wired into the npm chain.

## Global Constraints (the airtight bar — every task inherits these)
- **Fail-closed:** `readSource`/`validateSource` throw on missing/malformed → publish aborts before any write. No consumer silently defaults to `menu-pricing.js` for a value that should track store edits (fallback is last-resort only).
- **Provable no-op:** the cutover MUST fail-closed unless build-from-store is canonically identical to build-from-code (counts + both content hashes + structure), per brand.
- **Canonical serialization pinned:** a single `canonicalize(obj)` (stable recursive key ordering) used wherever store-authored objects feed a hash/descriptor, so property order can't diverge the descriptor.
- **Complete schema:** the store carries every field the code path reads; a test enumerates the code literal set and asserts coverage.
- **No landmine for 2b:** after 2a, no production consumer imports `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` as a live authority (only as fallback) — asserted by a guard test.
- **Both brands** (x_pizza, la_musa) proven at every parity step. Existing catalog/fiscal/rewards/menu-parity tests stay green (catalog output is byte-identical at cutover).

---

### Task 1: Store schema + reader + validator (`catalog/source-store.js`)

**Files:** Create `catalog/source-store.js`, `catalog/source-store.test.js`. Reference (read current shapes): `menu-pricing.js` (`MENU_BY_RESTAURANT`, `EXTRAS_BY_RESTAURANT` = `EXTRA_PRICES` x_pizza / `LA_MUSA_EXTRAS` la_musa), `catalog/form-menu-source.js` (`readLiteral` field set, `pricingKeyOf`), `catalog/catalog-firestore.js:38-40` (price-validity rule). **Attribution correction (Task-1 handback):** `EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM` and the `EXTRAS` display arrays live **form-side** (`la-musa-orders`/`xpizza-orders` `index.html`), NOT `menu-pricing.js`, and no server consumer reads them today — the portal owns them in 2b, so the store schema carries them and the completeness test asserts them by name.

**⚠️ EXTRAS pricing-key asymmetry (verified — a seed landmine):** extras have the SAME name-vs-id split as items. x_pizza extras price by **name** (`EXTRA_PRICES['Salsa Roja']`) while the form `EXTRAS` entry is `{id:'e1', name:'Salsa Roja', price:39}` — so `e1` is a display id, NOT the price key. la_musa extras price by **id** (`LA_MUSA_EXTRAS['rice_white']`, form id === price key). `validateSource` MUST guard the extras key the same way it guards item keys: the `extras.prices` key must equal the brand's extras pricing-key of the display record (x_pizza → `name`, la_musa → `id`) — so a mis-keyed extra is CAUGHT, never silently round-tripped. Also: the form `EXTRAS` entry's inline `price` must equal `extras.prices[key]` (an extras parity, analogous to `menu-parity` for items).

**Interfaces produced:**
- `readSource(db, rid) → source` (throws `source_missing`/`source_malformed`; never partial)
- `validateSource(source, rid) → void` (throws on: non-positive-int price, missing required field, item key↔item non-bijection, **extras key ≠ extras pricing-key of its display record** [x_pizza=name / la_musa=id], **form `EXTRAS` inline price ≠ `extras.prices[key]`**, unknown-cat reference)
- `sourceToBuildInputs(source) → { priceTable, formData, extras }` — `formData` = structured `{ dishes, item_order, categories, variant_items, pickup_only_cats, weekend_only_cats }`
- `canonicalize(obj) → obj` (stable recursive key ordering)

- [ ] **Step 1 — failing test:** write `source-store.test.js` asserting: (a) `validateSource` throws on a float price, a missing `prices` key for an item, and a dangling category; (b) `sourceToBuildInputs` on a hand-built fixture returns the expected `{priceTable, formData, extras}`; (c) `canonicalize({b:1,a:2})` key order is stable; (d) **schema-completeness:** the set of `readLiteral(...)` names used in `form-menu-source.js` is a subset of the fields `sourceToBuildInputs` consumes (parse the names from source, assert coverage — guards a future code-only field).
- [ ] **Step 2 — run, verify fail** (`node source-store.test.js` → module not found / assertions fail).
- [ ] **Step 3 — implement `catalog/source-store.js`** with the four functions. `validateSource` mirrors `catalog-firestore.js:38-40` price rules + `pricingKeyOf` bijection. `sourceToBuildInputs` maps the store object to the exact shapes `buildCatalogV2` will consume (Task 2).
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit** (`feat(catalog): source-store reader/validator + canonical serialization (portal 2a)`).

---

### Task 2: `buildCatalogV2` structured `formData` path (`catalog/form-menu-source.js`)

**Files:** Modify `catalog/form-menu-source.js` (`buildCatalogV2`); Test `catalog/form-data-path.test.js`.

**Interfaces:** `buildCatalogV2(rid, { formData, priceTable, extras? })` — when `opts.formData` is present, use it directly instead of `readLiteral`-ing `opts.formSource` text. MUST return `{items, structure}` **identical** to the text path.

- [ ] **Step 1 — failing test:** `form-data-path.test.js`: for BOTH brands, derive `formData` from the current form (via the existing text parse), then assert `buildCatalogV2(rid,{formData,priceTable:code})` `deepStrictEqual` `buildCatalogV2(rid,{formSource:text,priceTable:code})` — identical `items` (incl. `display` verbatim + `has_photo`) AND `structure` (incl. `item_order`, categories, variant_items, gate cats).
- [ ] **Step 2 — run, verify fail** (formData path not implemented).
- [ ] **Step 3 — implement** the `formData` branch: when given, read dishes/categories/variants/gate-cats from the structured object rather than `readLiteral`. Preserve `item_order` and `display` verbatimness exactly. **RULING (Task-2 handback): categories are STORE-AUTHORED for BOTH brands** — the `formData` path reads `categories` from the store (no x_pizza derive special-case). The TEXT path keeps deriving x_pizza (it's the seed bootstrap, no `CATEGORIES` literal); the seed (Task 3) authors x_pizza's `categories` = that exact derived result (id-only, dish order) so cutover stays byte-identical (parity gate enforces). `validateSource` enforces **`categories ⊇ distinct(dishes.cat)`** (a dropped-but-referenced category throws — replaces the derive-self-consistency protection, and also catches a dangling dish).
- [ ] **Step 4 — run, verify pass** (both brands identical).
- [ ] **Step 5 — commit** (`feat(catalog): buildCatalogV2 structured formData path (identical to text path)`).

---

### Task 3: Seed migration code→store (`tools/seed-source-store.js`)

**Files:** Create `tools/seed-source-store.js`, `catalog/seed-source.test.js`. Reference: `tools/publish-version.js:15-35` (how it assembles inputs today).

**Interface:** `buildSourceFromCode(rid) → source` (pure; assembles the store object from `MENU_BY_RESTAURANT`+`EXTRAS_BY_RESTAURANT`+form literals) + a thin CLI wrapper that writes `restaurants/{rid}/source` (idempotent; diff-logs if present).

- [ ] **Step 1 — failing test:** `seed-source.test.js`: `validateSource(buildSourceFromCode(rid), rid)` passes for both brands; `sourceToBuildInputs(buildSourceFromCode(rid))` reproduces the exact `{priceTable, formData, extras}` the code path uses (round-trip: build-from-that == build-from-code); **extras-key guards:** the seed keys x_pizza extras by **name** and la_musa by **id** (assert `extras.prices` keys deep-equal `EXTRA_PRICES`/`LA_MUSA_EXTRAS` keys respectively — NOT the form `id` like `e1`); and a deliberately mis-keyed x_pizza extra (keyed by `e1`) makes `validateSource` **throw** (proves the landmine is caught).

**Note:** this task EXTENDS the already-delivered `validateSource` (Task 1) with the extras-key + extras-inline-price guards before the seed relies on them.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement** `buildSourceFromCode` (pure assembly) + the CLI writer (Admin SDK, `GOOGLE_CLOUD_PROJECT` pinned per the publish-version lesson).
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit** (`feat(catalog): seed source-store from code (idempotent, round-trip proven)`).

---

### Task 4: Publish-from-store + the pre-flip PARITY GATE (`tools/publish-version.js`, `catalog/catalog-publish.js`)

**Files:** Modify `tools/publish-version.js` (add `--from-store`), `tools/verify-catalog.js` (store-aware); Create `catalog/publish-parity.test.js`. Reference: `catalog/catalog-publish.js:222-234` (publishVersion), `catalog/catalog-integrity.js:35-67` (descriptor/hash).

**Interface:** a pure `catalogDescriptor(rid, {items, structure, extras}) → {counts, hashes, structure}` (reuse `catalog-integrity`); the cutover computes it for code-built AND store-built inputs and **throws `parity_mismatch` unless canonically identical, BEFORE `flipPointer`.**

- [ ] **Step 1 — failing test:** `publish-parity.test.js`: (a) code-built descriptor `deepStrictEqual` store-built descriptor for both brands (the no-op proof); (b) a deliberately mutated store (one price changed) makes the parity gate THROW (proves it blocks a non-identical cutover — the C3 guard); (c) `publishVersion` self-integrity alone does NOT catch the mutated-but-positive price (documents why the explicit gate is needed).
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement:** `--from-store` path in publish-version (`readSource`→`sourceToBuildInputs`→`buildCatalogV2({formData,priceTable})`→ parity-gate vs code-built → `publishVersion(...,{extras})`); make `verify-catalog.js` read the store and assert store==code descriptor.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit** (`feat(catalog): publish-from-store + pre-flip code-vs-store parity gate (portal 2a)`).

---

### Tasks 5–8: Consumer migrations (no silent-drift landmines)

Each follows the SAME rhythm: failing per-consumer parity test (store==code → identical behavior; store-added item → consumer tracks it, code-only would drop it) → migrate the consumer to source from the store/catalog → keep `menu-pricing.js` as fallback ONLY → pass → commit. Each is independently reviewable.

- **Task 5 — `weekendOnlyViolation`** (`menu-pricing.js:35-52`, both intake sites `index.js:699/1202`): source weekend cats from the resolved catalog/store, not static `X_PIZZA_WEEKEND_ONLY`. Test: same verdict at store==code (both brands); a store weekend-cat change flips enforcement (code-static would not). **Money-adjacent — pre-charge gate.**
- **Task 6 — reward eligibility** (`rewards-redeem-config.js:25-43` X.Pizza `X_PIZZA_REDEEM_ELIGIBLE`; `:36-55` La Musa accompaniments): derive eligible set + accompaniments from store/catalog. Test: identical eligibility at store==code; a store-added pizza becomes eligible (code-static would omit it). **Money-adjacent — redemption.**
- **Task 7 — `reorder-normalize`** (`reorder-normalize.js:9-16`): source menu/extras from store/catalog. Test: a store-added item/extra survives reorder normalization (code-static would drop it).
- **Task 8 — `restaurant-id`** (`restaurant-id.js:3-8`): known-restaurant set store/registry-driven (not derived from `MENU_BY_RESTAURANT`). Test: our two brands resolve identically; a registry-added rid resolves (code-derived would 404). Enables merchant #3.

Each: `git commit -m "feat(catalog): migrate <consumer> to store/catalog source (no code drift)"`.

---

### Task 9: The airtight guards + full-suite green

**Files:** Create `catalog/no-code-authority.guard.test.js`; wire all new tests into `package.json` `scripts.test`.

- [ ] **Step 1 — failing guard test:** assert **no production module** (exclude `menu-pricing.js` itself, tests, tools, and the resolver's explicit fallback wiring) imports `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` as a live authority — grep the source for `require('./menu-pricing')` usages and assert each remaining one is a fallback path (allow-list the resolver ladder + seed/bootstrap). This is the landmine guard.
- [ ] **Step 2 — run:** it will FAIL listing any consumer not yet migrated (should pass once Tasks 5–8 land; if it fails, a consumer was missed — fix before proceeding).
- [ ] **Step 3 — wire the chain:** append the new tests (`source-store`, `form-data-path`, `seed-source`, `publish-parity`, the four consumer tests, `no-code-authority.guard`) into `package.json` `scripts.test`.
- [ ] **Step 4 — full suite:** `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` → EXIT 0, including every existing catalog/fiscal/rewards/menu-parity test (unchanged — output is byte-identical).
- [ ] **Step 5 — commit** (`test(catalog): landmine guard + wire portal-2a tests into chain`).

---

### Task 10: Cutover runbook (doc, no code)

**Files:** Create `docs/superpowers/runbooks/2026-09-06-portal-2a-cutover.md`.

Document the owner-run, gated cutover: (1) seed store both brands; (2) run the parity suite (build + publish-descriptor + per-consumer), all identical; (3) publish `--from-store` with the parity gate armed; (4) `verify-catalog.js` store-aware = "catalog == code ✓"; (5) confirm the frozen-fallback state. Any parity failure → abort (flip never happens, nothing customer-facing touched). Include rollback (prior version retained; atomic pointer).

- [ ] Commit (`docs(catalog): portal-2a source-inversion cutover runbook`).

---

## Self-Review
- **Spec coverage:** complete schema (T1) ✓; formData path (T2) ✓; seed (T3) ✓; publish-from-store + pre-flip parity gate (T4, grill C3) ✓; all four consumer migrations (T5-8, grill C5) ✓; canonical serialization (T1) ✓; no-landmine guard (T9) ✓; cutover runbook (T10) ✓; fail-closed + both-brands + existing-tests-green (Global Constraints) ✓.
- **Placeholder scan:** consumer-migration tasks (5-8) intentionally reference current source at cited anchors rather than reproducing full bodies (the executor source-audits + implements against live code, then the codex money-gate verifies) — each has a concrete, testable parity assertion, not a vague "handle it."
- **Type consistency:** `readSource`/`validateSource`/`sourceToBuildInputs`/`canonicalize`/`catalogDescriptor` names used consistently across T1/T2/T4.
- **Interfaces block for the executor:** T1 produces the reader/validator that T2 (formData), T3 (seed round-trip), T4 (publish + parity), and T5-8 (consumers) all consume.
