'use strict';

/**
 * Pure assembly of a factura record from an order + fiscal config + a reserved number.
 * Money is copied VERBATIM from the order's *_cents (the renderer/record never recompute
 * the charged amount); per-line PRECIO bases are reconciled to subtotal_cents. X. Pizza is
 * 15%-only, so 18%/exento/exonerado are zero. This is what allocateFacturaNumber persists.
 */

const { reconcileLineBases } = require('./money');

const HN_OFFSET_MS = 6 * 3600 * 1000; // America/Tegucigalpa is UTC-6 year-round (no DST)
const pad2 = (n) => String(n).padStart(2, '0');

// '2026-11-20' -> '20/11/2026'
function isoToDMY(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}/${m}/${y}`;
}

// epoch ms -> { fecha: 'DD/MM/YYYY', hora: 'hh:mm:ss AM/PM' } in Honduras local time.
function formatHN(epochMs) {
  const t = new Date(epochMs - HN_OFFSET_MS); // shift, then read UTC fields
  const fecha = `${pad2(t.getUTCDate())}/${pad2(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`;
  let h = t.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const hora = `${pad2(h)}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())} ${ampm}`;
  return { fecha, hora };
}

const TARJETA = new Set(['card_delivery', 'online']);

function formaDePago(paymentMethod) {
  if (paymentMethod === 'cash') return 'EFECTIVO';
  if (TARJETA.has(paymentMethod)) return 'TARJETA';
  return 'NO IDENTIFICADO';
}

function buildFacturaRecord({ order, config, reserved, now }) {
  const num = String(reserved).padStart(8, '0');
  const { fecha, hora } = formatHN(now);

  const lineGross = order.items.map((i) => i.line_gross_cents);
  const bases = reconcileLineBases(lineGross, order.subtotal_cents);
  const items = order.items.map((it, i) => ({
    qty: it.qty,
    description: it.description,
    desc_pct: 0,
    base_cents: bases[i],
  }));

  const hasRtn = !!order.rtn_cliente;

  return {
    // emisor snapshot
    restaurant_name: config.restaurant_name,
    legal_name: config.legal_name,
    rtn: config.rtn,
    address_1: config.address_1,
    address_2: config.address_2,
    email: config.email,
    phone: config.phone,
    cai_code: config.cai_code,
    // document
    factura_number: `${config.prefix}-${num}`,
    pedido: order.orderId,
    order_id: order.orderId,
    fecha,
    hora,
    created_at: now,
    // buyer (D3)
    cliente: hasRtn ? order.razon_social : order.customer_name,
    rtn_cliente: hasRtn ? order.rtn_cliente : '',
    // line items (PRECIO bases foot to subtotal_cents)
    items,
    // money — verbatim from order; X. Pizza 15%-only
    desc_general_pct: 0,
    desc_rebaja_cents: 0,
    exonerado_cents: 0,
    exento_cents: 0,
    gravado_15_cents: order.subtotal_cents,
    gravado_18_cents: 0,
    isv_15_cents: order.tax_cents,
    isv_18_cents: 0,
    subtotal_cents: order.subtotal_cents,
    isv_total_cents: order.tax_cents,
    total_cents: order.total_cents,
    // payment
    forma_de_pago_label: formaDePago(order.payment_method),
    cambio_cents: order.payment_method === 'cash'
      ? Math.max(0, (order.cash_tendered_cents || 0) - order.total_cents)
      : 0,
    // authorization
    fecha_limite: isoToDMY(config.fecha_limite),
    rango_desde: `${config.prefix}-${String(config.range_start).padStart(8, '0')}`,
    rango_hasta: `${config.prefix}-${String(config.range_end).padStart(8, '0')}`,
    is_temp: !!config.is_temp,
    // lifecycle
    state: 'issued',
    printed: false,
    void: false,
  };
}

module.exports = { buildFacturaRecord, formatHN, isoToDMY, formaDePago };
