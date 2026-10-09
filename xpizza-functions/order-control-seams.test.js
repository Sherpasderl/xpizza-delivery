'use strict';
// D4-c4 — the two state-machine seams, at unit level (PLAN-D4c4 rev 13 §3/§3a/§0.2/§0.7). Run: node order-control-seams.test.js
//   1. acquireHostedAttempt's race guard (`controlRefuseFresh`): every FRESH issuance (create / install / recover / rotate)
//      is refused with the EXISTING conflict shape, reason 'order_control', BEFORE the CAS — nothing written; every
//      non-fresh answer (reuse / in_progress / already_paid / closed / conflict) is unchanged; off by default.
//   2. finalizeRelease's hold: PAUSED / UNKNOWN → status scheduled, release ownership cleared, control_held {at, cause}
//      (deduplicated), scheduled_blocked untouched, NO materialization; OPEN → today's release, the marker cleared.
// The real-handler proofs are test/order-control.emulator.test.js.
const assert = require('assert');
const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');
const REL = require('./scheduled-release-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const ops = [];
  const getAt = (p) => { if (!p) return root; let x = root; for (const k of p.split('/')) { if (x == null) return null; x = x[k]; } return x === undefined ? null : x; };
  const setAt = (p, val) => { const a = p.split('/'); let x = root; for (let i = 0; i < a.length - 1; i++) { if (x[a[i]] == null || typeof x[a[i]] !== 'object') x[a[i]] = {}; x = x[a[i]]; } if (val === null) delete x[a[a.length - 1]]; else x[a[a.length - 1]] = val; };
  const ref = (p = '') => ({
    async once() { ops.push(['once', p]); return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { ops.push(['transaction', p]); fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { ops.push(['update', p, Object.keys(patch).sort()]); if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } for (const [k, v] of Object.entries(patch)) setAt(`${p}/${k}`, clone(v)); },
  });
  return { ref, getAt, ops, root };
}
const NOW = 1_000_000_000;
const FP = 'fp-abc';
const PENDING = { order_id: 'O1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900 };
const live = (extra = {}) => ({ orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } }, payment_attempts: { AT1: { order_id: 'O1', hosted_state: 'created', hosted_expires_at: NOW + 10000, hosted_checkout_url: 'https://pay/X', poll_token: 'P', ...extra } } });
const acq = (db, armed) => acquireHostedAttempt(db, 'O1', PENDING, FP, NOW, [], () => 'ATNEW', () => 'TOKNEW', null, false, armed);

(async () => {
  // 1. the race guard
  const FRESH = {
    create: {},
    install: { orders: { O1: { ...PENDING, payment_fingerprint: FP } } },
    recover: { orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: FP } } },
    rotate_expired: live({ hosted_expires_at: NOW - 1 }),
    rotate_failed: live({ hosted_state: 'failed_create' }),
  };
  for (const [kind, init] of Object.entries(FRESH)) {
    const db = makeDb(init); const before = JSON.stringify(db.root);
    assert.deepStrictEqual(await acq(db, true), { outcome: 'conflict', reason: 'order_control' }, `${kind}: refused`);
    assert.ok(!db.ops.some((o) => o[0] === 'transaction' || o[0] === 'update'), `${kind}: refused BEFORE the CAS — nothing written`);
    assert.strictEqual(JSON.stringify(db.root), before);
    const open = makeDb(init);
    assert.strictEqual((await acq(open, false)).outcome, 'claimed', `${kind}: unarmed → today's fresh claim`);
    assert.strictEqual((await acquireHostedAttempt(makeDb(init), 'O1', PENDING, FP, NOW, [], () => 'ATNEW', () => 'TOKNEW')).outcome, 'claimed', `${kind}: the default (no argument) is unarmed`);
  }
  ok('race guard ARMED: create / install / recover / rotate (expired, failed) → {outcome:"conflict", reason:"order_control"} BEFORE the CAS, nothing written; unarmed (and by default) → today\'s fresh claim');
  {
    const cases = [
      ['reuse', live(), (r) => r.outcome === 'reuse' && r.checkout_url === 'https://pay/X'],
      ['in_progress', live({ hosted_state: 'creating' }), (r) => r.outcome === 'in_progress'],
      ['already_paid (attempt)', live({ hosted_state: 'paid' }), (r) => r.outcome === 'already_paid'],
      ['already_paid (order)', { ...live(), orders: { O1: { ...PENDING, payment_status: 'confirmed', active_attempt_id: 'AT1', payment_fingerprint: FP } } }, (r) => r.outcome === 'already_paid'],
      ['closed', live({ hosted_state: 'voided' }), (r) => r.outcome === 'closed'],
      ['conflict (cart)', { ...live(), orders: { O1: { ...PENDING, active_attempt_id: 'AT1', payment_fingerprint: 'OTHER' } } }, (r) => r.outcome === 'conflict' && r.reason !== 'order_control'],
    ];
    for (const [label, init, want] of cases) {
      const a = await acq(makeDb(init), true); const b = await acq(makeDb(init), false);
      assert.ok(want(a), `${label}: armed → ${JSON.stringify(a)}`);
      assert.deepStrictEqual(a, b, `${label}: armed == unarmed (the guard touches only fresh issuance)`);
    }
    // the guard is checked FIRST among the fresh-issuance refusals (a paused restaurant answers 423, not item_unavailable / client_update_race)
    const r = await acquireHostedAttempt(makeDb({}), 'O1', PENDING, FP, NOW, ['86d item'], () => 'X', () => 'T', null, true, true);
    assert.deepStrictEqual(r, { outcome: 'conflict', reason: 'order_control' });
  }
  ok('race guard ARMED leaves every non-fresh answer unchanged (reuse with its URL, in_progress, already_paid ×2, closed, a cart conflict); it is checked FIRST among the fresh-issuance refusals');

  // 2. the release hold
  const order = (extra = {}) => ({ order_id: 'S1', restaurant_id: 'r3_synthetic', status: 'releasing', release_claim_id: 'c1', releasing_since: NOW - 5, scheduled_for: NOW + 3600000, payment_method: 'cash', ...extra });
  const deps = (db, decision) => ({ db, alert: async () => { throw new Error('no alert on a hold'); }, genToken: () => 'TOK', restaurantFallback: { lat: 1, lng: 2, name: 'R', phone: '+504' }, orderControl: async (rid) => { assert.strictEqual(rid, 'r3_synthetic'); return decision; } });
  for (const [decision, cause] of [['paused', 'paused'], ['unavailable', 'unavailable']]) {
    const db = makeDb({ orders: { S1: order({ scheduled_blocked: 'unrelated', blocked_reason: 'x' }) } });
    const r = await REL.finalizeRelease(deps(db, decision), 'S1', db.getAt('orders/S1'), NOW);
    assert.deepStrictEqual(r, { released: false, blocked: false, held: true, cause });
    const o = db.getAt('orders/S1');
    assert.strictEqual(o.status, 'scheduled'); assert.ok(o.release_claim_id == null && o.releasing_since == null, 'release ownership cleared');
    assert.deepStrictEqual(o.control_held, { at: NOW, cause });
    assert.strictEqual(o.scheduled_blocked, 'unrelated', 'an unrelated block is left untouched'); assert.strictEqual(o.blocked_reason, 'x');
    assert.ok(!db.ops.some((x) => x[0] === 'once' && /identity\/hours/.test(x[1])), 'decided BEFORE today\'s hours read');
    assert.deepStrictEqual(db.ops.filter((x) => x[0] === 'update'), [['update', 'orders/S1', ['control_held', 'release_claim_id', 'releasing_since', 'status']]], 'ONE write, no materialization');
    // deduplicated: a second hold for the same cause keeps the first `at`
    const db2 = makeDb({ orders: { S1: order({ control_held: { at: NOW - 999, cause } }) } });
    await REL.finalizeRelease(deps(db2, decision), 'S1', db2.getAt('orders/S1'), NOW);
    assert.deepStrictEqual(db2.getAt('orders/S1').control_held, { at: NOW - 999, cause }, 'deduplicated');
    assert.deepStrictEqual(db2.ops.filter((x) => x[0] === 'update')[0][2], ['release_claim_id', 'releasing_since', 'status']);
    // a different cause replaces it
    const db3 = makeDb({ orders: { S1: order({ control_held: { at: NOW - 999, cause: cause === 'paused' ? 'unavailable' : 'paused' } }) } });
    await REL.finalizeRelease(deps(db3, decision), 'S1', db3.getAt('orders/S1'), NOW);
    assert.deepStrictEqual(db3.getAt('orders/S1').control_held, { at: NOW, cause });
  }
  ok('hold: PAUSED → cause "paused", UNKNOWN → cause "unavailable": status scheduled, release ownership cleared, control_held {at, cause}, an unrelated block untouched, ONE write, no hours read, no materialization, no alert; deduplicated for the same cause, replaced for another');
  {
    const HOURS = { sun: { open: true, start: '00:00', end: '24:00' }, mon: { open: true, start: '00:00', end: '24:00' }, tue: { open: true, start: '00:00', end: '24:00' }, wed: { open: true, start: '00:00', end: '24:00' }, thu: { open: true, start: '00:00', end: '24:00' }, fri: { open: true, start: '00:00', end: '24:00' }, sat: { open: true, start: '00:00', end: '24:00' } };
    const db = makeDb({ orders: { S1: order({ control_held: { at: 1, cause: 'paused' } }) }, restaurants: { r3_synthetic: { identity: { hours: HOURS } } } });
    const r = await REL.finalizeRelease(deps(db, null), 'S1', db.getAt('orders/S1'), NOW);
    assert.strictEqual(r.released, true);
    assert.ok(db.getAt('orders/S1').control_held == null, 'released → the marker cleared');
    assert.strictEqual(db.getAt('orders/S1').status, 'new');
    const dbm = makeDb({ orders: { S1: order({ control_held: { at: 1, cause: 'paused' }, scheduled_for: NOW - 6 * 3600000 }) }, restaurants: { r3_synthetic: { identity: { hours: HOURS } } } });
    const alerts = []; const d = { ...deps(dbm, null), alert: async (k) => alerts.push(k) };
    const rb = await REL.finalizeRelease(d, 'S1', dbm.getAt('orders/S1'), NOW);
    assert.strictEqual(rb.blocked, true); assert.strictEqual(dbm.getAt('orders/S1').scheduled_blocked, true); assert.ok(dbm.getAt('orders/S1').control_held == null);
    assert.deepStrictEqual(alerts, ['scheduled_blocked'], 'today\'s block-and-alert');
    const dbn = makeDb({ orders: { S1: order() }, restaurants: { r3_synthetic: { identity: { hours: HOURS } } } });
    await REL.finalizeRelease(deps(dbn, null), 'S1', dbn.getAt('orders/S1'), NOW);
    assert.ok(!dbn.ops.some((x) => x[0] === 'update' && x[2].some((k) => /control_held/.test(k))), 'no marker → no control_held key written (today\'s exact write)');
  }
  ok('OPEN (resume / expired until): today\'s release — the marker cleared on release AND on an expired slot\'s block-and-alert; an order never held gets today\'s exact write (no control_held key)');

  console.log(`\norder-control-seams: OK (${n})`);
})().catch((e) => { console.error('order-control-seams FAILED:', e && e.stack || e); process.exit(1); });
