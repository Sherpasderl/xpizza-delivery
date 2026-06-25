'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFacturaRecord, formatHN, isoToDMY } = require('../src/build-record');

function cfg(overrides = {}) {
  return {
    restaurant_name: 'X PIZZA',
    legal_name: 'SHERPA S. DE R.L.',
    rtn: '05019024114145',
    address_1: 'BLVD. LOS PROCERES',
    address_2: 'SAN PEDRO SULA, CORTES',
    email: 'sherpasderl@gmail.com',
    phone: '(504) 9373-6607',
    cai_code: 'TEMP-CAI',
    prefix: '000-001-01',
    range_start: 1,
    range_end: 8000,
    fecha_limite: '2026-11-20', // ISO in config
    is_temp: true,
    ...overrides,
  };
}

function order(overrides = {}) {
  // total 52000 (L520) inclusive; subtotal/tax mirror priceBreakdown(52000)
  return {
    orderId: 'ORD-7788',
    items: [
      { qty: 2, description: 'PIZZA PEPPERONI', line_gross_cents: 40000 },
      { qty: 1, description: 'COCA-COLA', line_gross_cents: 3000 },
      { qty: 1, description: 'PALITROQUES', line_gross_cents: 9000 },
    ],
    total_cents: 52000,
    subtotal_cents: 45217,
    tax_cents: 6783,
    payment_method: 'cash',
    customer_name: 'JUAN PEREZ',
    razon_social: '',
    rtn_cliente: '',
    cash_tendered_cents: 60000,
    ...overrides,
  };
}

// ---- date helpers ----

test('isoToDMY converts ISO to DD/MM/YYYY', () => {
  assert.equal(isoToDMY('2026-11-20'), '20/11/2026');
});

test('formatHN renders America/Tegucigalpa (UTC-6) date + 12h time', () => {
  // 2026-06-26 01:24:16 UTC == 2026-06-25 07:24:16 PM in Honduras (UTC-6)
  const epoch = Date.UTC(2026, 5, 26, 1, 24, 16);
  assert.deepEqual(formatHN(epoch), { fecha: '25/06/2026', hora: '07:24:16 PM' });
});

test('formatHN handles midnight as 12:xx:xx AM (not 00)', () => {
  // 2026-06-25 06:05:09 UTC == 2026-06-25 12:05:09 AM HN
  const epoch = Date.UTC(2026, 5, 25, 6, 5, 9);
  assert.deepEqual(formatHN(epoch), { fecha: '25/06/2026', hora: '12:05:09 AM' });
});

// ---- buildFacturaRecord ----

test('factura_number is prefix + 8-digit zero-padded reserved number', () => {
  const r = buildFacturaRecord({ order: order(), config: cfg(), reserved: 123, now: Date.UTC(2026, 5, 26, 1, 24, 16) });
  assert.equal(r.factura_number, '000-001-01-00000123');
});

test('cash order maps to EFECTIVO and computes cambio', () => {
  const r = buildFacturaRecord({ order: order(), config: cfg(), reserved: 1, now: 0 });
  assert.equal(r.forma_de_pago_label, 'EFECTIVO');
  assert.equal(r.cambio_cents, 8000); // 60000 - 52000
});

test('card_delivery and online both map to TARJETA with no cambio', () => {
  const card = buildFacturaRecord({ order: order({ payment_method: 'card_delivery', cash_tendered_cents: 0 }), config: cfg(), reserved: 1, now: 0 });
  const online = buildFacturaRecord({ order: order({ payment_method: 'online', cash_tendered_cents: 0 }), config: cfg(), reserved: 1, now: 0 });
  assert.equal(card.forma_de_pago_label, 'TARJETA');
  assert.equal(card.cambio_cents, 0);
  assert.equal(online.forma_de_pago_label, 'TARJETA');
  assert.equal(online.cambio_cents, 0);
});

test('no-RTN order: CLIENTE = customer_name, rtn_cliente empty (D3)', () => {
  const r = buildFacturaRecord({ order: order(), config: cfg(), reserved: 1, now: 0 });
  assert.equal(r.cliente, 'JUAN PEREZ');
  assert.equal(r.rtn_cliente, '');
});

test('RTN order: razon_social replaces CLIENTE and buyer RTN is set (D3)', () => {
  const r = buildFacturaRecord({
    order: order({ razon_social: 'FOTEX S.A.', rtn_cliente: '05019024077021' }),
    config: cfg(), reserved: 1, now: 0,
  });
  assert.equal(r.cliente, 'FOTEX S.A.');
  assert.equal(r.rtn_cliente, '05019024077021');
});

test('money: 15%-only mapping, verbatim from order, lines foot to subtotal', () => {
  const r = buildFacturaRecord({ order: order(), config: cfg(), reserved: 1, now: 0 });
  assert.equal(r.subtotal_cents, 45217);
  assert.equal(r.isv_15_cents, 6783);
  assert.equal(r.isv_18_cents, 0);
  assert.equal(r.gravado_15_cents, 45217);
  assert.equal(r.gravado_18_cents, 0);
  assert.equal(r.total_cents, 52000);
  const colSum = r.items.reduce((a, i) => a + i.base_cents, 0);
  assert.equal(colSum, r.subtotal_cents); // PRECIO column foots exactly
  assert.equal(r.items.length, 3);
});

test('snapshots emisor identity + range strings + is_temp + DMY fecha_limite', () => {
  const r = buildFacturaRecord({ order: order(), config: cfg(), reserved: 1, now: 0 });
  assert.equal(r.rtn, '05019024114145');
  assert.equal(r.legal_name, 'SHERPA S. DE R.L.');
  assert.equal(r.is_temp, true);
  assert.equal(r.fecha_limite, '20/11/2026'); // converted from ISO for display
  assert.equal(r.rango_desde, '000-001-01-00000001');
  assert.equal(r.rango_hasta, '000-001-01-00008000');
  assert.equal(r.pedido, 'ORD-7788');
});
