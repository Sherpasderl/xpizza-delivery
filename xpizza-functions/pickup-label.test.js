'use strict';
// R3-FIX D12 — the pickup line names THIS restaurant from its own config. The helper, the fail-soft live read, and the REAL
// writers (create-order-build's buildCreateOrderUpdates over the real hubSnapshot; materialize's buildMaterializeUpdates)
// for x_pizza, la_musa and a synthetic THIRD restaurant — two brands can make a literal look right.
const assert = require('assert');
const { pickupLabel, brandText, readLiveBrand, BRAND_MAX } = require('./pickup-label');
const { hubSnapshot } = require('./restaurant-config');
const { buildCreateOrderUpdates } = require('./create-order-build');
const { buildMaterializeUpdates } = require('./materialize');
const { IDENTITIES } = require('./seed_identity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pickup-label: FAILED — exited without completing'); process.exitCode = 1; } });

(async () => {
  // ── the helper ──
  assert.strictEqual(pickupLabel('X. Pizza', 'X Pizza'), 'Recoger en X. Pizza');
  assert.strictEqual(pickupLabel(undefined, 'La Musa'), 'Recoger en La Musa');
  assert.strictEqual(pickupLabel('  ', null, '  Sushi Sur  '), 'Recoger en Sushi Sur', 'blank skipped, value trimmed');
  assert.strictEqual(pickupLabel(), 'Recoger en el restaurante');
  assert.strictEqual(pickupLabel(42, {}, ['X'], 'x'.repeat(BRAND_MAX + 1)), 'Recoger en el restaurante', 'non-strings and an over-long value are absent');
  assert.strictEqual(brandText('x'.repeat(BRAND_MAX)), 'x'.repeat(BRAND_MAX));
  ok('pickupLabel: the first usable candidate (trimmed, non-blank, ≤ 60 chars) names the brand; none → "Recoger en el restaurante"');

  // ── the live read: fail-SOFT ──
  const fakeDb = (vals, mode) => ({ ref: (p) => ({ once: () => (mode === 'throw' ? Promise.reject(new Error('down')) : mode === 'hang' ? new Promise(() => {}) : Promise.resolve({ val: () => vals[p] ?? null })) }) });
  assert.deepStrictEqual(await readLiveBrand(fakeDb({ 'restaurants/r/identity/display_name': 'D', 'restaurants/r/identity/name': 'N' }), 'r'), { display_name: 'D', name: 'N' });
  assert.strictEqual(await readLiveBrand(fakeDb({}, 'throw'), 'r'), null, 'a failed read → null');
  const t0 = Date.now();
  assert.strictEqual(await readLiveBrand(fakeDb({}, 'hang'), 'r'), null, 'a hung read → null');
  assert.ok(Date.now() - t0 < 3000, 'bounded');
  assert.strictEqual(await readLiveBrand(fakeDb({}), ''), null); assert.strictEqual(await readLiveBrand(null, 'r'), null);
  ok('readLiveBrand: both names; a failed, hung (bounded), rid-less or db-less read → null (never blocks a materialize)');

  // ── the snapshot: display name only when configured; never an undefined (RTDB refuses those) ──
  const X = { ...IDENTITIES.x_pizza, display_name: 'X. Pizza' };   // the post-seed x_pizza identity (owner step)
  const LM = IDENTITIES.la_musa;                                   // no display_name: its name IS its brand
  const R3 = { ...IDENTITIES.la_musa, name: 'Sushi Sur', display_name: 'Sushi Sur HN' };
  assert.strictEqual(hubSnapshot(X).restaurant_display_name, 'X. Pizza');
  assert.ok(!('restaurant_display_name' in hubSnapshot(LM)), 'absent stays absent');
  assert.ok(!('restaurant_display_name' in hubSnapshot({ ...LM, display_name: '   ' })), 'blank is absent');
  assert.ok(!Object.values(hubSnapshot(LM)).includes(undefined));
  ok('hubSnapshot: restaurant_display_name only when configured (blank/absent → no key, never undefined)');

  // ── the REAL createOrder writer, three restaurants ──
  const cash = (rid, id) => buildCreateOrderUpdates({
    orderId: `O_${rid}`, orderType: 'pickup', now: 1, trackingToken: `T_${rid}`, total: 100, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: '+504', items_text: 'x', notes: '', payment_method: 'cash', pickup_time: 'standard' },
    hubSnap: hubSnapshot(id), restaurantId: rid, priceBreakdown: { total_cents: 10000, subtotal_cents: 10000, tax_cents: 0 }, facturaPriced: { items: null }, cashTenderedCents: 10000,
  });
  const lines = {};
  for (const [rid, id, want] of [['x_pizza', X, 'Recoger en X. Pizza'], ['la_musa', LM, 'Recoger en La Musa'], ['r3_synth', R3, 'Recoger en Sushi Sur HN']]) {
    const u = cash(rid, id);
    lines[rid] = u[`order_tracking/T_${rid}`].address_short;
    assert.strictEqual(lines[rid], want, `${rid}: createOrder's pickup line`);
    assert.strictEqual(u[`orders/O_${rid}`].restaurant_display_name, id.display_name, `${rid}: the order carries its display-name snapshot (materialize reads it later)`);
  }
  assert.ok(!/X\.? ?Pizza/.test(lines.la_musa + lines.r3_synth), '🔴 no other brand ever reads X. Pizza');
  ok('createOrder writer (real builder + real hubSnapshot): x_pizza "Recoger en X. Pizza", la_musa "Recoger en La Musa", a third "Recoger en Sushi Sur HN"; the order keeps the snapshot');

  // ── the REAL materialize writer, three restaurants: the caller's `restaurant` (index.js's x_pizza constant) is NEVER used ──
  const XPIZZA_CONSTANT = { lat: 15.5, lng: -88, name: 'X Pizza', phone: '+504' };
  const mat = (order, liveIdentity) => buildMaterializeUpdates({ orderId: 'M', order: { order_id: 'M', order_type: 'pickup', items_text: 'x', total: 1, ...order }, trackingToken: 'TM', now: 1, restaurant: XPIZZA_CONSTANT, liveIdentity })['order_tracking/TM'].address_short;
  assert.strictEqual(mat({ restaurant_id: 'x_pizza', ...hubSnapshot(X) }), 'Recoger en X. Pizza');
  assert.strictEqual(mat({ restaurant_id: 'la_musa', ...hubSnapshot(LM) }), 'Recoger en La Musa');
  assert.strictEqual(mat({ restaurant_id: 'r3_synth', ...hubSnapshot(R3) }), 'Recoger en Sushi Sur HN');
  assert.strictEqual(mat({ restaurant_id: 'x_pizza', restaurant_name: 'X Pizza' }, { display_name: 'X. Pizza', name: 'X Pizza' }), 'Recoger en X. Pizza', 'an order from before D12: the LIVE display name');
  assert.strictEqual(mat({ restaurant_id: 'la_musa' }, { name: 'La Musa' }), 'Recoger en La Musa', 'pre-3b: the live name — not the constant');
  assert.strictEqual(mat({ restaurant_id: 'la_musa' }, null), 'Recoger en el restaurante', '🔴 pre-3b, nothing live: neutral — NEVER the x_pizza constant');
  assert.strictEqual(mat({ restaurant_id: 'x_pizza', ...hubSnapshot(X) }, { display_name: 'Otro' }), 'Recoger en X. Pizza', 'the order\'s own snapshot beats the live identity');
  ok('materialize writer: snapshot display → live display → snapshot name → live name → neutral, three restaurants; the x_pizza RESTAURANT constant never names a pickup');

  FINISHED = true;
  console.log(`\npickup-label: OK (${n})`);
})().catch((e) => { console.error('pickup-label FAILED:', e); process.exit(1); });
