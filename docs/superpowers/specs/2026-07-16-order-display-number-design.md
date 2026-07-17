# Human-Friendly Order Number (`display_number`) — Design

**Status:** ✅ DESIGN GATE APPROVED (advisor source-gate + codex-review 2 rounds, R1:7→R2:0) · 2026-07-16
**Author:** advisor session · **Owner-gated build**

## Problem

Staff (kitchen ↔ driver ↔ dispatch) need to reference an order verbally, but the order id is
`PZX-YYMMDD-HHMMSS-XXXXXXXX` (e.g. `PZX-260716-145122-A3FK2M7Q`) — unspeakable.

## Why we DON'T change the internal id

`order_id` is load-bearing and must stay exactly as-is:
- It's the RTDB primary key `/orders/{id}` — referenced **318+ times** in functions alone, plus
  `/tasks` (`order_id`), factura (`pedido`), tracking token, dispatch, KDS, driver, dashboard.
- It's **generated client-side** (order form, before the server) and is the **payment idempotency
  anchor** — the CSPRNG suffix exists so two orders in the same second can't collide. Charset is
  validated against a server allowlist.

Changing the id ripples through all of that and breaks idempotency. **Out of scope. The id stays.**

## Approach

Add a **server-allocated, per-restaurant, daily sequential `display_number`** (integer, shown as
`#47`) stamped by a single live-transition DB trigger (see Core), never route-by-route. It is **display-only**: every surface shows `#{display_number}`
to humans, but **every functional lookup, cache key, DOM data-attribute, and API call keeps using
`order_id`**. The number is a label, never a key.

---

## THE SURFACE INVENTORY — every part of the platform this touches

Legend: **KEY** = uses `order_id` as a functional key (MUST stay `order_id`); **DISPLAY** = renders the
# to a human (gets `#N`).

| # | Surface | Repo / build session | Shows # today? | Change | Key-vs-display notes |
|---|---------|----------------------|----------------|--------|----------------------|
| 1 | **Functions — CORE** | `xpizza-functions` / **platform** | — | **Allocate + stamp `display_number`** via one live-transition trigger (see Core) | The gated piece. See §Core. |
| 2 | **KDS** | `xpizza-kitchen` / platform | yes (`order_id` on card) | show `#N` on the card header | per-restaurant (host-derived `KDS_RESTAURANT_ID`) → clean sequence. KEEP `order_id` for `pendingWrites[id]`, `dismissWrite('${id}')`, write-tracking DOM keys. |
| 3 | **Dispatch** | `xpizza-dispatch` / platform | yes (`Pedido #${order_id}` in cards/alerts/confirm/toasts) | show `#N`; **search also matches `#N`**; brand chip disambiguates | SHARED across both restaurants — already has `rest-x_pizza`/`rest-la_musa` chips → `#3 · X. Pizza`. KEEP `order_id` for `data-order-id`, `etaCache[order.order_id]`, `knownPendingOrderIds`, cancel/reassign API calls, `pickerOrderId`. |
| 4 | **Dashboard** | `xpizza-dashboard` / platform | yes (orders table + search + detail) | show `#N` in the table + **search matches `#N`** | all restaurants. KEEP `order_id` for `dataset.orderId → openOrderDetail(orderId)`, the TEST- prefix test-order filter, and the `/orders/{id}` detail read. |
| 5 | **Driver app** | `xpizza-driver` / **driver session (native, AAB)** | **NO — not shown today** | **ADD** `#N` to the order card + incoming banner | The driver *gains* the #. Knows its restaurant (`restaurantChip`) → unambiguous. KEEP `order_id` for `data-order-id`, `collapsedBanners`/`pendingIds` sets, `allOrders[task.order_id]`, accept/settle SDK calls. Rides a driver release (version bump). |
| 6 | **Tracker (customer)** | `xpizza-track` / platform | yes — `'Pedido ' + order_id` (customer-facing) | show `#N` (customer sees the friendly #) — **decision, §Locked #2** | customer-facing, not staff-verbal, but friendlier. KEEP `order_id` for the `data.order_id` lookup / tracking token. |
| 7 | **Factura** | `xpizza-factura` / **us (current factura branch)** | yes (`PEDIDO:` = order id) | add `#N` as a friendly ref; **KEEP `order_id` as the legal `pedido`** — §Locked #3 | legal traceability field stays the full id. |
| 8 | **POS (in-store)** | `~/Downloads/xpizza-pos` / **POS session (separate repo)** | online-import shows online orders in Hoy | optional `#N` on imported online rows | separate repo; reads `order.display_number` off the bridge like any other field. |

**NOT touched (verified):**
- **WhatsApp** (`whatsapp.js`) outbound status messages — link to the tracker, never print the order #. No change.
- **Order-form confirmation** (`xpizza-orders`, `la-musa-orders`) — doesn't display the id today (links to tracker). Optional customer nicety only.
- **Catering** (`xpizza-catering`) — no separate order-id flow found. Verify at build; likely none.

**Universal invariant (all surfaces):** `display_number` replaces only the *rendered* order-# text.
Every `order_id` used as a key/cache/attribute/API-arg is untouched. Getting this wrong breaks
assignment, ETA, cancel, write-tracking, order-detail, and payment idempotency.

---

## Core (functions) — the allocation  *(REV-2, codex design-review R1)*

**Mechanism: a single DB trigger, NOT route-by-route** (R1-F1/F2). Instrument one trigger — a near-clone
of `allocateFacturaOnSale`'s predicate — that fires when an order **transitions to live/Sale state**
(`status → 'new'`), the one moment every creation path converges on (cash create, ALL online materialize
routes — confirm / hosted-webhook / `materializeOnConfirm` / reconciliation / sweep — and scheduled
release). This covers routes we'd otherwise miss and **never fires on hidden `pending_payment` orders**
(so failed/abandoned payments burn no number; scheduled orders get numbered on release day, not checkout day).

Keep it a **separate function from `allocateFacturaOnSale`** — same predicate, independent state — so a
cosmetic number can never entangle the money/factura path.

**Inherently FAIL-OPEN (R1):** the trigger fires *after* the order already exists, so allocation is fully
decoupled from order creation — a counter failure (contention, rules-deny, error) can NEVER block or fail
an order. `display_number` just stays absent → surfaces fall back (§Back-compat). Brief sub-second window
where a just-live order has no number yet → fallback covers it; RTDB realtime-updates the surface when the
number lands.

**Idempotent counter — keyed by `order_id` inside ONE transaction** (R1-F3, mirrors the factura
`seq.last_reserved` + `seq.pending[orderId]` shape). Counter node:
```
/counters/order_display_seq/{restaurant_id}/{YYYY-MM-DD}  =  { last: <int>, by_order: { <orderId>: <n> } }
```
Transaction: if `by_order[orderId]` exists → return unchanged (already allocated → the number is
`by_order[orderId]`, idempotent no-op on any retry/concurrent handler); else `n = (last||0)+1`, set
`last = n` and `by_order[orderId] = n`. Because the allocate-decision AND the counter-advance happen in the
SAME transaction keyed by `orderId`, two concurrent handlers for one order converge on one number — no
double-burn, no gap.

**Stamp the number in TWO places** (R1-F4): `/orders/{id}/display_number` **and**
`order_tracking/{token}/display_number` — the customer tracker reads the public `order_tracking/{token}`
node (token-gated), NOT auth-only `/orders`. Write both when allocated (or fold into materialize's tracking write).

- **Day / timezone:** the `{YYYY-MM-DD}` key is computed **server-side**, local America/Tegucigalpa
  (never a client clock); matches the shift/factura day boundary.
- **Format:** raw integer, rendered `#47`. No zero-padding. Resets daily per restaurant (new date node).
- **`by_order` growth** is bounded per day (resets with the date key); old date nodes are tiny — optional prune.

## RTDB rules (R1-F7)

`/counters` is written by the functions via the **admin SDK (bypasses rules)**, so it needs NO client grant.
Add an explicit **`/counters: { ".read": false, ".write": false }`** deny (belt-and-suspenders against a
future accidental grant) + a guard test. Surfaces read `display_number` off `/orders` (already auth-readable)
and `order_tracking/{token}` (already token-readable) — **never `/counters`**. Follow the rules-deploy
discipline: reconcile the deploy file to `xpizza-reference/database.rules.json`, add the deny as a diff,
re-diff vs LIVE (0 stripped), deploy.

## The display-only invariant — enforced by a helper (R1-F6)

Each surface gets a single `displayOrderLabel(o)` = `o.display_number ? '#'+o.display_number : <fallback>`,
used **ONLY in text nodes**. It is NEVER used in `data-*` attributes, cache keys, task/order ids, SDK/API
args, or lookups — those stay `order_id`. This prevents a mechanical find-replace from breaking assignment,
ETA, cancel/reassign, order-detail, KDS write-tracking, or driver accept.

## Back-compat / fallback

Orders created before this ships (and any fail-open miss) have no `display_number`. `displayOrderLabel`'s
fallback shows the `order_id` (or its last-4 suffix), never blank, never throws.

## Search-by-#N context (R1-F5)

`#N` is unique only **per-restaurant per-day**, but dispatch closed-search and dashboard search are
**all-time** — so a bare `#N` match is ambiguous across days/restaurants. Results/detail that match on `#N`
must render enough context to disambiguate: **`#N · brand · date · (full order_id)`**. (Do not scope the
search itself down — staff may not know the day; disambiguate in the result instead.)

---

## Locked decisions (owner-confirmed 2026-07-16)

1. **Per-restaurant daily counter.** Each kitchen sees a clean `#1, #2, #3…`. The shared surfaces
   (dispatch, dashboard) disambiguate via the existing `rest-x_pizza`/`rest-la_musa` brand chips
   (`#3 · X. Pizza`). NOT a global counter.
2. **Tracker shows `#N`** (customer-facing, friendlier). Order-form confirmation unchanged.
3. **Factura keeps the full `order_id` as the legal `PEDIDO:` field**; add a small `#N` friendly ref
   beside it. Do NOT replace the legal reference.
4. **Reset boundary = local midnight America/Tegucigalpa** (matches shift/factura day).

---

## Build ownership & sequencing

1. **Advisor design gate** (this doc) → then **codex-review on the Core** (the counter's atomicity +
   idempotency-with-retry + fail-open is the whole risk; it's the hot order-creation path).
2. **Platform/functions session** builds: Core allocation (codex-on-diff on the functions diff) +
   the web display surfaces (KDS, dispatch, dashboard, tracker) — display-only, `order_id`-as-key preserved.
3. **Driver session** adds `#N` to the driver card + incoming banner (its own native release).
4. **Factura** (`#N` beside `PEDIDO:`) folds into the current factura branch (us).
5. **POS session** optionally shows `#N` on imported online orders (separate repo, reads the field).

**Sequencing constraint:** display surfaces can't show `#N` until the Core stamps it — so **functions
first**, then the surfaces (each independently, each with the back-compat fallback).

## Out of scope

- Any change to `order_id` itself. Renumbering existing orders. A global cross-day sequence.
