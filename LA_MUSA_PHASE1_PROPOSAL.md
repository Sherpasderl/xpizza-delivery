# Proposal A (Rev 3) — Server Phase 1: `restaurant_id` acceptance + restaurant-keyed pricing

_Executor → Auditor + Codex. Rev 3 folds in the Codex Rev-2 byte-identical catches: restaurant-keyed
lookup (**not** `id || name`), the fingerprint change **dropped** (kept v1), idempotency compare
**normalizes legacy → x_pizza**, and a tightened safety statement. Builds on the multi-rate-tax
retraction (Rev 1) and the ordering/skip/defer fixes (Rev 2). **X. Pizza byte-identical is the
centerpiece.** La Musa stays `active:false` throughout. Strict propose-first — no code until APPROVED._

---

## Goal
Make a La Musa order creatable, correctly priced, stamped `la_musa`, and routed against La Musa's
config — through the **same** handlers as X. Pizza, with X. Pizza output **byte-identical**. No
platform factura and **no ISV split** for La Musa (its SAR factura is issued by Soft Restaurant
POS — `ORDER_FORM_FEATURES.md §5`, `factura/eligibility.js:30-35`).

## Decomposition (each independently golden-tested; implement in order)
**A1** restaurant-keyed pricing → **A2** tax/factura branch → **A3** `restaurant_id` acceptance +
top-of-handler ordering + fingerprint. A1+A2 are pure-function changes invisible to X. Pizza and
unreachable for La Musa until A3 wires acceptance.

---

## A1 — Restaurant-keyed pricing
- `MENU_PRICES` (`index.js:213`, name-keyed) → `MENU_BY_RESTAURANT = { x_pizza: {…current 23
  items…}, la_musa: {…40 items, keyed by `id` slug…} }`. `EXTRA_PRICES` stays x_pizza-only
  (La Musa `EXTRAS = []`).
- `computeServerTotal(items)` (`:253`) → `computeServerTotal(items, restaurantId)`; the match key
  is **chosen per restaurant, not blanket `id || name`** (Codex #1): **x_pizza → `item.name`
  only** (any `id` on the payload is ignored — exactly today's contract, so a forged `id` can't
  reroute an X. Pizza payload), **la_musa → `item.id`**. X. Pizza thus has **identical lookup +
  identical `unknown menu item` rejection + identical extras loop**; La Musa matches by stable
  `id` slug.
- La Musa menu seeded **verbatim** from the form's `MENU` const (40 items — single source).
  Recommend a parity test (form `MENU` ⊆ `MENU_BY_RESTAURANT.la_musa`) shipped with Proposal B.

## A2 — Tax / factura branch (replaces the retracted multi-rate design)
- `priceBreakdownCents` (`:287`) is **untouched**. At both call sites (`:527`, `:716`) gate on the
  **existing** `usesPlatformFactura(rid)` flag (`factura/eligibility.js:35`):
  - `true` (x_pizza) → `priceBreakdownCents(total)` — **exactly today**.
  - `false` (la_musa) → `{ total_cents, subtotal_cents: total_cents, tax_cents: 0 }` (no split;
    `subtotal + tax === total` invariant preserved).
- `allocateFacturaOnSale` / `voidFacturaOnCancel` already short-circuit on the same flag
  (`:1407`, `:1468`) — **no change** (F3, already live).

## A3 — `restaurant_id` acceptance, validated at the TOP of the handler (folds #5a/#6, #3, #5b)

### Ordering (finding #5a/#6 — critical)
Today: `validateOrderPayload` (→ `computeServerTotal`, `:310`) → idempotency (`:467`) →
`getIdentity` (`:482`). `restaurant_id` must be resolved **before all three**:

1. **Parse + validate first.** At the very top of `createOrder` (before `:455`) and
   `chargeOnlineOrder` (before `:677`): read `body.restaurant_id`, validate against the known set
   `{x_pizza, la_musa}`. **Missing → `x_pizza`** + log (the live X. Pizza form sends none — keeps
   it byte-identical); **unknown → `400`**. (Strict-flip missing→400 deferred to plan step 23a.)
2. **Price against the right menu.** Thread the validated id into
   `validateOrderPayload(body, restaurantId)` → `computeServerTotal(body.items, restaurantId)`, so
   a La Musa cart is priced against the La Musa menu (not rejected as "unknown" against X. Pizza's).
3. **Idempotency compares restaurant_id, normalizing legacy → x_pizza** (Codex #3). At `:467-470`,
   when `orders/${orderId}` exists, compare **`(existing.restaurant_id || 'x_pizza')`** to the
   validated id: **mismatch → `409` conflict** (a La Musa request must not get idempotent success
   on an existing X. Pizza `order_id`); match → idempotent as today. The `|| 'x_pizza'` is
   load-bearing: a **pre-Phase-0 X. Pizza order has no `restaurant_id`**, and a strict compare
   would `409` a legit idempotent retry. Same normalized guard on `chargeOnlineOrder`'s
   pending-reuse probe (`:759-806`).
4. **Per-restaurant identity + stamp.** Replace the hardcoded `FACTURA_RESTAURANT_ID` stamp
   (`:742`) and the two `getRestaurantIdentity(db, FACTURA_RESTAURANT_ID)` reads (`:482`, `:774`)
   with the **validated id** → a la_musa order zone-checks La Musa's hub, gates on La Musa's
   `active`, stamps La Musa's snapshot. Confirm-time `getIdentity` recheck (`:1052`) reads the
   order's `restaurant_id` (materialize honors the pending record's stamped id — no new acceptance
   there).

### Fingerprint — left at v1, change DROPPED (Codex #2)
- `orderFingerprint(orderId, totalCents, itemsText)` (`pixelpay-charge.js:19`) is **unchanged**.
  Rev 2 proposed adding `restaurant_id`+phone; **dropped** — it broke byte-identity (every fresh
  X. Pizza charge's `payment_fingerprint` would change) for **no real gain**:
  - `order_id`s are **globally unique** (`PZX-<date>-<random>`), so the cross-restaurant
    same-`order_id` collision that motivated the change **cannot occur**; and
  - even hypothetically, the **step-3 `restaurant_id` compare** on the idempotency + pending-reuse
    probes already rejects a cross-restaurant `order_id` reuse with **409 before** the CAS /
    fingerprint is ever consulted.
- So step 3 **is** the cross-restaurant guard; the fingerprint never needed `restaurant_id`.
  Dropping it removes the byte-identical break **and** the entire no-open-pending migration.
- Belt-and-suspenders (not load-bearing): have La Musa's form mint a **distinct `order_id`
  namespace** so the two never share an id by construction — but step 3 is the real guarantee.

### pricedLineItems (finding #5b)
- `pricedLineItems(body.items, MENU_PRICES, EXTRA_PRICES)` (`:528`, `:722`) is name-keyed and
  feeds **`order.items`** (`create-order-build.js:45`), which is **factura-only** (the `:36`
  comment: "the allocateFacturaOnSale trigger consumes these"). Display/relay everywhere uses
  `items_text`.
- **Decision: SKIP for non-platform restaurants** (not re-key). `const facturaPriced =
  usesPlatformFactura(rid) ? pricedLineItems(body.items, MENU_PRICES, EXTRA_PRICES) : { items:
  null, error: null }`. A la_musa order then **omits** the `items` array (the builder already
  guards `...(facturaPriced.items ? { items } : {})`, `:45`) — correct, since La Musa has no
  platform factura to consume it. X. Pizza path unchanged (byte-identical). If a later phase wants
  priced lines for La Musa reporting, re-key then.

## #7 — pickup copy + task/tracking stamping (explicitly DEFERRED, not silent)
- The pickup literal `'Recoger en X. Pizza'` (`create-order-build.js:102`, `materialize.js:91`) and
  `restaurant_name` are **left untouched** for x_pizza (byte-identical). For La Musa the literal
  would read wrong, but **La Musa is dark** (no order created until launch), so this copy is never
  seen — **deferred to a later (launch) phase**.
- Phase 1 stamps `restaurant_id` on the **order** (A3) — required and sufficient for KDS filtering
  (`filterLiveOrders` reads `order.restaurant_id`). Stamping `restaurant_id` on **tasks /
  order_tracking** is **deferred** to the dispatcher/driver consumer phase (not needed for KDS or
  intake).

---

## X. Pizza byte-identical (the centerpiece)
Every new branch keys on `rid !== 'x_pizza'`. An X. Pizza order: missing id → `x_pizza`;
**name-only** lookup (unchanged — any `id` ignored); `usesPlatformFactura('x_pizza')=true` →
`priceBreakdownCents` (unchanged) + `pricedLineItems` (unchanged) → `order.items` unchanged;
**`orderFingerprint` unchanged (v1)**; idempotency compare normalizes legacy → `x_pizza` (so a
no-`restaurant_id` retry stays idempotent); `getIdentity('x_pizza')`; same stamp + snapshot +
pickup copy. **No X. Pizza-reachable field changes** — proven by the existing goldens
(`create-order-build` + `emulator-e2e` cash/online) asserting `orders/tasks/tracking` +
`total_cents/subtotal_cents/tax_cents` + `payment_fingerprint` unchanged. A new **la_musa pricing
+ no-split fixture** proves the 40-item totals, `tax_cents:0`, and the omitted factura `items`
array.

## Safety / blast radius (Codex #4 — airtight)
The two customer intake paths (`createOrder`, `chargeOnlineOrder`) resolve `getIdentity(la_musa)`
and hit the active-gate **before any La Musa order or payment is persisted** — before the order
write, and before `acquireHostedAttempt` mints a pending or any PixelPay charge is opened — so with
`la_musa.active=false` **both reject at intake**. (Precise scope: the per-phone/IP rate-limit
counter may increment ahead of the gate, but a counter is **not** an order or a pending record;
that pre-existing ordering is X. Pizza behavior and is left untouched.) Therefore **no La Musa
pending, order, or payment is ever created**, and the downstream hosted-webhook +
`confirmAndMaterialize` paths **can never receive a La Musa order** — the "materialize even when
inactive" recovery is moot because nothing upstream can create one.

One **other writer exists**: `createOrderWithTasks` (the dispatcher client, `xpizza-dispatch:857`)
**bypasses the active-gate**. It is **x_pizza-only today** — it stamps no `restaurant_id` and has
no La Musa UI — so it **cannot emit a La Musa order** in its current form. Across all paths, then,
**no La Musa order can exist** while this proposal ships. Gating `createOrderWithTasks` for La Musa
is a **hard pre-launch item** (see Out of scope) — required *before* `la_musa.active=true`, not for
Phase 1.

`restaurant_id` validation rejects unknowns; missing → `x_pizza` (no strict-flip yet). All changes
are constants/maps/one-flag branches; no fingerprint change; reversible.

## Open items for the gate
- **Matching key** is restaurant-keyed (x_pizza → name, la_musa → id) → the La Musa form
  (Proposal B) must emit `item.id`. Recommend the form-vs-server parity test ship with B.

## Out of scope
Proposal B (form parity), X. Pizza form `restaurant_id` emit + strict-flip (step 23a),
`la_musa.active=true`, pickup-copy + task/tracking stamping (deferred above), consumer phases
(dispatcher / auto-assign / WhatsApp / tracker). The La Musa distinct-`order_id`-namespace
belt-and-suspenders lands with B (form), not A.

### Hard pre-launch items (required before `la_musa.active=true`)
- **`createOrderWithTasks` La Musa-gating** (`xpizza-dispatch:857`) — the dispatcher client
  bypasses the active-gate and is x_pizza-only today; it must be made restaurant-aware (stamp +
  validate `restaurant_id`, honor the active-gate) **before** La Musa goes active, in the
  unified-dispatcher phase. Recorded in the brain so it cannot slip before launch.
