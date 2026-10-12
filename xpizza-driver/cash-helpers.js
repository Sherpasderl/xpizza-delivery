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

// Shown for EVERY blocked clock-out (missing shift identity, a persistently-rejected cuadre, or no server ack):
// the driver can't self-close, so route them to dispatch, which has an operational exit ("Sacar de turno") and
// reconciles the cash by hand. Retry stays available wherever a retry control exists (codex core r1 P2-1).
export const BLOCKED_CLOSE_TEXT = 'No se pudo cerrar el turno. Contactá a despacho para cerrar el turno y reconciliar el efectivo.';

// The approved guidance when a DUAL-ROLE account (a driver who is ALSO a dispatcher) tries to complete a
// delivery: the stamp rules intentionally reject it (r1 P2-2). Shown ONLY with confirmed dispatcher membership.
export const DUAL_ROLE_COMPLETE_TEXT = 'Entregá desde una cuenta de repartidor; contactá a despacho.';
// Neutral guidance for a PERMISSION_DENIED on an ORDINARY driver — the realistic cause is the delivery was
// reassigned away (or auth lapsed), NOT a dual-role account (codex r2: the dual-role mapping was too broad).
export const REASSIGNED_COMPLETE_TEXT = 'No se pudo completar la entrega. Puede que el pedido haya sido reasignado — contactá a despacho.';

/**
 * Map a completeTask failure to a driver-facing message. completeTask's own human Spanish refusals (cancelled /
 * task-gone) pass through. A rules PERMISSION_DENIED means the stamp write was rejected: the dual-role guidance
 * applies ONLY when the acting account is CONFIRMED to be a dispatcher (`isDispatcher === true`, from reading
 * /dispatchers/{uid}); otherwise it is the ordinary reassigned/auth-lapse case → neutral guidance. Anything else
 * → a generic retry line. `isDispatcher` is fail-safe false (unknown ⇒ neutral, never a wrong account-switch nag).
 */
export function completeErrorText(err, isDispatcher) {
  const s = String((err && (err.message || err.code)) || '');
  if (/ya no existe|cancelad/i.test(s)) return s.replace(/^Error:\s*/i, '');
  if (/permission.?denied/i.test(s)) return isDispatcher === true ? DUAL_ROLE_COMPLETE_TEXT : REASSIGNED_COMPLETE_TEXT;
  return 'No se pudo marcar como entregado — reintentá.';
}

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
 * A shift's deliveries for `uid`, from the DURABLE order attribution — NOT the live /tasks subscription.
 * Since 97fe1dd the server deletes both task legs the instant an order goes delivered/completed, so the old
 * task-iterating source read empty. The money-grade source is the identity captured IN the completion batch:
 * `orders/<id>/delivered_by_driver_uid` (rules: assigned driver, self, once, on the delivered transition), with
 * the async `delivered_by_uid` as a BOUNDED legacy fallback (only for orders delivered before the cutover).
 *
 * Classifies each order delivered at/after `sinceMs` into, for THIS driver:
 *   resolved          — delivered_by_driver_uid === uid (money-grade).
 *   legacyProvisional — no primary stamp, delivered BEFORE the cutover, delivered_by_uid === uid (provisional evidence).
 *   pending           — no primary stamp, delivered AFTER the cutover, delivered_by_uid === uid (UNRESOLVED; never counted).
 * `cutoverMs == null` means "confirmed-absent" → pre-cutover mode (everything legacy is provisional, nothing pending).
 * An order with NEITHER identity (delivered by nobody-we-can-name) is in no driver's list. A later-cancelled order
 * keeps its delivered_at and so stays in scope (the driver physically collected the cash; refunds are office-side).
 */
export function shiftDeliveries(ordersMap, uid, sinceMs, cutoverMs) {
  const resolved = [], legacyProvisional = [], pending = [];
  for (const id in (ordersMap || {})) {
    const o = ordersMap[id];
    const at = o && typeof o.delivered_at === 'number' ? o.delivered_at : null;
    if (at == null || at < sinceMs) continue;
    const stamp = o.delivered_by_driver_uid, legacy = o.delivered_by_uid;
    if (stamp === uid) { resolved.push({ orderId: id, order: o, at }); continue; }   // money-grade
    if (stamp != null) continue;                                                     // authoritatively someone else
    const preCutover = (cutoverMs == null) || (at < cutoverMs);
    if (preCutover) { if (legacy === uid) legacyProvisional.push({ orderId: id, order: o, at }); }
    else { if (legacy === uid) pending.push(id); }                                   // post-cutover, no stamp ⇒ unresolved
  }
  return { resolved, legacyProvisional, pending };
}

/**
 * Shift cash + delivery totals from the driver's attributed orders (via shiftDeliveries). Every money figure
 * is derived from collectionFor so the cuadre can never disagree with what the driver was shown per-order:
 *   totalCollected — Σ order.total the driver actually collects at the door (cash + card_delivery).
 *   cashOwed       — Σ order.total for cash / legacy efectivo (the cash to hand in).
 *   paidOnlineTotal/paidOnlineCount — already-paid online orders, reported separately, never collected.
 * Cash counts resolved + legacyProvisional. `provisional` is true when any evidence is non-money-grade (legacy or
 * unresolved) — the cuadre must then be persisted + shown as provisional, never as an ordinary final number.
 * Returns the figures plus { provisional, legacy_provisional_count/ids, unresolved_count/ids }.
 */
export function computeShiftCash(ordersMap, uid, sinceMs, cutoverMs) {
  const { resolved, legacyProvisional, pending } = shiftDeliveries(ordersMap, uid, sinceMs, cutoverMs);
  let deliveries = 0, totalCollected = 0, cashOwed = 0, cashOrderCount = 0, paidOnlineTotal = 0, paidOnlineCount = 0;
  for (const { order } of resolved.concat(legacyProvisional)) {
    deliveries++;
    const total = typeof order.total === 'number' ? order.total : 0;
    const c = collectionFor(order);
    if (c.collect) totalCollected += total;                 // cash + card_delivery actually collected at the door
    if (c.owed) { cashOwed += total; cashOrderCount++; }    // cash to hand to the office (isCashPayment && !free_order)
    if (c.kind === 'paid_online') { paidOnlineTotal += total; paidOnlineCount++; }  // already paid — reported, never collected
  }
  return {
    deliveries, totalCollected, cashOwed, cashOrderCount, paidOnlineTotal, paidOnlineCount,
    provisional: legacyProvisional.length > 0 || pending.length > 0,
    legacy_provisional_count: legacyProvisional.length,
    legacy_provisional_ids: legacyProvisional.map((d) => d.orderId),
    unresolved_count: pending.length,
    unresolved_ids: pending.slice(),
  };
}

/**
 * Shift identity is MANDATORY to record a cuadre. A missing driver/shift id used to make recordCuadre
 * silently resolve WITHOUT writing — a web cuadre no-op'd yet looked finalized (part of the L0 money loss).
 * Returns a human message (Spanish, driver-facing) when an id is missing, else null. recordCuadre throws on
 * a non-null result; pure + node-tested so the invariant can't silently regress. See [[shiftDeliveries]].
 */
export function shiftIdentityError(driverId, shiftId) {
  if (!driverId) return 'No se pudo identificar al repartidor — reintentá el cierre.';
  if (!shiftId) return 'No se pudo identificar el turno — reintentá el cierre.';
  return null;
}

/**
 * The EXACT field map written to driver_cash/<uid>/<shift>/cuadre (minus closed_at, which must be the
 * server timestamp supplied by the Firebase wrapper). Takes a computeShiftCash result directly and maps its
 * camelCase figures (cashOwed/cashOrderCount) onto the STORED snake_case schema (cash_owed/cash_order_count)
 * the dispatch reader already consumes. RTDB update() does NOT clear omitted fields, so a clean
 * (non-provisional) cuadre MUST explicitly carry the reset values — else a provisional figure from an earlier
 * attempt on the same shift lingers. Empty id lists are written as null (RTDB drops empty arrays, and null
 * positively clears any prior value). Pure so the reset discipline is node-tested.
 */
export function cuadreRecordPayload(cuadre) {
  const c = cuadre || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  const lp = Array.isArray(c.legacy_provisional_ids) ? c.legacy_provisional_ids : [];
  const un = Array.isArray(c.unresolved_ids) ? c.unresolved_ids : [];
  return {
    cash_owed: num(c.cashOwed != null ? c.cashOwed : c.cash_owed),              // computeShiftCash → stored schema
    cash_order_count: num(c.cashOrderCount != null ? c.cashOrderCount : c.cash_order_count),
    provisional: !!c.provisional,
    legacy_provisional_count: num(c.legacy_provisional_count),
    legacy_provisional_ids: lp.length ? lp.slice() : null,
    unresolved_count: num(c.unresolved_count),
    unresolved_ids: un.length ? un.slice() : null,
    close_op_id: c.close_op_id != null ? c.close_op_id : null,
  };
}
