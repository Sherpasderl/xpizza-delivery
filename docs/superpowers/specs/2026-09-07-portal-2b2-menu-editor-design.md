# Portal Phase 2b-2 — Merchant Menu Editor (UI) — Design Spec

**Date:** 2026-09-07
**Status:** DESIGN — awaiting owner review
**Depends on:** 2b-1 write path (`editCatalog` / `publishEdited`) — **built, money-gated, deployed to prod**. Source inversion 2a (data is the pricing authority) — **live**.
**Mock (approved design direction):** the Sherpa Merchant Portal artifact (master-detail editor, Productos/Opcionales tabs, item drawer, Pedidos, Horario, sober day/night). The mock shows the **full portal vision**; this spec scopes the **first shippable slice** — the menu editor — and explicitly defers the rest.

---

## 1. Goal

Give a merchant owner a self-serve web portal to edit their live menu — item prices, names, descriptions, category structure, and add-on extras — and publish those changes to the authoritative Firestore catalog through the existing, money-gated 2b-1 write path. Plus one adjacent instant control: toggling an item sold-out ("86").

**Non-goal for this slice:** photos, required-choice variants (Pad Thai proteins), redeem-eligibility editing, and the other portal surfaces (Pedidos, Horario, Ventas). These are named in §9 as their own later slices.

---

## 1a. GLOBAL CONSTRAINT — brand-agnostic / multi-tenant (HARD)

**Every capability in the portal MUST work for ANY merchant, driven by per-merchant configuration and capability flags — never by hardcoded brand checks.** Onboarding a new merchant is a config operation, not a code change. This is a non-negotiable gate on every slice.

- **No brand literals in new code.** Any `rid === 'x_pizza'` / `'la_musa'` (or equivalent) branch in new portal/editor/backend code is a defect, unless it is demonstrably a lookup keyed off per-merchant config. The existing `usesPlatformFactura(rid)` (a `Set` membership test — `factura/eligibility.js`) is the **canonical pattern to follow everywhere**: a capability flag, true for x_pizza today, that a future merchant simply joins by config.
- **Fiscal is a capability flag, not a special case.** Any merchant flagged `usesPlatformFactura` gets the owner + `fiscalAck` publish gate; any merchant not flagged skips it — same code path. (Fiscal remains X.Pizza-only *in practice* per the owner's standing rule; the point is the CODE never special-cases the brand.)
- **Key strategy is per-merchant config.** Pricing/availability key derivation (name vs id) resolves through per-restaurant config. New merchants default to the **id-based, stable-slug** model (the la_musa shape); name-based keying is the legacy x_pizza case, not a template for onboarding. *Current-state debt (grill-confirmed 2026-09-07):* the derivation is still hardcoded `rid === 'la_musa' ? id : name` (`form-menu-source.js:109`, `source-store.js:20`). Read-only 2b-2a is unaffected (it renders keys as data), but **moving key strategy to per-merchant config is a HARD prerequisite for the write slices (2b-2b onward) and any third-merchant onboarding** — see §9.6.
- **The variant primitive (§9.2) is the clearest instance** — it must be generalized off the la_musa-only build branch before it ships, so any merchant with sizes/proteins/bases gets it by config.
- **Every task's gate asks:** "would this work, unchanged, for a brand-new third merchant with only config?" If not, it's not done.

---

## 2. Grounding — what the backend actually supports

Verified from source (2b-1 audit, 2026-09-07). This is the contract the UI is built against.

### 2.1 The editable `source` (published via `editCatalog`/`publishEdited`)
`source = { restaurant_id, items[], extras[], structure{} }`
- **item** = `{ key, price, display, has_photo }`
  - `key` — the **immutable pricing identity**. Derived and validated: x_pizza → `display.name`, la_musa → `display.id`. (`source-store.js` `pricingKeyOf`.)
  - `price` — **positive integer**, the money authority.
  - `display` — stored **verbatim**: `{ id, cat, name, price, desc, tags, color, emoji, subcat, variantOf?, choice? }`.
  - **Invariant (money-safety):** `display.price`, if present, must equal `price`. The UI must write both together.
- **extras[]** — flat, restaurant-global array of `{ key, price, display? }`. Same brand key asymmetry (x_pizza → `display.name`, la_musa → `display.id`). Add / remove / reprice all supported. Which items expose which extras is `structure.extras_by_item` / `extras_by_category` (form-side today; carried as data).
- **structure** — `{ categories[] (ordered {id,name,subcats?,layout?}), item_order[] (strict bijection with items), variant_items?, pickup_only_cats, weekend_only_cats, redeem_eligible_*, extras_by_*, has_photo }`.
  - Category rename/reorder = edit `structure.categories`. Item→category = `display.cat`. Item ordering = `item_order`.
- **descriptions** live in `display.desc` — a diff-visible, publishable field.

### 2.2 The publish gate (already enforced by 2b-1 — the UI must satisfy it)
`editCatalog(rid, source, baseSourceUpdateTime) → { updateTime, baseActiveVersionId, sourceHash, diff, token }`
`publishEdited(rid, token, acknowledgedChanges, fiscalAck?) → { versionId }`
- **CAS:** `editCatalog` writes `meta/source` under `lastUpdateTime == baseSourceUpdateTime` → `409 stale_edit` on drift.
- **Token binding:** `publishEdited` re-matches an HMAC over `{rid, baseActiveVersionId, sourceUpdateTime, sourceHash, diff}` → `409 edit_superseded` on any drift. A publish can land only the exact reviewed draft against the exact reviewed live version.
- **largeChangeSet ack:** if `diff.largeChangeSet` is non-empty, the caller must echo back the **exact** set of `{key, surface}` (equal membership both ways; a bare `true`/subset/superset is rejected → `400 large_change_unconfirmed`). Reasons: nonpositive price, new priced item, >50% price swing, removal.
- **x_pizza fiscal gate:** `usesPlatformFactura('x_pizza')` → `publishEdited` requires `auth.role === 'owner'` (else `403 not_owner`) **and** `fiscalAck === true` (else `403 fiscal_ack_required`). **la_musa is not gated** (owes no SAR factura).
- **Auth:** `authorizeCatalogEdit` — owner tier (`restaurants/{rid}/owners/{uid}`) required for x_pizza publish; customer token rejected; read outage → 503 not 403.

### 2.3 What is OUTSIDE this path (architectural corrections vs the mock)
- **Item availability ("86" / sold-out) is a separate, instant RTDB write**, not a catalog publish. It lives at `restaurants/{rid}/item_availability/{availKey}` and is written today only by the KDS (`setItemAvailability`). Server intake enforces it fail-open (`availability-gate.js`). → In the portal, 86 is an **instant toggle**, NOT part of the draft/Revisar-y-publicar flow.
- **Images:** no image storage exists anywhere in the catalog — only a `has_photo` boolean; real photos are static `images/{id}-card.webp` files. → **Deferred** (§9).
- **Required variants (`structure.variant_items`):** carried verbatim, but only built for la_musa, **not referentially validated**, and unsupported in the x_pizza build. → **Deferred** (§9).
- **A read endpoint to load the editable source does not exist yet.** `editCatalog` is a write. The editor must first READ the current `source` + its `updateTime` (for the CAS baseline). This slice adds a small read function `getEditableCatalog` (owner-authorized read of `meta/source`, returns `{ source, sourceUpdateTime, activeVersionId }`). Read-only, no money surface.

---

## 3. Scope

### In (v1)
- Load the live editable catalog (via new `getEditableCatalog`) and render it master-detail (categories → items).
- Edit **item price** (writes `price` + `display.price` together), **name**, **description** (`display.desc`), **category membership** (`display.cat`).
- **Category** create / rename / reorder / delete (with its items) — `structure.categories` + `item_order`.
- **Extras** (Opcionales tab): create / rename / reprice / remove flat extras — `source.extras`.
- **Add / remove item** — constructs a valid `source` item (key, price, display, category, item_order entry).
- **Review & publish** — `editCatalog` → server diff → review modal (largeChangeSet ack + x_pizza fiscalAck owner gate) → `publishEdited`. Full error handling.
- **Instant 86 toggle** — separate path (new owner-authorized availability write, or reuse `setItemAvailability` semantics), immediate, fail-open, NOT part of the publish draft.
- Sober day/night UI per the mock; login via Firebase Auth.

### Out (deferred — §9)
Photos/image upload · required-choice variant editing · redeem-eligibility UI · Pedidos · Horario · Ventas · version history/rollback UI (the `rollback-version.js` tool exists; a UI is a later slice).

---

## 4. Architecture

New static site `xpizza-portal/` — vanilla JS + ES modules + Firebase Auth via CDN, no build step, git-CD Netlify (same mold as dashboard/dispatch/kitchen). Two write channels, one read:

```
                    ┌─ getEditableCatalog (READ meta/source) ──────────► load editor
  Portal (owner) ───┤
                    ├─ CATALOG CHANNEL (draft → review → publish)
                    │     editCatalog(source, baseUpdateTime) → {diff, token}
                    │     publishEdited(token, acks, fiscalAck) → versionId      [money/fiscal gated]
                    │
                    └─ AVAILABILITY CHANNEL (instant, separate)
                          setAvailability(rid, key, available)  → RTDB item_availability   [no publish]
```

**Two mental models the UI must keep distinct (and show distinctly):**
1. **Catalog edits accumulate into a draft** (prices, names, descriptions, categories, extras) → nothing is live until **Revisar y publicar** → one atomic new catalog version.
2. **86 is live immediately** — like flipping it on the KDS. It has its own instant toggle, visually separate from the "unpublished changes" affordance. (This mirrors how staff already 86 items and is the seamless behavior merchants expect.)

**Auth:** Firebase Auth email/password → `getIdToken` → bearer on every call. Server `authorizeCatalogEdit` is the authority (owner tier for x_pizza publish). The client never self-authorizes; UI gating is cosmetic.

---

## 5. Money-safety invariants the UI MUST honor

These are the non-negotiables the build and its codex gate check:

1. **Price + display.price together.** Every price edit sets both to the same integer. Never one without the other (validateSource rejects disagreement).
2. **x_pizza rename = pricing-key change = fiscal-sensitive.** For x_pizza the item `key` IS `display.name`; renaming an item changes its pricing identity and its factura line. The diff is rename-aware, but a rename is a **significant change** and rides the full gate (largeChangeSet + owner fiscalAck). The UI must make an x_pizza rename feel consequential (it appears in the review as a RENAME, gated). For la_musa (key = `display.id`), a name edit is display-only and safe.
3. **New item construction.** Adding an item builds a complete valid source entry: a stable `key`/`display.id`, `price` = `display.price` (positive int), a real `display.cat`, and an `item_order` insertion. A new priced item is a `largeChangeSet` reason → must be acked.
4. **Extras key asymmetry.** Extras follow the same x_pizza-name / la_musa-id key rule.
5. **Never bypass the gate.** Publish is only ever via `publishEdited` with the server-issued token, the exact `acknowledgedChanges`, and (x_pizza) an owner `fiscalAck`. The UI constructs no version directly and drops no gate.
6. **Availability is fail-open and never fiscal.** The 86 write cannot affect pricing or the factura; it only sets `available`.

---

## 6. UX (per the approved mock)

Reference: the published Sherpa Merchant Portal artifact. Salient, in-scope pieces:
- **Master-detail:** category rail (left) + item list (right). Productos / Opcionales tabs. Search.
- **Inline fast edits in the list:** price, and the **instant 86 toggle** (which now visibly reads as "live," distinct from draft edits).
- **Item drawer** (click a product): name, description, category (select), price (with the x_pizza fiscal note), and — in v1 — the **optional extras** attached to the item (`extras_by_item`). *Image zone and required-choice group are shown as "próximamente" / disabled in v1* (they map to deferred backend).
- **Unpublished-changes bar → Revisar y publicar → review modal:** the server diff (added/removed/changed/renamed), the amber largeChangeSet acknowledgement, and the gold **X.Pizza fiscal authorization** (owner-only). Publish → new live version + toast.
- Sober palette, pure-white day / warm-dark night, Hanken, restrained sapphire accent, the transition polish.

---

## 7. Components / decomposition (buildable slices, each independently codex-gateable)

- **2b-2a — Shell + auth + read-only load.** `xpizza-portal/` scaffold; Firebase Auth login → `getIdToken`; new `getEditableCatalog` read function (owner-auth, returns `{source, sourceUpdateTime, activeVersionId}`); render master-detail read-only. No writes. *Gate: auth correctness, read-only safety, 503-on-outage.*
- **2b-2b — Editor (draft construction, no publish).** Inline + drawer edits for price/name/desc/category; category CRUD + reorder; extras add/remove/reprice; client builds a valid `source`; dogfood `editCatalog` to prove the source validates and the diff matches intent. *Gate: source-construction correctness, all §5 money invariants, x_pizza rename awareness.*
- **2b-2c — Review & publish.** Review modal from the server diff; exact largeChangeSet ack; x_pizza owner `fiscalAck`; `publishEdited`; error handling (`stale_edit` → reload+rebase; `edit_superseded` → re-review; validation errors surfaced legibly). *Gate: the HARDEST money/fiscal gate — end-to-end from UI: token binding, ack exactness, fiscal owner-binding, no forged/stale/unshown publish.*
- **2b-2d — Instant availability (86).** Small owner-authorized availability write (reuse `setItemAvailability` semantics) + wire the editor's 86 toggle to it; instant, fail-open, separate from the draft. *Gate: auth + RTDB write correctness + no catalog interference.*

Each slice: TDD, LOCAL-ONLY by the executor session, per-task advisor source-audit + codex gate, owner deploys.

---

## 8. Error handling

- `409 stale_edit` (CAS) — someone/another tab changed the source; reload the source, re-apply the pending edits onto the fresh baseline, re-review.
- `409 edit_superseded` (token) — live catalog moved since review; re-run `editCatalog`, re-present the diff.
- `400 large_change_unconfirmed` — the ack set drifted; recompute and re-ack.
- `403 not_owner` / `403 fiscal_ack_required` (x_pizza) — surface a clear "solo el propietario puede publicar cambios de X. Pizza" / "confirmá la autorización fiscal".
- `503` on read outage — degrade to read-only with a banner; never present a false-authorized editor.
- Validation errors from `validateSource` — mapped to human, field-anchored messages (e.g. "el precio debe ser un número entero positivo").

---

## 9. Deferred (each its own spec → plan → build → gate)

1. **Photos** — new backend: image storage (Firebase Storage or form-folder deploy pipeline), a catalog image reference, order-form render. Then the drawer's upload zone goes live.
2. **Required-choice variants** (Pad Thai Proteína) — **the priority next slice after the core editor**, not an indefinite deferral. Required choices (sizes, proteins, "choose your base") are a first-class multi-tenant capability: incoming merchants will need it, so it must become a **brand-agnostic, validated platform primitive**, not the la_musa-only, unguarded mechanism it is today. Sequencing (why it can't ride in the first editor slice): (a) generalize `variant_items` beyond the la_musa build branch so every restaurant supports it uniformly; (b) add `validateSource` referential integrity — every `variantIds` entry must resolve to a real item, `basePrice` must agree, keys must be consistent; (c) define the fiscal representation of a variant line for `usesPlatformFactura` brands (an x_pizza required-choice must have a correct SAR factura line). Only once variants are a hardened primitive is it safe to expose a self-serve editor for them. **The editor UI is already designed for this** — the approved mock's required-group model (single-select, re-prices, radio) is the exact target shape; v1 renders that control **disabled ("próximamente")** so the drawer needs no restructuring when the primitive lands. **Target model (breadcrumb — full design deferred to this slice; DoorDash/Toast/Square-validated, owner-referenced 2026-09-07):** the industry uses ONE reusable **modifier group** primitive, not two mechanisms — a group with **Rules** (required/optional, single/multi, min/max) whose **options are priced**, attached to one-or-many items. This slice should *unify* today's split (flat `extras` = optional up-charge; `variant_items` = required, la_musa-only, absolute-price) into that single model. Open fork for its spec: option pricing as **up-charge** (industry norm, composes with min/max) vs **absolute** (today's la_musa shape). Nested modifiers out of scope.
3. **Redeem-eligibility UI** — express `structure.redeem_eligible_*` allowlists in the portal (money-adjacent; rewards path).
4. **Version history + rollback UI** — surface published versions and `rollback-version.js`.
5. **Pedidos**, **Horario**, **Ventas** — separate subsystems (Horario also generalizes x_pizza's weekend-only logic; Ventas needs order-record enrichment + daily rollups, never `/orders` full-scan).
6. **Key-strategy → per-merchant config (backend prerequisite for the write slices).** The item/extra pricing-key derivation is hardcoded per brand today (`rid === 'la_musa' ? id : name`). Before the editor's write slices (2b-2b onward) or any third merchant, move it to per-restaurant config/capability (default: id-based stable slug), following the `usesPlatformFactura` Set-flag pattern. Read-only 2b-2a does not depend on it, but nothing that *writes* a key can ship until this lands. Its own spec → plan → gate.

---

## 10. Resolved decisions

- **Required-modifier storage fork → RESOLVED: sequenced, not shelved.** v1 builds on the fully-supported, safe surface (items/prices/descriptions/categories/extras). Required-choice variants are a **first-class multi-tenant capability** (new merchants will need sizes/proteins/bases), so they are the **priority next slice** — but they require the backend to first become a brand-agnostic, referentially-validated, fiscally-correct primitive (§9.2). The order is: ship the safe core editor, harden `variant_items` into a platform primitive, then turn on the required-group editor (already designed into the drawer). This avoids smuggling a checkout/fiscal-touching, single-brand, unvalidated mechanism into the first editor slice.
- **86 model → RESOLVED: instant, separate channel** (not part of the publish draft), matching the real RTDB architecture.
- **Images → RESOLVED: deferred**, shown disabled in v1.

---

## 11. Testing

- **Unit:** client source-construction (given editor state → valid `source`; price/display.price agreement; x_pizza vs la_musa key derivation; new-item construction; category reorder → valid `item_order` bijection).
- **Integration (dogfood against emulator/deployed):** editCatalog round-trip (source validates, diff matches intent); publishEdited happy path both brands; each gate rejection (missing fiscalAck for x_pizza, wrong ack set, stale token, customer token).
- **Regression guards:** availability write never touches catalog; publish path unchanged for existing 2a/2b-1 suites (this slice is additive UI + one read fn + one availability write).
- **Manual smoke:** fresh owner account, edit a la_musa price → publish → verify new version + order-form price; edit an x_pizza price → fiscal gate → publish; 86 an item → instant on both KDS and order form.
