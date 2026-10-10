'use strict';
// 1D add-product B (codex PB-1 r1 P1-3) — the BOUND-REUSE probe, over the REAL classifier (pixelpay-hosted-charge
// classifyHostedAttempt) and a fake RTDB that TRAPS every write. Run: node catalog/bound-reuse.test.js
//   every condition holds → the reuse acq (same shape acquireHostedAttempt returns); breaking ANY single condition → null
//   (the current path); a read error → null; and no write is ever attempted.
const assert = require('assert');
const { probeBoundReuse } = require('./bound-reuse');
const CI = require('./charge-inputs');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
function fakeDb(data, { failPath = null, second = {} } = {}) {
  const writes = [];
  const seen = {};   // `second[path]`: what a SECOND read of that path returns (a state change between two reads)
  const trap = (op, path) => () => { writes.push(`${op} ${path}`); throw new Error(`write trapped: ${op} ${path}`); };
  return {
    writes,
    ref: (path) => ({
      once: async () => {
        if (failPath && path === failPath) throw new Error('UNAVAILABLE');
        seen[path] = (seen[path] || 0) + 1;
        const src = seen[path] > 1 && Object.prototype.hasOwnProperty.call(second, path) ? second : data;
        return { val: () => (Object.prototype.hasOwnProperty.call(src, path) && src[path] != null ? JSON.parse(JSON.stringify(src[path])) : null) };
      },
      set: trap('set', path), update: trap('update', path), transaction: trap('transaction', path), remove: trap('remove', path), push: trap('push', path),
    }),
  };
}
const NOW = 1_800_000_000_000;
const BODY = { order_id: 'LM-1', restaurant_id: 'la_musa', order_type: 'pickup', pickup_time: 'standard', payment_method: 'card', total: 342,
  items_text: '1x Pad Thai - Pollo (L342)', items: [{ id: 'noodle_01_pollo', name: 'Pad Thai - Pollo', qty: 1, price: 342 }],
  redeem: { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1, name: 'Wonton' }] }, customer_name: 'Ana', customer_phone: '99990000' };
const world = (patch = {}) => {
  const fp = 'PF-1';
  const d = {
    'orders/LM-1': { restaurant_id: 'la_musa', customer_uid: 'u1', charge_inputs_fp: CI.chargeInputsFingerprint(BODY), redemption: { v: 1 }, payment_fingerprint: fp,
      active_attempt_id: 'att1', payment_status: 'pending', status: 'pending_payment' },
    'payment_attempts/att1': { hosted_state: 'created', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/x', poll_token: 'pt' },
    'user_rewards/u1/la_musa/reservations/LM-1': { state: 'reserved', fp: 'BINDING-HASH', order_fingerprint: fp, canonical: { v: 1 }, attempt_id: 'att1' },
  };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete d[k]; else d[k] = { ...(d[k] || {}), ...v }; }
  return d;
};
const ask = (db, over = {}) => probeBoundReuse(db, { orderId: 'LM-1', uid: 'u1', rid: 'la_musa', body: BODY, now: NOW, ...over });

(async () => {
  {
    const db = fakeDb(world());
    assert.deepStrictEqual(await ask(db), { outcome: 'reuse', attempt_id: 'att1', checkout_url: 'https://pay/x', poll_token: 'pt' }, 'every condition holds → the reuse acq');
    assert.deepStrictEqual(db.writes, [], 'and nothing was written');
    assert.ok(await ask(fakeDb(world({ 'user_rewards/u1/la_musa/reservations/LM-1': { attempt_id: null } }))), 'a hold not yet attached to the attempt (attach is best-effort) is still this order\'s');
    ok('every condition holds → the same reuse acq acquire returns, with ZERO writes');
  }
  {
    const cases = {
      'different charge inputs (another option)': [world(), { body: { ...BODY, items: [{ ...BODY.items[0], extras: [{ id: 'rice_white', qty: 1 }] }] } }],
      'a different fee input (fulfilment)': [world(), { body: { ...BODY, order_type: 'delivery' } }],
      'an unclassified field in the request': [world(), { body: { ...BODY, surprise: 1 } }],
      'no reward in the request': [world(), { body: (() => { const b = { ...BODY }; delete b.redeem; return b; })() }],
      'another customer': [world(), { uid: 'u2' }],
      'no verified customer': [world(), { uid: null }],
      'another restaurant': [world(), { rid: 'x_pizza' }],
      'no bound fingerprint (issued before the capability)': [world({ 'orders/LM-1': { charge_inputs_fp: null } }), {}],
      'a canonical-format binding': [world({ 'orders/LM-1': { fp_format: 'canonical' } }), {}],
      'no bound redemption': [world({ 'orders/LM-1': { redemption: null } }), {}],
      'no active attempt': [world({ 'orders/LM-1': { active_attempt_id: null } }), {}],
      'an already-paid order': [world({ 'orders/LM-1': { payment_status: 'confirmed' } }), {}],
      'a cancelled order': [world({ 'orders/LM-1': { status: 'cancelled' } }), {}],
      'an EXPIRED attempt (rotation → current path)': [world({ 'payment_attempts/att1': { hosted_expires_at: NOW } }), {}],
      'an attempt still creating': [world({ 'payment_attempts/att1': { hosted_state: 'creating' } }), {}],
      'a created attempt with no URL': [world({ 'payment_attempts/att1': { hosted_checkout_url: null } }), {}],
      'the attempt record gone': [world({ 'payment_attempts/att1': undefined }), {}],
      'the hold released': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { state: 'released' } }), {}],
      'the hold consumed': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { state: 'consumed' } }), {}],
      'the hold bound to another order fingerprint': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { order_fingerprint: 'PF-OTHER' } }), {}],
      'the hold bound to another reward canonical': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { canonical: { v: 2 } } }), {}],
      'the hold bound to another attempt': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { attempt_id: 'att0' } }), {}],
      'a canonical-format hold': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': { fp_format: 'canonical' } }), {}],
      'the attempt EXPIRED between the classifier\'s read and ours': [world(), {}, { 'payment_attempts/att1': { hosted_state: 'created', hosted_expires_at: NOW - 1, hosted_checkout_url: 'https://pay/x', poll_token: 'pt' } }],
      'the attempt was CANCELLED between the classifier\'s read and ours': [world(), {}, { 'payment_attempts/att1': { hosted_state: 'cancelled', hosted_expires_at: NOW + 60000, hosted_checkout_url: 'https://pay/x' } }],
      'no hold at all': [world({ 'user_rewards/u1/la_musa/reservations/LM-1': undefined }), {}],
    };
    // isolations: each makes ONE check the only thing standing between the request and a reuse
    cases['another customer who ALSO holds a matching reservation for this order id'] = [{ ...world(), 'user_rewards/u2/la_musa/reservations/LM-1': { state: 'reserved', fp: 'BINDING-HASH', order_fingerprint: 'PF-1', canonical: { v: 1 }, attempt_id: 'att1' } }, { uid: 'u2' }];
    cases['an unclassified request against an order whose bound fingerprint is stored as null'] = [world({ 'orders/LM-1': { charge_inputs_fp: null } }), { body: { ...BODY, surprise: 1 } }];
    for (const [label, [data, over, second]] of Object.entries(cases)) {
      const db = fakeDb(data, { second: second || {} });
      assert.strictEqual(await ask(db, over), null, `🔴 ${label} → null (the current path)`);
      assert.deepStrictEqual(db.writes, [], `${label}: nothing written`);
    }
    for (const failPath of ['orders/LM-1', 'payment_attempts/att1', 'user_rewards/u1/la_musa/reservations/LM-1']) {
      assert.strictEqual(await ask(fakeDb(world(), { failPath })), null, `a read error on ${failPath} → null, never a throw`);
    }
    assert.strictEqual(await probeBoundReuse(null, { orderId: 'LM-1', uid: 'u1', rid: 'la_musa', body: BODY, now: NOW }), null, 'no db → null');
    ok(`breaking ANY single condition (${Object.keys(cases).length} cases) or any read error → null (the current path), with zero writes`);
  }
  console.log(`\nbound-reuse: OK (${n})`);
})().catch((e) => { console.error('bound-reuse FAILED:', e); process.exit(1); });
