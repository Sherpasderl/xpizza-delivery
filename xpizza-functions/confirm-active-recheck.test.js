'use strict';

/**
 * 3c (plan 10b) — confirm-time active-recheck with getIdentity PRESENT (prod-style deps).
 * Pre-capture inactive -> void + voided_inactive + no capture. Post-capture inactive -> always
 * materialize + alert once (marker). active -> no-op. config-fail pre-capture -> retryable.
 * Dep-free nested-tree RTDB mock (mirrors pixelpay-confirm.test.js).
 */
const assert = require('assert');
const { confirmOnlinePayment, confirmAndMaterialize } = require('./pixelpay-confirm');
const { buildMaterializeUpdates } = require('./materialize');

const FALLBACK = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
// hours: open 24/7 so the materialize-time closed-kitchen re-check (paid-after-close guard) passes and
// these tests exercise the inactive-restaurant recheck as intended (a separate concern from hours).
const OPEN_ALLDAY = { open: true, start: '00:00', end: '24:00' };
const ID = (active) => ({ active, hours: { sun: OPEN_ALLDAY, mon: OPEN_ALLDAY, tue: OPEN_ALLDAY, wed: OPEN_ALLDAY, thu: OPEN_ALLDAY, fri: OPEN_ALLDAY, sat: OPEN_ALLDAY }, hub_lat: 15.5, hub_lng: -88.0, name: 'X Pizza', phone: 'p', version: 1, delivery_radius_km: 7 });
let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let nn = root; for (const k of p.split('/')) { if (nn == null) return null; nn = nn[k]; } return nn === undefined ? null : nn; };
  const setAt = (p, val) => { const parts = p.split('/'); let nn = root; for (let i = 0; i < parts.length - 1; i++) { const k = parts[i]; if (nn[k] == null || typeof nn[k] !== 'object') nn[k] = {}; nn = nn[k]; } const last = parts[parts.length - 1]; if (val === null) delete nn[last]; else nn[last] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) {
      const real = clone(getAt(p));
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: { val: () => real } };
      if (real !== null) { next = fn(clone(real)); if (next === undefined) return { committed: false, snapshot: { val: () => real } }; }
      setAt(p, clone(next));
      return { committed: true, snapshot: { val: () => clone(getAt(p)) } };
    },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); } else setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); },
  });
  return { ref, _get: getAt };
}

(async () => {
  // ── Post-capture: inactive -> materialize + alert ONCE + marker; re-entry no re-alert ──
  {
    const db = makeDb({ orders: { O1: { order_type: 'pickup', payment_method: 'online', payment_status: 'pending', active_attempt_id: 'A1', restaurant_id: 'x_pizza', customer_name: 'A', items_text: 'x', total: 100, total_cents: 10000 } } });
    const alerts = [];
    const deps = { db, restaurant: FALLBACK, buildMaterializeUpdates, getIdentity: async () => ID(false), alert: (k, d) => alerts.push([k, d]) };
    const r = await confirmAndMaterialize(deps, { orderId: 'O1', attemptId: 'A1', now: 100, trackingToken: 'T1' });
    assert.equal(r.outcome, 'confirmed');
    const o = db._get('orders/O1');
    assert.equal(o.status, 'new');                          // materialized — NOT stranded
    assert.equal(o.materialized_at, 100);
    assert.equal(o.inactive_materialize_alerted_at, 100);   // idempotency marker written
    assert.deepEqual(alerts.map((a) => a[0]), ['materialized_into_inactive_restaurant']);
    const r2 = await confirmAndMaterialize(deps, { orderId: 'O1', attemptId: 'A1', now: 200, trackingToken: 'T1' });
    assert.equal(r2.outcome, 'already_confirmed');
    assert.equal(alerts.length, 1);                         // fired once, not per replay
    ok('post-capture inactive -> materialized + alert once + marker (no re-alert on re-entry)');
  }

  // ── Post-capture: active -> materialize, no alert, no marker ──
  {
    const db = makeDb({ orders: { O2: { order_type: 'pickup', payment_method: 'online', payment_status: 'pending', active_attempt_id: 'A1', restaurant_id: 'x_pizza', customer_name: 'B', items_text: 'y', total: 50, total_cents: 5000 } } });
    const alerts = [];
    const deps = { db, restaurant: FALLBACK, buildMaterializeUpdates, getIdentity: async () => ID(true), alert: (k, d) => alerts.push([k, d]) };
    const r = await confirmAndMaterialize(deps, { orderId: 'O2', attemptId: 'A1', now: 100, trackingToken: 'T2' });
    assert.equal(r.outcome, 'confirmed');
    assert.equal(db._get('orders/O2').inactive_materialize_alerted_at, undefined);
    assert.equal(alerts.length, 0);
    ok('post-capture active -> materialized, no alert/marker');
  }

  // ── Pre-capture: inactive -> void + voided_inactive + order failed + NO capture ──
  {
    const db = makeDb({ orders: { O3: { payment_method: 'online', payment_status: 'pending', active_attempt_id: 'A1', restaurant_id: 'x_pizza', total_cents: 10000 } }, payment_attempts: { A1: { status: 'active', payment_uuid: 'U1' } } });
    const calls = { getStatus: 0, capture: 0, void: 0 };
    const alerts = [];
    const deps = {
      db,
      client: { getStatus: async () => { calls.getStatus++; return {}; }, interpretStatus: () => ({}), capture: async () => { calls.capture++; return {}; }, voidTransaction: async () => { calls.void++; return { success: true }; } },
      getIdentity: async () => ID(false), chargeAmountLempiras: (c) => c / 100, restaurant: FALLBACK, buildMaterializeUpdates, alert: (k, d) => alerts.push([k, d]),
    };
    const r = await confirmOnlinePayment(deps, { orderId: 'O3', paymentUuid: 'U1', now: 100, trackingToken: 'T3' });
    assert.equal(r.outcome, 'voided_inactive');
    assert.equal(calls.void, 1);        // auth voided
    assert.equal(calls.capture, 0);     // NEVER captured into a deactivated Restaurant
    assert.equal(calls.getStatus, 0);   // returned before the capture flow, no claim planted
    assert.equal(db._get('payment_attempts/A1').status, 'voided_inactive');
    assert.equal(db._get('orders/O3').payment_status, 'failed');
    assert.deepEqual(alerts.map((a) => a[0]), ['confirm_voided_inactive']);
    ok('pre-capture inactive -> void + voided_inactive + order failed + NO capture/claim');
  }

  // ── Pre-capture: active -> recheck passes, proceeds to capture flow ──
  {
    const db = makeDb({ orders: { O4: { payment_method: 'online', payment_status: 'pending', active_attempt_id: 'A1', restaurant_id: 'x_pizza', total_cents: 10000 } }, payment_attempts: { A1: { status: 'active', payment_uuid: 'U1' } } });
    const calls = { getStatus: 0 };
    const deps = {
      db,
      client: { getStatus: async () => { calls.getStatus++; return {}; }, interpretStatus: () => ({ declined: true, status: 'declined' }), capture: async () => ({}), voidTransaction: async () => ({}) },
      getIdentity: async () => ID(true), chargeAmountLempiras: (c) => c / 100, restaurant: FALLBACK, buildMaterializeUpdates, alert: () => {},
    };
    const r = await confirmOnlinePayment(deps, { orderId: 'O4', paymentUuid: 'U1', now: 100, trackingToken: 'T4' });
    assert.equal(calls.getStatus, 1);   // passed the recheck, reached the capture flow
    assert.equal(r.outcome, 'failed');  // declined branch
    ok('pre-capture active -> recheck passes, proceeds to capture flow');
  }

  // ── Pre-capture: config unavailable -> retryable, no capture ──
  {
    const db = makeDb({ orders: { O5: { payment_method: 'online', payment_status: 'pending', active_attempt_id: 'A1', restaurant_id: 'x_pizza', total_cents: 10000 } }, payment_attempts: { A1: { status: 'active', payment_uuid: 'U1' } } });
    const calls = { getStatus: 0, capture: 0 };
    const deps = {
      db,
      client: { getStatus: async () => { calls.getStatus++; return {}; }, interpretStatus: () => ({}), capture: async () => { calls.capture++; return {}; }, voidTransaction: async () => ({}) },
      getIdentity: async () => { const e = new Error('down'); e.statusCode = 503; throw e; },
      chargeAmountLempiras: (c) => c / 100, restaurant: FALLBACK, buildMaterializeUpdates, alert: () => {},
    };
    const r = await confirmOnlinePayment(deps, { orderId: 'O5', paymentUuid: 'U1', now: 100, trackingToken: 'T5' });
    assert.equal(r.outcome, 'config_unavailable_retryable');
    assert.equal(calls.getStatus, 0);
    assert.equal(calls.capture, 0);
    ok('pre-capture config-fail -> retryable, no capture');
  }

  // ── [rev-5 Stage-2] resolving_* order → confirm SKIPS (dispatcher mid-resolve owns it) ──
  {
    const db = makeDb({ orders: { OR: { order_type: 'pickup', payment_method: 'online', payment_status: 'resolving_refund', active_attempt_id: 'A1', restaurant_id: 'x_pizza', total_cents: 10000 } } });
    const deps = { db, restaurant: FALLBACK, buildMaterializeUpdates, getIdentity: async () => ID(true), alert: () => {} };
    const r = await confirmOnlinePayment(deps, { orderId: 'OR', paymentUuid: 'U1', now: 100, trackingToken: 'T' });
    assert.equal(r.outcome, 'resolving_in_progress');
    ok('[Stage-2] resolving_* → confirmOnlinePayment skips (resolving_in_progress)');
  }

  console.log(`confirm-active-recheck: OK (${n} cases)`);
})().catch((e) => { console.error('confirm-active-recheck: FAIL\n', e); process.exit(1); });
