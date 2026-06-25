'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allocateFacturaNumber, voidFactura } = require('../src/factura-helpers');
const { makeFakeDb } = require('./helpers/fake-rtdb');

const RID = 'x_pizza';
const NOW = Date.UTC(2026, 5, 26, 1, 24, 16); // 25/06/2026 in HN

function seededConfig(overrides = {}) {
  return {
    restaurant_name: 'X PIZZA', legal_name: 'SHERPA S. DE R.L.', rtn: '05019024114145',
    address_1: 'BLVD', address_2: 'SPS', email: 'e@x', phone: 'p', cai_code: 'TEMP',
    prefix: '000-001-01', range_start: 1, range_end: 8000, fecha_limite: '2026-11-20',
    is_temp: true,
    seq: { last_reserved: 0, pending: {} },
    ...overrides,
  };
}

function seededDb(configOverrides = {}) {
  return makeFakeDb({ restaurants: { [RID]: { factura_config: seededConfig(configOverrides) } } });
}

function order(overrides = {}) {
  return {
    orderId: 'ORD-1', status: 'new',
    items: [{ qty: 1, description: 'PIZZA', line_gross_cents: 11500 }],
    total_cents: 11500, subtotal_cents: 10000, tax_cents: 1500,
    payment_method: 'cash', customer_name: 'JUAN', razon_social: '', rtn_cliente: '',
    cash_tendered_cents: 20000,
    ...overrides,
  };
}

test('happy path: reserves range_start, writes issued record, clears pending, advances counter', async () => {
  const db = seededDb();
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reserved, 1);

  const dump = db._dump();
  const fact = dump.facturas[RID]['ORD-1'];
  assert.equal(fact.factura_number, '000-001-01-00000001');
  assert.equal(fact.state, 'issued');
  assert.equal(fact.total_cents, 11500);
  assert.equal(dump.restaurants[RID].factura_config.seq.last_reserved, 1);
  assert.deepEqual(dump.restaurants[RID].factura_config.seq.pending, {}); // cleared
});

test('idempotent: a second allocation for the same order does NOT burn a new number', async () => {
  const db = seededDb();
  const a = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  const b = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  assert.equal(a.reserved, 1);
  assert.equal(b.idempotent, true);
  assert.equal(b.reserved, 1);
  assert.equal(db._dump().restaurants[RID].factura_config.seq.last_reserved, 1); // not 2
});

test('two different orders get consecutive numbers', async () => {
  const db = seededDb();
  const a = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order({ orderId: 'ORD-1' }), now: NOW });
  const b = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-2', order: order({ orderId: 'ORD-2' }), now: NOW });
  assert.equal(a.reserved, 1);
  assert.equal(b.reserved, 2);
});

test('fail-closed on exhausted range: no record, order marked failed with reason', async () => {
  const db = seededDb({ seq: { last_reserved: 8000, pending: {} } });
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'range_exhausted');
  assert.equal(db._dump().facturas, undefined); // nothing written
  assert.equal(db._dump().orders['ORD-1'].factura_status, 'failed');
});

test('fail-closed past fecha_limite', async () => {
  const db = seededDb({ fecha_limite: '2026-06-24' }); // before NOW (25th)
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('cancelled-before-issuance: no number burned, no factura written', async () => {
  const db = seededDb();
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order({ status: 'cancelled' }), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'cancelled');
  assert.equal(db._dump().restaurants[RID].factura_config.seq.last_reserved, 0); // untouched
  assert.equal(db._dump().facturas, undefined);
});

test('missing config: marked failed with config_missing', async () => {
  const db = makeFakeDb({});
  const r = await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'config_missing');
});

test('voidFactura on an issued record sets void:true and keeps the number', async () => {
  const db = seededDb();
  await allocateFacturaNumber(db, { restaurantId: RID, orderId: 'ORD-1', order: order(), now: NOW });
  const v = await voidFactura(db, { restaurantId: RID, orderId: 'ORD-1', reason: 'cliente rechazo', now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.voided, true);
  const fact = db._dump().facturas[RID]['ORD-1'];
  assert.equal(fact.void, true);
  assert.equal(fact.void_reason, 'cliente rechazo');
  assert.equal(fact.factura_number, '000-001-01-00000001'); // number retained
});

test('voidFactura when no factura exists: no factura owed, order marked cancelled', async () => {
  const db = seededDb();
  const v = await voidFactura(db, { restaurantId: RID, orderId: 'ORD-1', reason: 'sold out', now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.no_factura, true);
  assert.equal(db._dump().orders['ORD-1'].factura_status, 'cancelled');
  assert.equal(db._dump().facturas, undefined);
});
