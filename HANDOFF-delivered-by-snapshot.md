# HANDOFF: snapshot the delivering driver onto the order — cross-surface, needs a gate

**Written:** 2026-09-21 (dispatch-lite executor). **Status:** scoped, NOT built. **Ask:** owner picks the approach (A or B below), then the owning session builds it and it takes a codex gate — it is a write to `orders/<id>`.

## The problem, established from the database (not inferred)

"Which driver completed this order" is **unanswerable** for any order whose task has been swept, on every surface. Evidence, all read live from `xpizza-delivery` with the Firebase CLI:

| Check | Result |
|---|---|
| `/orders/PZX-260920-132908-GHW9VHDB` — all 44 fields dumped | **no driver field of any kind**. Has `delivery_task_id`, `pickup_task_id`, `delivered_at` — no `driver_id`, no `delivered_by` |
| That order's own `delivery_task_id` pointer, followed | `null` — the task is gone, not misnamed |
| `/tasks` (whole node, shallow) | **empty** |
| `/driver_cash/<uid>` | only cuadre aggregates (`cash_order_count`, `cash_owed`, `closed_at`) — **no order ids** |

**Mechanism:** the driver identity exists ONLY as `tasks/<orderId>_delivery/assigned_driver_id`. `exports.retentionSweepTasks` (`xpizza-functions/index.js:3965`) runs **every 6 hours** and deletes tasks for terminal orders. `/tasks` being empty proves `config/retention/tasks_mode` is `'execute'` and it has run. Once it runs, the link is destroyed.

**Both dispatch surfaces have this hole identically.** The desktop resolves the driver at render time — `allTasks[`${o.order_id}_delivery`]?.assigned_driver_id` → `allDrivers[id].name` (`xpizza-dispatch/index.html:4131-4132` delivered list, `:4335` detail modal). With `/tasks` empty that yields `—`. Dispatch-lite yields "Sin repartidor asignado". Same data loss, different wording. **No view-layer fix on either surface can recover it** — the record is not in the database.

**History is permanently lost.** There is no backfill. Do not scope one; nothing holds the link.

## Two approaches — owner picks

### A. Cloud Function trigger (recommended)

A trigger on `orders/<id>/status`: when it becomes terminal, read `tasks/<id>_delivery/assigned_driver_id` (still present — the sweep runs every 6h, the trigger fires immediately), resolve the name from `/drivers`, and write the snapshot onto the order.

- **One place.** Server-side, no SDK duplication.
- **Catches every completion path**, not just the driver app's swipe: `completeTask`, the KDS `setOrderStatus(id,'completed')` close (`xpizza-kitchen/index.html:2171`), and any manual transition. A client-side fix only covers the path it lives in.
- Order-status triggers already exist in this codebase (`index.js:3401` region), so the pattern is established.
- Cost: one extra small write per completed order.

### B. Extend `completeTask` in the SDK

Add the snapshot to the existing atomic `update()` beside `delivered_at`.

- **Fewer moving parts** and provably atomic with the completion.
- **But it only covers the driver-app swipe.** A KDS-closed order still loses the driver.
- **And the SDK is duplicated six ways and already out of sync** — `xpizza-dashboard`, `xpizza-dispatch`, `xpizza-dispatch-mobile`, `xpizza-driver`, `xpizza-kitchen`, `xpizza-reference` carry four distinct md5s (only dispatch + dispatch-mobile match). Any change has to be mirrored deliberately, and "mirror it everywhere" is how those four hashes happened.

**Recommendation: A.** The coverage argument decides it — B cannot see the KDS close, and that path demonstrably reaches `delivered`/`completed` in production.

## What to write

Two fields, not one:

```
orders/<id>/delivered_by_id    = <driver uid>
orders/<id>/delivered_by_name  = <driver display name at completion>
```

The **name must be snapshotted, not just the id.** A stored id alone re-creates the same failure one layer down: remove a driver from `/drivers` and the name is unresolvable again. Snapshot both; render the name, keep the id for joins.

## Read side (after the write lands)

Both surfaces prefer the snapshot and fall back to the live task lookup, so orders still inside the retention window keep working during rollout:

- `xpizza-dispatch/index.html` — the delivered list (`:4131`) and the detail modal's Repartidor section (`:4335`, `:4469`).
- `xpizza-dispatch-mobile/index.html` — `displayDriverId()`, and the detail sheet's driver panel. **This session can take the dispatch-lite half** once the write side is agreed.

## Gate

It is a **write to `orders/<id>`**, so it takes a codex gate per house rule even though the fields carry no money. Points for the gate:

- The snapshot must never overwrite an existing value (idempotent on re-trigger).
- It must not fire on `cancelled` — a cancelled order has no delivering driver.
- It must not block or alter the status transition if the task or driver is missing; absent driver → write nothing, not an empty string.
- Approach A must tolerate the task already being gone (an order completed >6h after its last status write): read, find nothing, write nothing, log.

## Cleanup owed in dispatch-lite

`1616a64` added a fallback scan over `/tasks` on a key-convention theory that is **wrong** — the pointer resolves correctly, the node is swept. The code is inert (it scans an empty node and returns null) but its comment states a false reason. Replace the comment with the retention-sweep mechanism, or drop the scan.
