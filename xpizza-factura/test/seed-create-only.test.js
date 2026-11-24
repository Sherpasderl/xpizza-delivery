'use strict';
// PLAN-manual-factura r3 §13 (Codex #251-3): seed_factura_config is CREATE-ONLY. It used to run an unconditional .set on the PARENT
// restaurants/{rid}/factura_config, which would WIPE seq (the counter) and every factura_config/manual record (issued manual facturas). Now it
// is ONE transaction that writes the TEMP config only when no factura_config exists, and refuses otherwise — leaving every byte as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { seedCreateOnly, TEMP_CONFIG } = require('../seed_factura_config');
const { makeFakeDb } = require('./helpers/fake-rtdb');

test('SEED-CREATE: no factura_config ⇒ the TEMP config is created', async () => {
  const db = makeFakeDb({});
  const r = await seedCreateOnly(db, 'x_pizza');
  assert.deepEqual(r, { created: true });
  assert.deepEqual(db._dump().restaurants.x_pizza.factura_config, TEMP_CONFIG);
});

test('SEED-REFUSE: an existing factura_config (a counter + a manual record) ⇒ refused, byte-identical', async () => {
  const live = { cai_code: 'REAL-CAI', prefix: '000-001-01', range_start: 1, range_end: 8000, fecha_limite: '2027-06-30', is_temp: false,
    seq: { last_reserved: 41, pending: {} }, manual: { op1: { numero: 41, state: 'issued' } } };
  for (const cfg of [live, { cai_code: 'X' }, { seq: { last_reserved: 0 } }]) {
    const db = makeFakeDb({ restaurants: { x_pizza: { factura_config: cfg } } });
    const before = JSON.stringify(db._dump());
    const r = await seedCreateOnly(db, 'x_pizza');
    assert.deepEqual(r, { created: false, reason: 'exists' }, '🔴 SEED-REFUSE: an existing config is never overwritten');
    assert.equal(JSON.stringify(db._dump()), before, '🔴 SEED-REFUSE: nothing changed');
  }
});
