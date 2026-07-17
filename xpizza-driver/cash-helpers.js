/**
 * Pure cash-handling helpers for the driver app (P3). No DOM, no Firebase —
 * unit-tested with `node cash-helpers.test.js` + assert (repo idiom). Imported by
 * index.html for the vuelto sheet, the clock-out cuadre, and the idle "Efectivo hoy".
 */

/**
 * Change owed back to the customer. Returns `tendered - total` when the customer
 * paid enough, else `null` (never show a negative vuelto). Coerces numeric strings.
 */
export function computeVuelto(total, tendered) {
  const t = Number(total);
  const p = Number(tendered);
  if (!Number.isFinite(t) || !Number.isFinite(p)) return null;
  if (p < t) return null;
  return p - t;
}

/**
 * Up to three ascending, deduped round-up amounts ≥ total a customer might pay with
 * (next 100 / next 500 / next 1000). e.g. 370 → [400, 500, 1000]. Invalid → [].
 */
export function vueltoSuggestions(total) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return [];
  const cands = [
    Math.ceil(t / 100) * 100,
    Math.ceil(t / 500) * 500,
    Math.ceil(t / 1000) * 1000,
  ];
  return [...new Set(cands)].sort((a, b) => a - b);
}

/**
 * True for a cash-collected order. The platform writes payment_method 'cash' (real
 * value; see functions ALLOWED_PAYMENT_METHODS = cash|card_delivery|online); 'efectivo'
 * is only a legacy alias. Never 'card_delivery'/'online'. Case- and whitespace-tolerant.
 * Mirrors the POS's orderPredicates.isCashPayment (separate repo — kept byte-identical).
 */
export function isCashPayment(pm) {
  if (typeof pm !== 'string') return false;   // a non-string payment_method is not a valid cash order
  const s = String(pm == null ? '' : pm).trim().toLowerCase();
  return s === 'cash' || s === 'efectivo';
}

/**
 * Shift cash + delivery totals from the RTDB task/order maps. Counts only the
 * driver's own delivery tasks that completed at/after `sinceMs`. `cashOwed` =
 * Σ order.total for cash (real) / legacy efectivo orders (server-truth — no
 * driver-entered figure). Returns { deliveries, totalCollected, cashOwed, cashOrderCount }.
 */
export function computeShiftCash(allTasks, allOrders, uid, sinceMs) {
  let deliveries = 0, totalCollected = 0, cashOwed = 0, cashOrderCount = 0;
  const tasks = allTasks || {};
  const orders = allOrders || {};
  for (const id of Object.keys(tasks)) {
    const t = tasks[id];
    if (!t || t.type !== 'delivery' || t.assigned_driver_id !== uid) continue;
    if (t.status !== 'completed' || !t.completed_at || t.completed_at < sinceMs) continue;
    deliveries++;
    const o = orders[t.order_id];
    const total = o && typeof o.total === 'number' ? o.total : 0;
    totalCollected += total;
    if (o && isCashPayment(o.payment_method)) {
      cashOwed += total;
      cashOrderCount++;
    }
  }
  return { deliveries, totalCollected, cashOwed, cashOrderCount };
}
