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

// The one warning the driver ever sees when there is no safe amount to collect.
export const COLLECT_WARN_TEXT = 'Pago no confirmado — consultá a despacho';

/**
 * THE single source of truth for "what, if anything, does the driver collect for this order?".
 * Pure; keyed only on server-written truth (functions ALLOWED_PAYMENT_METHODS = cash|card_delivery|online,
 * anything else sanitized to ''; verified paid = payment_method 'online' AND payment_status 'confirmed').
 * Used at EVERY driver render site AND by computeShiftCash, so the active card, the queue and the cuadre
 * can never disagree about a collection.
 *
 * Returns { kind, collect, owed, amount, chip, chipClass } where:
 *   kind     'cash' | 'card' | 'paid_online' | 'free' | 'warning'
 *   collect  driver collects money at the door (cash in hand or POS terminal) → the row shows an amount
 *   owed     cash the driver must hand to the office at clock-out (cash only; never card/online)
 *   amount   order.total when collect, else 0
 */
export function collectionFor(order) {
  const o = order || {};
  const pm = typeof o.payment_method === 'string' ? o.payment_method.trim().toLowerCase() : '';
  const t = Number(o.total);
  const amount = Number.isFinite(t) ? t : 0;

  // 1. Fully-comped rewards redemption (cash-typed, total 0) → nothing to collect.
  if (o.free_order) return { kind: 'free', collect: false, owed: false, amount: 0 };
  // 2. Verified paid online → nothing to collect. THE fix: never "A COBRAR" on a paid order.
  if (pm === 'online' && o.payment_status === 'confirmed') {
    return { kind: 'paid_online', collect: false, owed: false, amount: 0 };
  }
  // 3. Online but NOT confirmed → never a collect amount; send the driver to dispatch.
  if (pm === 'online') return { kind: 'warning', collect: false, owed: false, amount: 0 };
  // 4. Cash / legacy efectivo → collect full; this is the cash owed to the office. Reuse isCashPayment
  //    (the POS-parity predicate) so the cash definition lives in exactly one place and cannot drift.
  if (isCashPayment(o.payment_method)) {
    return { kind: 'cash', collect: true, owed: true, amount, chip: 'Efectivo', chipClass: 'cash' };
  }
  // 5. Card against delivery (POS terminal) → collect full, but NOT cash owed to the office.
  if (pm === 'card_delivery') {
    return { kind: 'card', collect: true, owed: false, amount, chip: 'Tarjeta', chipClass: 'card' };
  }
  // 6. Unknown / '' / legacy 'tarjeta'/'pixel' (never written by the live server) → warning, never collect.
  return { kind: 'warning', collect: false, owed: false, amount: 0 };
}

/**
 * The active-card / queue-detail payment-row HTML, driven by collectionFor. Pure; `esc` is the caller's
 * HTML escaper (index.html passes its escapeHtml). BYTE-IDENTICAL to the legacy inline template for
 * cash / card_delivery / free; paid-online and warning rows never render "A COBRAR" nor an amount.
 */
export function paymentRowHtml(order, esc) {
  const e = typeof esc === 'function' ? esc : (x) => x;
  const c = collectionFor(order);
  if (c.kind === 'free') {
    return `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount free-amount">Nada que cobrar</div></div><div class="payment-method free">Pedido gratis</div></div>`;
  }
  if (c.kind === 'paid_online') {
    return `<div class="payment-row"><div><div class="pay-label">COBRO</div><div class="payment-amount free-amount">Pagado — nada que cobrar</div></div><div class="payment-method paid">En línea</div></div>`;
  }
  if (c.kind === 'warning') {
    return `<div class="payment-row warn"><div><div class="pay-label">COBRO</div><div class="payment-amount warn-amount">${e(COLLECT_WARN_TEXT)}</div></div><div class="payment-method warn">Revisar</div></div>`;
  }
  const totalFmt = order.total != null ? Number(order.total).toLocaleString('es-HN') : '—';
  return `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount"><span class="pay-cur">L</span>${totalFmt}</div></div><div class="payment-method ${c.chipClass}">${e(c.chip)}</div></div>`;
}

/**
 * The compact queue "qpay" chip HTML, driven by collectionFor. Pure. BYTE-IDENTICAL to the legacy inline
 * template for cash / card / free; online-paid shows "Pagado", warning shows "Revisar" (never a raw method).
 */
export function queuePayHtml(order, esc) {
  const e = typeof esc === 'function' ? esc : (x) => x;
  const c = collectionFor(order);
  let cls = '', label;
  if (c.kind === 'free') label = 'Gratis';
  else if (c.kind === 'cash') label = `L ${Number(order.total || 0).toLocaleString('es-HN')}`;
  else if (c.kind === 'card') { cls = 'card'; label = 'Tarjeta'; }
  else if (c.kind === 'paid_online') { cls = 'paid'; label = 'Pagado'; }
  else { cls = 'warn'; label = 'Revisar'; }
  return `<span class="qpay ${cls}">${e(label)}</span>`;
}

/**
 * Shift cash + delivery totals from the RTDB task/order maps. Counts only the driver's own delivery tasks
 * that completed at/after `sinceMs`. Derives every money figure from collectionFor so it can never disagree
 * with what the driver was shown per-order:
 *   totalCollected — Σ order.total the driver actually collects at the door (cash + card_delivery). Online-paid
 *                    and free are NOT "collected" (fixes the cuadre mislabel); paid-online is reported separately.
 *   cashOwed       — Σ order.total for cash / legacy efectivo (byte-identical to before: the cash to hand in).
 *   paidOnlineTotal/paidOnlineCount — already-paid online orders, surfaced as a distinct line, never as collected.
 * Returns { deliveries, totalCollected, cashOwed, cashOrderCount, paidOnlineTotal, paidOnlineCount }.
 */
export function computeShiftCash(allTasks, allOrders, uid, sinceMs) {
  let deliveries = 0, totalCollected = 0, cashOwed = 0, cashOrderCount = 0, paidOnlineTotal = 0, paidOnlineCount = 0;
  const tasks = allTasks || {};
  const orders = allOrders || {};
  for (const id of Object.keys(tasks)) {
    const t = tasks[id];
    if (!t || t.type !== 'delivery' || t.assigned_driver_id !== uid) continue;
    if (t.status !== 'completed' || !t.completed_at || t.completed_at < sinceMs) continue;
    deliveries++;
    const o = orders[t.order_id];
    const total = o && typeof o.total === 'number' ? o.total : 0;
    const c = collectionFor(o || {});
    if (c.collect) totalCollected += total;                 // cash + card_delivery actually collected at the door
    if (c.owed) { cashOwed += total; cashOrderCount++; }    // cash to hand to the office (isCashPayment && !free_order)
    if (c.kind === 'paid_online') { paidOnlineTotal += total; paidOnlineCount++; }  // already paid — reported, never collected
  }
  return { deliveries, totalCollected, cashOwed, cashOrderCount, paidOnlineTotal, paidOnlineCount };
}
