# SPEC — Dispatch: rescue a stalled (offered-but-unaccepted) order

**Date:** 2026-08-08 · **Surface:** `xpizza-dispatch/index.html` (board UI). **Type:** additive dispatch-UX. **NOT money-path.** Advisor + codex dispatch-integrity gate before deploy. Client-UI-only — **no change to the assignment engine, `reassignOrder`, Cloud Functions, or RTDB rules.**

## Problem (from a live incident, order `PZX-260808-172019-P5T23PKG`)
An order auto-assigned to a driver who never accepted (his WebView was stale) sat stuck: delivery task `assigned_driver_id` set, `status: 'assigned'`, `assignment_deadline` expired, `retry_count` capped → the auto-sweeper stopped retrying (correct: 3-min timeout cooldown, and he was the only driver). The dispatcher could not rescue it:
- `getPendingOrders()` (the "Sin Asignar" list, which renders the **"Asignar"** button) filters on **`!dt.assigned_driver_id`** (`index.html:3103`) — so a stalled order (which *has* an assigned driver) is excluded; no "Asignar" button.
- It falls into `getActiveOrders()` (`:3111`), where the **only** reassign path is buried in the **driver card's ⋯ menu** (`:3648` → `openPicker(order.order_id, true)`).
- Clicking the *order* opens `openOrderDetailModal` (`:4203`) — which has **no reassign control**.

Net: a stalled order the dispatcher must rescue offers no visible action from the order. (The cooldown is NOT the blocker — dispatch never reads `timeout_until`; the reassign path is cooldown-agnostic. The blocker is purely UI.)

## The reassign machinery is already correct (reuse verbatim)
`openPicker(oid, true)` → `reassignOrder(orderId, newDriverId, pickerFromDriver)` (`xpizza-delivery.js:822`): CAS-swaps the delivery task's `assigned_driver_id` against the frozen from-driver (stale-picker-safe), sets a fresh `ACCEPT_TIMEOUT_MS` deadline, resets attempts. The picker lists **all on-shift drivers** via `getActiveDrivers()` (`:4668`) and does **not** exclude the currently-assigned driver — so **re-offering to the same/only driver works** (exactly the rescue we needed). No change to any of this.

## Design (owner-approved: flag + reassign button)
Purely additive rendering in `index.html`:

### 1. Pure predicate — `isStalledAssignment(dt, now)`
```
dt && dt.assigned_driver_id
   && dt.status === 'assigned'                 // offered, not yet accepted (accept flips it past 'assigned')
   && Number.isFinite(dt.assignment_deadline)
   && dt.assignment_deadline < now             // the 60s acceptance window expired
```
Display-only — **writes nothing.** `status === 'assigned'` (not `accepted`/`en_route_delivery`/`at_restaurant`/`completed`) means the driver never accepted; the expired deadline means the offer lapsed. (A driver who accepted moves the task past `'assigned'`, so an actively-progressing order is never flagged.)

### 2. Visual flag on the order (active list / wherever the order renders)
A badge on the stalled order: **"⚠ {driver} · sin aceptar · expiró"** (reuse the existing `.m.warn`/`.slip` chip styling — monochrome, no new emoji beyond the existing warn glyph), and **order it toward the top** of its list so it stands out. Derive the driver name from `allDrivers[dt.assigned_driver_id]`.

### 3. "Reasignar" affordance the dispatcher can reach from the order
- **On the order card** (the stalled active order): a prominent **"Reasignar"** button → `openPicker(o.order_id, true)` — mirror the existing unassigned card's `assign-btn` wiring (`:3281`/`:3299`) but in reassign mode.
- **In the order-detail modal** (`openOrderDetailModal`, `:4203`): add a **"Reasignar"** button for any assigned (non-completed/cancelled) order → `openPicker(orderId, true)`. This directly fixes "I clicked the order and there was no button." Prominent when `isStalledAssignment` is true.

Both just open the existing picker; the write stays `reassignOrder`. Reuse `assignFailMsg(reason)` (`:4774`) + `toast` for the result, exactly like the existing assign/reassign call sites (`:3308`, `:4790`).

## Guardrails (non-negotiable)
- **Additive only.** No change to `getPendingOrders`/`getActiveOrders` bucketing, the existing "Asignar" flow, the driver-card "Reasignar" menu, `openPicker`, `reassignOrder`, functions, or rules.
- **Predicate is display-only** — never writes; the sole write remains the existing CAS-safe `reassignOrder`.
- **No new reassign logic** — every new control calls `openPicker(oid, true)`.
- **Guest/other boards untouched** — this is dispatch-only.

## Testing
- **Unit (pure):** extract `isStalledAssignment(dt, now)` to a testable spot (or a tiny module) and unit-test the truth table: assigned+expired → true; accepted/en_route/at_restaurant → false; unassigned → false; not-yet-expired → false; completed/cancelled → false; missing deadline → false. (Follow the dispatch-mobile `board-model.js` test pattern if a module split fits.)
- **On-device (owner):** reproduce a stalled order (assign to a driver who doesn't accept, let the deadline expire) → confirm the badge appears + "Reasignar" is reachable from the card AND the order-detail modal → reassign re-offers (fresh deadline), including re-offering to the same only-driver → picker/CAS behaves (no clobber). Confirm a normally-progressing assigned order is NOT flagged.

## Gate & deploy
- **Gate:** advisor read-only verify (additive, engine/write/rules untouched, predicate write-free) + **codex** dispatch-integrity glance on the diff. Not money-adjacent.
- **Deploy:** dispatch Netlify site **`xpizzadispatch`** — explicit `--site ac3fa94a-564a-4df4-9428-34e6cb41f778` ([[netlify-deploy-mechanics]]; repo default-links to CATERING). Owner deploys after APPROVED.

## Out of scope
- The underlying assignment-not-reaching-driver failure (the stale-WebView / offer-not-arriving root cause) — that's the `driver_events` diagnostics program; this fix only lets the dispatcher *recover* faster, it doesn't prevent the stall.
- Any change to the timeout cooldown, retry cap, or auto-assign policy.
