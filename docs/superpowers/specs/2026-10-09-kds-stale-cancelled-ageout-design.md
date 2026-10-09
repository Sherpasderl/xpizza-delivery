# KDS: stale cancelled orders age out of the display — Design (owner option A)

**Date:** 2026-10-09 · **Surface:** `xpizza-kitchen/` (the KDS — `card-model.js` + `index.html`). **Client display only** — NO server write, NO status change, NOT money/pricing/factura. Base: `origin/main` @ `e1aeb3f`.

## Problem (owner-reported, root-caused on e1aeb3f)

Every time the owner reopens the KDS after a gap, **cancelled (`cancelado`) orders reappear in Abiertos** and must be re-archived. (Delivered orders don't — yesterday's real order sat correctly in Completados.)

**Root cause:** a `cancelled` order maps to estado **`Cancelado`** (index.html:3025) — *not* `Archivado`, and `cancelled` is *not* in `NON_LIVE_ORDER_STATUSES` (order-filter.js:16) — so it stays in the live feed indefinitely and sits in **Abiertos** "with stop-cooking treatment until acknowledged." Tapping **Archivar** → `archiveCancel()` (index.html:2381) is a **LOCAL-only** `completedSet.add` (no server write), and `pruneLocalStateOnLoad` (index.html:1712) **drops that local mark after 24h**. So the next day the acknowledgment is gone, estado is still `Cancelado`, `deriveTab` → `open` → back in Abiertos. Delivered orders are immune because `delivered → Archivado` is server-terminal and `deriveTab` reads estado directly.

## Goal (option A — owner chose this)

A **stale** cancelled order (older than one service day) **ages out of the KDS entirely** — neither Abiertos nor Completados — so it never needs re-archiving. A **fresh** cancellation still appears in Abiertos with the stop-cooking alert so the cook notices mid-service. No durable record of old cancellations is kept in the KDS (cancellations/refunds are tracked in dispatch/Caja, not the kitchen screen). No server write; nothing grows unbounded.

## Design — one pure predicate + one choke

1. **`isStaleCancelled(o, nowMs, staleMs)`** — new PURE export in `card-model.js` (uses the existing `toMs` + `KDS_STATUS.CANCELADO`): true iff the card is `Cancelado` AND its aging anchor (`toMs(o.hora)` = released_at||created_at) is `>= staleMs` old. **No anchor → NOT stale** (fail-safe: never hide a cancellation we can't age).
2. **Single choke** — in `startOrdersSubscription`'s live handler (index.html ~2984), filter stale-cancelled cards out of the mapped `orders` BEFORE `render()` + `checkForNewOrders()`:
   ```js
   const nowMs = Date.now();
   const visible = orders.filter(o => !isStaleCancelled(o, nowMs, CANCELLED_STALE_MS));
   allOrders = visible;
   render(visible);
   checkForNewOrders(visible.filter(o => deriveTab(o, completedSet) === 'open'));
   ```
   One place covers every consumer — open pool (`lastOrders`→`openPool`), Completados (`orders.filter(completedTabVisible)`), the cancel alert (`checkForNewOrders`), and action lookups (`lastOrders`/`allOrders`). The ready-time nudge keeps receiving the RAW `ordersById` (unchanged — shadow predictor unaffected).
3. **`CANCELLED_STALE_MS`** — new const near `RECENT_COMPLETED_MS` (index.html:1679), set to the same 18h ("≈ one service day"); documented. `import { … isStaleCancelled }` added to the card-model import (cache-bust `?v=3`→`?v=4`).

## No-regression (must hold — the working paths this must NOT break)

- **Fresh cancellation still alerts + shows stop-cooking in Abiertos** — within the window `isStaleCancelled` is false → card unchanged (open pool + `checkForNewOrders` fire exactly as today).
- **Delivered → Completados** unchanged (`Archivado`, not cancelled → predicate false).
- **Completados recency** (`completedTabVisible`/`RECENT_COMPLETED_MS`) untouched.
- **A recently-archived cancel** (in `completedSet`, <window) still shows in Completados until it ages out — predicate only removes cards older than the window.
- **No server write / no status change / no money path** — client display filter only.

## Tests

- **Pure (`card-model.test.mjs`, TDD):** `isStaleCancelled` — fresh cancel (anchor within window) → false; stale cancel (anchor older) → true; non-cancelled (`Nuevo`/`Listo`/`Archivado`) → false regardless of age; missing/invalid anchor → false (fail-safe); boundary at exactly `staleMs`.
- **Regression:** full `card-model.test.mjs` + `order-filter.test.mjs` + `kds-smoke.test.mjs` green (the fresh-cancel/alert/deriveTab paths stay green).
- **Smoke (owner):** reopen after a day → yesterday's cancelled orders are GONE from Abiertos (and not in Completados); a freshly-cancelled order still appears in Abiertos with the cancel alert; delivered orders still in Completados.

## Out of scope
- Any durable server-side cancel-acknowledgment (that was option B).
- The general `ready`-local-overlay resurface (not observed; delivered/pickup paths reach server-terminal `Archivado`/`completed`).
