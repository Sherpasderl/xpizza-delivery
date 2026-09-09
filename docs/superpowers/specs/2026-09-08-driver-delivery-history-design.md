# Driver Delivery-History Capture — Design Spec

**Date:** 2026-09-08
**Author:** driver-app session (for advisor + codex gate)
**Status:** DESIGN — awaiting advisor approval + codex money-adjacent gate. NOT built.
**Constraint:** add-only. No change to any existing engine/logic (accept/assign/status/cuadre/pricing/factura untouched).

---

## 1. Problem

There is **no persistent record of which driver delivered which order.** Verified against production RTDB (2026-09-08):

- `orders/{id}` (125 total, 59 delivered): records `delivered_at`, `status`, customer, totals — **no driver field of any kind.**
- `order_events` / `order_timelines`: status-transition timestamps + dispatch load — **no driver identity.**
- `driver_cash/{uid}/{shiftId}/cuadre`: per-**shift** cash aggregate `{cash_order_count, cash_owed, closed_at}` — no order IDs, cash-only.
- The driver→order link lives on `/tasks/{taskId}.assigned_driver_id`, but **tasks are ephemeral** — deleted on completion (the `/tasks` node does not exist at rest). So the moment a delivery finishes, the record of who did it is gone.

Consequence: questions like "all deliveries by Elmer" are unanswerable from stored data. They can only be *approximately* reconstructed from Cloud Functions logs, within the ~30-day retention window, and only for auto-assigned orders (acceptTask and delivery-completion are not logged). This blocks payroll, per-delivery pay, performance review, and accountability.

## 2. Goals / Non-goals

**Goals**
- Persist, at delivery time, **who delivered each order**, atomically and trustworthily.
- Make "all deliveries by driver X" a **direct O(1)-ish lookup**, suitable for payroll / per-delivery pay.
- Add-only. Zero change to existing accept/assign/status/cuadre/pricing/factura logic.
- Fail-open: a driver on an old app version must still be able to complete deliveries during rollout.

**Non-goals**
- No per-delivery **pay computation** in this change (this only *captures attribution*; pay logic is a later, separately-gated project).
- No change to the cuadre / cash-owed math.
- No retention/archival policy for the new index (future).
- No historical recovery beyond the one bounded backfill in §8.

## 3. Current state (verified source facts)

| Fact | Location |
|---|---|
| Delivery is marked **client-side** by the driver app | `xpizza-driver/xpizza-delivery.js:561` writes `updates['orders/${task.order_id}/status'] = ORDER_STATUS.DELIVERED` in a multi-path `update()` batch, from the "Entregado" slide-confirm (`index.html:2330`, `btn-delivered`) |
| Driver assignment source of truth (ephemeral) | `/tasks/{taskId}.assigned_driver_id` (see `acceptTask`, `xpizza-delivery.js:466`; `acceptSecondOrder` reads `tasks/${pickupTaskId}`) — deleted on completion |
| A **server-side trigger already fires on the `delivered` transition** | `xpizza-functions/index.js` ~3445 (`after === 'delivered'` branch for tracking/WhatsApp) and the `decideStatusMirror` status-sync infra (~2211–2237). This is the hook to attach the mirror to — no new trigger plumbing. |
| Rules already gate driver status writes | "drivers can write status only via their assigned tasks" (`xpizza-delivery.js:405` comment; enforced in DB rules) |

## 4. Design (Option A — full)

Three add-only pieces + one bounded backfill.

### 4.1 Client stamp (atomic, authentic)
In the driver app's delivered write batch (`xpizza-delivery.js:561`), add to the **same** `update()`:
```
updates[`orders/${task.order_id}/delivered_by_uid`]  = driverId;          // = currentUser.uid, the assigned driver
updates[`orders/${task.order_id}/delivered_by_name`] = <driver display name>;
```
- Atomic with `status: delivered` → the stamp can never drift from the delivery.
- Authentic: the driver whose app marks delivered *is* the deliverer (rules already restrict status writes to the assigned driver).
- `driverId` is already in scope at this call site (it is the argument threaded through the delivery action). Driver name: resolve from the already-loaded `drivers/{driverId}/name` (already in memory in the driver app) — no extra read on the hot path; if unavailable, omit name (uid is the key that matters).

### 4.2 Rules (additive, optional-during-rollout)
On `orders/{id}`:
- Allow the two new leaves `delivered_by_uid` (string) and `delivered_by_name` (string).
- **Validate IF present:** `delivered_by_uid === auth.uid` (anti-spoof: a driver can only stamp themselves). Absent is allowed (old app versions) → fail-open, no delivery is blocked during rollout.
- Edit the **tracked** `xpizza-reference/database.rules.json`, sync, and run the RTDB emulator before deploy (no `numChildren()`; see rules discipline).

### 4.3 Server mirror → per-driver index (add-only, idempotent)
Attach to the existing `delivered` transition handler (index.js ~3445). On `after === 'delivered'`:
```
driver_deliveries/{delivered_by_uid}/{orderId} = {
  delivered_at,            // from the order / ServerValue
  restaurant_id,           // 'x_pizza' | 'la_musa'
  total_cents,             // thin copy for reporting (read-only mirror, not a money source of truth)
  payment_method,          // 'cash' | 'online'
}
```
- **Source of the uid:** primary = `orders/{id}/delivered_by_uid` (the client stamp). **Fallback:** if absent (old-app driver mid-rollout), best-effort read `tasks/{delivery_task_id}/assigned_driver_id` *if the task still exists*; if both absent → `console.warn` + skip (never throw, never block the existing handler).
- **Idempotent / update-only-if-needed:** keyed by `orderId` under the driver → re-fire writes the same leaf. Follows the existing `decideStatusMirror` "update-only" ethos so a replay can't double-count.
- Wrapped so a failure here can **never** affect the existing delivered-transition side effects (tracking mirror, WhatsApp, rewards earn). Separate try/catch, additive only.

### 4.4 Dashboard read (dispatch/admin)
"Driver history" view/report reads `driver_deliveries/{uid}` directly (already keyed by uid → no query index needed). Columns: date, order, brand, pay method, total. This is the surface that answers "all deliveries by Elmer."

## 5. Data model summary
```
orders/{id}/delivered_by_uid   : string   (NEW, add-only, stamped atomically with status=delivered)
orders/{id}/delivered_by_name  : string   (NEW, add-only)
driver_deliveries/{uid}/{orderId} : { delivered_at, restaurant_id, total_cents, payment_method }   (NEW node)
```
No existing field is modified. `total_cents` in the index is a **read-only reporting mirror**, explicitly NOT a money source of truth (the factura/cuadre pipeline is untouched).

## 6. Rollout sequence (no-window, fail-open)
Order chosen so no driver is ever blocked and no event is lost:
1. **Rules** first — additive, `delivered_by_uid` OPTIONAL (validate-if-present). Deploy `--only database` after emulator pass.
2. **Server mirror** — deploy add-only, handles present-or-absent uid (client stamp may not be live yet; fallback covers it). Scoped functions deploy; verify `.env` == live and full function set first (partial deploy prunes → drivers unassignable).
3. **Driver app** — ship the client stamp (new app version). From here every new delivery is stamped at the source.
4. **(Later, optional)** once all active drivers are on the stamped version, tighten the rule `delivered_by_uid` from optional → required. Separate small change.
5. **Backfill** (§8) last.

## 7. Testing (TDD)
- **Pure unit:** the mirror's uid-resolution (stamp present → use it; absent + task present → task fallback; both absent → skip, no throw) and the thin-record shape. Follows existing `*.test.js` pattern; add to the `npm test` chain.
- **Rules (emulator):** driver may write `delivered_by_uid === auth.uid`; driver is REJECTED writing another uid; absent is allowed; existing delivered writes still pass.
- **Idempotency:** re-firing the delivered trigger yields the same single index leaf (no duplicate/double-count).
- **Isolation:** a mirror failure does not break tracking/WhatsApp/rewards on the delivered transition.

## 8. One-time backfill (bounded, owner-confirmed)
Seed only what we can attribute with confidence, from the log recovery already performed (last 30 days):
- **Auto-seed (high confidence — auto-assigned to Elmer, delivered, never reassigned away):** 4 orders — `PZX-260830-154303`, `PZX-260830-180826`, `PZX-260903-181245-QABHQMTY`, `PZX-260904-165936-SAP8JC89`.
- **Do NOT auto-seed (low confidence — only *offered* to Elmer; may be another driver's):** 5 orders — require manual owner confirmation before writing.
- Backfill writes the same `orders/{id}/delivered_by_uid` + `driver_deliveries/{uid}/{orderId}` shape via a one-shot admin script (idempotent, dry-run first). Older-than-retention history is unrecoverable and will remain blank — acceptable.

## 9. Gates (must clear before any build/deploy)
- **Advisor approval** — driver-app + rules + functions change.
- **Codex money-adjacent gate** — the output feeds driver compensation/payroll. (It does not touch cuadre/pricing/factura math, but attribution → pay makes it money-adjacent.)
- Fiscal representation unaffected (no change to what any factura asserts).

## 10. Open questions for the advisor
1. **Index richness:** keep the mirror thin (as above), or also stamp `delivered_by_name` into `driver_deliveries` for display without a join? (Lean vs. denormalized.)
2. **Reassignment/relay edge:** if an order is reassigned after a partial delivery attempt, the *final* `delivered_by_uid` (whoever taps Entregado) is authoritative — confirm that's the desired attribution (it is, for pay).
3. **Tighten-to-required timing (step 4):** do it in this project or defer until the new driver version is confirmed fully rolled out?
4. **Backfill scope:** confirm the 4 high-confidence orders for auto-seed; decide per-order on the 5 low-confidence.
