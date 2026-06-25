'use strict';

/**
 * RTDB glue for factura allocation + void (ADR-0003). Thin orchestration around the pure,
 * tested cores (decideReserve, buildFacturaRecord). `db` is the firebase-admin RTDB handle
 * (or a compatible fake): db.ref(path).once('value' )|.set|.update|.remove|.transaction.
 *
 * At merge, the DB trigger `allocateFacturaOnSale` calls allocateFacturaNumber, and the
 * cancellation trigger calls voidFactura. Until then these run from the test harness.
 */

const { decideReserve } = require('./allocate');
const { buildFacturaRecord, hnDateISO } = require('./build-record');

const facturaPath = (rid, oid) => `facturas/${rid}/${oid}`;
const configPath = (rid) => `restaurants/${rid}/factura_config`;
const seqPath = (rid) => `restaurants/${rid}/factura_config/seq`;
const statusPath = (oid) => `orders/${oid}/factura_status`;

function isCancelled(order) {
  return order && (order.status === 'cancelled' ||
    order.factura_status === 'cancelled' || order.factura_status === 'void_pending');
}

async function allocateFacturaNumber(db, { restaurantId, orderId, order, now }) {
  const config = (await db.ref(configPath(restaurantId)).once('value')).val();
  if (!config) {
    await db.ref(statusPath(orderId)).set('failed');
    return { ok: false, reason: 'config_missing' };
  }

  // Idempotency: an already-issued factura wins, no new number.
  const existing = (await db.ref(facturaPath(restaurantId, orderId)).once('value')).val();
  if (existing && existing.state === 'issued') {
    return { ok: true, idempotent: true, reserved: parseInt(existing.factura_number.split('-').pop(), 10), factura: existing };
  }

  // Cancelled before issuance ⇒ no factura owed, no number burned (R6).
  if (isCancelled(order)) {
    await db.ref(statusPath(orderId)).set('cancelled');
    return { ok: false, skipped: 'cancelled' };
  }

  // Reserve a number atomically (concurrency-safe + fail-closed).
  let decision;
  await db.ref(seqPath(restaurantId)).transaction((seq) => {
    decision = decideReserve(seq, {
      orderId,
      rangeStart: config.range_start,
      rangeEnd: config.range_end,
      todayISO: hnDateISO(now),
      fechaLimiteISO: config.fecha_limite,
    });
    return decision.action === 'commit' ? decision.nextSeq : undefined; // idempotent/abort don't write
  });

  if (decision.action === 'abort') {
    await db.ref(statusPath(orderId)).set('failed');
    return { ok: false, reason: decision.reason };
  }

  const reserved = decision.reserved;

  // Build + persist the issued record.
  const record = buildFacturaRecord({ order, config, reserved, now });
  await db.ref(facturaPath(restaurantId, orderId)).set(record);

  // Clear the pending reservation (its audit home is now the issued record).
  await db.ref(seqPath(restaurantId)).transaction((seq) => {
    if (seq && seq.pending) delete seq.pending[orderId];
    return seq;
  });

  await db.ref(statusPath(orderId)).set('issued');

  // Race guard: if the order was cancelled while we issued, void the consumed number.
  const fresh = (await db.ref(`orders/${orderId}`).once('value')).val();
  if (fresh && fresh.status === 'cancelled') {
    await voidFactura(db, { restaurantId, orderId, reason: 'cancelado durante emision', now });
    return { ok: true, reserved, voided: true, factura: record };
  }

  return { ok: true, reserved, factura: record };
}

async function voidFactura(db, { restaurantId, orderId, reason, now }) {
  const ref = db.ref(facturaPath(restaurantId, orderId));
  const existing = (await ref.once('value')).val();

  if (!existing) {
    // Cancelled before any number was issued ⇒ nothing to void, no factura owed.
    await db.ref(statusPath(orderId)).set('cancelled');
    return { ok: true, no_factura: true };
  }
  if (existing.void) return { ok: true, idempotent: true };

  await ref.update({ void: true, void_reason: reason || '', voided_at: now });
  await db.ref(statusPath(orderId)).set('void');
  return { ok: true, voided: true };
}

module.exports = { allocateFacturaNumber, voidFactura };
