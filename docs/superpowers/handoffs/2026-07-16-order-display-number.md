# Order Display Number (`display_number`) — Session Handoffs

**Companion to:** `docs/superpowers/specs/2026-07-16-order-display-number-design.md` (design-gate APPROVED, codex 2 rounds).
**Feature:** a per-restaurant, daily, sequential `display_number` (shown `#47`) so staff (kitchen ↔ driver ↔ dispatch) can reference an order verbally. The internal `PZX-…` `order_id` is **UNCHANGED** — `display_number` is a **display-only label**, never a key.

## Build sequence

```
① FUNCTIONS CORE (platform)  ──codex-on-diff gate──►  deploy  ►  orders now carry display_number
      │  (foundation — everything else just READS the field)
      ├─►  ② WEB SURFACES (platform): KDS · dispatch · dashboard · tracker  ──advisor gate──► deploy each
      ├─►  ③ DRIVER APP (driver session): #N on card + banner  ──gate──► AAB → Play → rollout
      ├─►  ④ FACTURA (us): #N beside legal PEDIDO  ──► fold into current factura branch
      └─►  ⑤ POS (POS session): #N on imported online rows  ──► deploy
```

②–⑤ all have a **graceful fallback** (no `display_number` → show `order_id`), so they can build in parallel and render the fallback until ① is live. **Do ① first.**

**Universal invariant (every surface):** `display_number` replaces only the *rendered* order-# text. Every `order_id` used as a key/cache/DOM-attr/API-arg stays `order_id`. Enforce with a single `displayOrderLabel(o)` helper used in **text nodes only**.

---

## ① Functions / platform session — CORE + web surfaces

### PHASE 1 — CORE (codex-gated, lands first)
- **A single DB trigger on `/orders/{id}`** (onValueWritten), a near-clone of `allocateFacturaOnSale`'s predicate — fires only when the order **transitions to live/Sale (`status → 'new'`)**. NOT on `pending_payment` (failed payments burn no number; scheduled orders number on release, not checkout). **Separate function** from the factura allocator (no money-path entanglement).
- **Idempotent counter, ONE transaction, keyed by `order_id`** (mirror factura `seq.last_reserved` + `seq.pending[orderId]`): node
  `/counters/order_display_seq/{restaurant_id}/{YYYY-MM-DD}` = `{ last, by_order: { [orderId]: n } }`.
  If `by_order[orderId]` exists → return it (idempotent no-op on retry/concurrent handler). Else `n = (last||0)+1`, set `last = n`, `by_order[orderId] = n`.
- **Day key computed server-side**, local America/Tegucigalpa (never a client clock).
- **Stamp `display_number` in TWO places:** `/orders/{id}` AND `order_tracking/{token}` (the customer tracker reads the public tracking node, not auth-only `/orders`).
- **Fail-open:** the trigger fires *after* the order exists → a counter failure (contention/rules-deny/error) can NEVER block or fail an order.
- **RTDB rules:** add explicit `/counters: { ".read": false, ".write": false }` deny + a guard test. Rules-deploy discipline: reconcile the deploy file to `xpizza-reference/database.rules.json`, add the deny as a diff, re-diff vs LIVE (0 stripped), deploy.
- **Deploy zero-prune** (include all live fns — see prod-functions-deployed-state / functions-env-management memory).
- **TDD the counter:** idempotency (retry → same n), concurrency (two handlers → one n, no double-burn/gap), day boundary, fail-open.
- **GATE:** deliver the diff for advisor **codex-on-diff** before deploy (hot order-creation path).

### PHASE 2 — WEB SURFACES (after core; advisor gate, display-only)
Add `displayOrderLabel(o) = o.display_number ? '#'+o.display_number : <order_id fallback>` per file, **text nodes only**:
- **KDS** (`xpizza-kitchen`): card header → `displayOrderLabel`. KEEP `order_id` for `pendingWrites[id]`, `dismissWrite('${id}')`, write-tracking keys.
- **Dispatch** (`xpizza-dispatch`): the `Pedido #${order_id}` spots (cards ~2246/2260, alerts 2288/2315, cancel-confirm/toasts 2845/2852) → `displayOrderLabel`. **Search also matches `#N`**; results render `#N · brand · date · full-id` (per-rest-per-day non-unique). KEEP `order_id` for `data-order-id`, `etaCache`, `knownPendingOrderIds`, `pickerOrderId`, cancel/reassign calls.
- **Dashboard** (`xpizza-dashboard`): orders table + search match `#N` (same context-in-results). KEEP `order_id` for `dataset.orderId → openOrderDetail`, the `TEST-` filter, the `/orders/{id}` detail read.
- **Tracker** (`xpizza-track`, render ~line 547): show `#N` from `order_tracking/{token}.display_number`, fallback `order_id`.

---

## ② Driver session — native app

The driver app **doesn't show the order # today** — it *gains* `#N`.
- Add `displayOrderLabel(o)`; render `#N` on the assigned-order card + the incoming-order banner. Driver knows its restaurant (`restaurantChip`) → unambiguous.
- **KEEP `order_id`** for `data-order-id`, `collapsedBanners`/`pendingIds` sets, `allOrders[task.order_id]`, accept/settle SDK calls — display only.
- Reads `order.display_number` off `/orders` (already in the driver's order data); fallback `order_id`.
- **Native release:** mirror `xpizza-driver/` → `www/`, `npx cap copy android`, bump `SYSTEM_VERSION` + `versionCode` → AAB → Play internal → on-device verify → rollout.
- **GATE:** advisor (small, display-only). Send the diff.

---

## ③ POS session — separate repo `~/Downloads/xpizza-pos`

On the auto-imported online orders in Hoy, show `#N`.
- The bridge already reads online orders off platform `/orders`; add `display_number` to the fields it reads; render `#N` on the imported-order row (fallback `order_id`).
- **Display only** — the POS keeps its own internal id/key for the row.
- **GATE:** advisor. Small, presentational.

---

## ④ Factura — us (fold into `feature/factura-integration`)

Show `#N` as a small friendly ref **beside** the legal `PEDIDO:` line — **keep the full `order_id` as the legal `PEDIDO`** (never replace it).
- `renderer.js`: add a `#N` line/suffix near `PEDIDO`; `build-record.js` needs `order.display_number`.
- **Ordering caveat:** the factura + display-number triggers both fire on the live transition, so `display_number` may not be stamped yet when the factura builds → treat factura `#N` as **best-effort**: if absent at build time, omit it (the `PEDIDO`/`order_id` is always present). No coupling, no race.
