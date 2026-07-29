# Handoff to Advisor — Batch A1 ($0 free-order path) MONEY-GATE

**Branch:** `feat/rewards-batch-a` · **A1 commits:** `7856c75` (functions) + `d0558aa` (forms) · **base:** `main` (`f6cfee0`) · nothing merged/deployed.
**Gate type: MONEY-GATE.** Plan reference: `docs/rewards-batch-a-plan` @ `598a50c`, section **A1** (R7). A-F (`7489968`) is the sibling money-gated task — gate together or A-F→A1.

## Problem
A fully-comping redemption zeroes the online total, which can't open a PixelPay checkout (can't charge L0) → "checkout not created" (canary). Pivot (owner-directed): route $0 through `createOrder` (the canary-proven cash lifecycle) as a `free_order`, and make the online charge path fail-fast + defensively reject $0.

## Functions (`7856c75`) — the money core
**createOrder (`index.js`):**
- `free_order` is **re-derived server-side** from the authoritative re-priced breakdown: `freeOrder = !!redemptionPriced && priceBreakdown.total_cents === 0`. The client `free_order` flag is an optimistic hint, **never trusted**.
- **STALE GUARD:** `body.free_order === true && !freeOrder` → release the reservation + typed **409 `free_order_stale`** so the forms re-enable payment. Never silently places a payable order the customer didn't pay for.
- Threads `freeOrder` into `buildCreateOrderUpdates` + `buildScheduledOrderRecord`.

**create-order-build.js:** stamps `free_order:true` onto the order record **and the delivery task** (both conditional → non-free byte-identical, golden green).
**materialize.js:** a scheduled free order's task is built at release, so it copies `order.free_order` onto the released delivery task (+ new scheduled-free unit test).

**chargeOnlineOrder (`index.js`) — R7 exact safe sequence:**
- **$0 guard** right after the reprice → typed **409 `not_payable_online` / `free_order`** BEFORE any config read, availability read, rate-limit write, reserve, or acquire (a free order never touches PixelPay config).
- **MOVED** the PixelPay config + return-base reads from the top down to **just before reserve/acquire** — after the reprice + $0 guard + ALL non-PixelPay gates (availability / rate-limit / schedule / active / zone). So a payable order proves PixelPay signable **before opening any attempt/hold** ("never open an attempt we can't sign"), while a $0 order never 500s on a config read. Verified `pp`/`returnBase` are unreferenced between the old and new positions.

## Forms (`d0558aa`) — total-driven payment availability (both brands, additions byte-identical)
- `syncFreeOrderUI()` (in the byte-identical `//__REWARDS_PARITY__` block): reads `getRedeemQuoteTotalCents()`; total===0 → grey BOTH pay cards (`.pay-card--free-disabled`, `pointer-events:none`), hide panels, swap CTA to enabled **"Confirmar pedido gratis"**; total>0 / reward removed → restore the normal prompt. Wired from `applyRedeemQuoteToTotals` + `renderRedeemUI`.
- `selectPay()` no-ops while free; `processPayment()` free branch → `buildOrder()` then `payment_method:'cash'` + `free_order:true` (+ the redeem payload) → `createOrder` via the existing `submitOrder`. All other gates still apply.
- **Money-safety:** UX only — the server re-prices + rejects a stale claim; the server is authoritative.

## Verification
- Functions: `create-order-build` 4/4 (byte-identical non-free), `materialize-snapshot` 7/7 (+scheduled-free), `rewards-redeem-pricing` 24/24, targeted charge/gate/pixelpay/scheduled tests pass, **full `npm test` green (exit 0)**.
- Forms: `rewards-parity.guard` **4/4** (parity block byte-identical, 3134 chars; mounts + guest guard unchanged); inline JS syntax-valid both forms; A1 additions byte-identical across brands.
- **Not on-device-verifiable until the re-canary** (needs login + redemption live; login can't complete on netlify.app drafts per ACCOUNT_ORIGINS CORS, and redemption_enabled is OFF). Server guards are the money backstop regardless.

## Open judgment calls for the gate
1. **Sub-min online NOT implemented** (server or forms). No `PIXELPAY_MIN` constant exists, and 0<total<min is unreachable given min-order + redemption economics (a comp leaves either 0 or a substantial remainder). Inventing a threshold risks blocking legit small orders. The real, implemented guard is `total_cents === 0`. Confirm you agree, or name the min and I'll add a shared constant + cash-only routing.
2. **`free_order` derived, not trusted** — server sets it from `total_cents===0 && redeemed`; the client flag only triggers the stale-reject. Confirm the derivation (vs honoring the client flag).
3. **`chargeOnlineOrder` real ordering** — please verify the reorder against the R7 sequence at this gate (the plan said you'd verify the actual code here).

Executor will action any REVISE findings. Nothing merged or deployed.
