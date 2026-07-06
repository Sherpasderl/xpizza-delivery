'use strict';

// Emulator F-matrix for the Scheduled-Orders release core (scheduled-release-core.js).
// Run: JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only database --project demo-xpizza \
//        "node test/scheduled-release.emulator.test.js"
// Drives REAL transactions: atomic claim, double-release idempotency, cancel-race, closed-at-release
// hold+alert (+ skip-blocked no re-alert), delivery materialize, online charged_at preserved, stale recovery.
const assert = require('assert');
const admin = require('firebase-admin');
const S = require('../scheduled-orders');
const REL = require('../scheduled-release-core');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) { console.error('MUST run under firebase emulators:exec --only database'); process.exit(1); }
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.database();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const L = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h + 6, mi);
const HOURS = { sun: { open: true, start: '12:00', end: '20:45' }, mon: { open: false, start: '00:00', end: '00:00' }, tue: { open: true, start: '17:00', end: '20:45' }, wed: { open: true, start: '17:00', end: '20:45' }, thu: { open: true, start: '17:00', end: '20:45' }, fri: { open: true, start: '17:00', end: '21:45' }, sat: { open: true, start: '17:00', end: '21:45' } };
const SLOT = L(2026, 0, 6, 18, 0);            // Tue 18:00 (open)
const NOW = L(2026, 0, 6, 17, 30);            // release time (SLOT − 30m lead) — due

let tok = 0; const alerts = [];
const deps = { db, alert: async (kind, detail) => { alerts.push({ kind, detail }); }, genToken: () => `TOK${++tok}`, restaurantFallback: { lat: 15.5, lng: -88.0, name: 'X. Pizza', phone: '+504' } };

async function seedScheduled(id, over = {}) {
  await db.ref('restaurants/x_pizza/identity/hours').set(HOURS);
  await db.ref(`orders/${id}`).set({
    order_id: id, status: 'scheduled', restaurant_id: 'x_pizza', order_type: over.order_type || 'pickup',
    scheduled_for: over.scheduled_for ?? SLOT, release_at: over.release_at ?? (SLOT - 30 * 60000),
    customer_name: 'Ana', customer_phone: '99998888', items_text: 'Pizza x1', total: 350,
    payment_method: over.payment_method || 'cash', hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'X. Pizza', restaurant_phone: '+504',
    factura_status: 'not_due', ...over.extra,
    ...(over.order_type === 'delivery' ? { lat: 15.6, lng: -88.1, address_detected: 'Calle 1, SPS', address_details: 'casa azul' } : {}),
  });
}

(async () => {
  // ── 1. Atomic release: due scheduled pickup → materialized (status new + token + tracking) ──
  await db.ref('/').set(null); await seedScheduled('R1');
  assert.strictEqual(await val('tasks/R1_pickup'), null); assert.strictEqual(await val('order_tracking'), null); ok('1: HELD order has NO tasks and NO tracking pre-release (non-live)');
  const r1 = await REL.releaseOne(deps, { orderId: 'R1', now: NOW, claimId: 'c1' });
  assert.strictEqual(r1.released, true); const o1 = await val('orders/R1');
  assert.strictEqual(o1.status, 'new'); assert.ok(o1.materialized_at && o1.tracking_token && o1.released_at); assert.ok(o1.release_claim_id == null); ok('1: released → status new + materialized_at + tracking_token + released_at, claim cleared');
  assert.strictEqual((await val(`order_tracking/${o1.tracking_token}`)).status, 'new'); ok('1: first tracking state created at release (status new)');

  // ── 2. Double-release idempotency: a second claim can't re-materialize ──
  const r1b = await REL.releaseOne(deps, { orderId: 'R1', now: NOW, claimId: 'c2' });
  assert.strictEqual(r1b.claimed, false); assert.strictEqual((await val('orders/R1')).materialized_at, o1.materialized_at); ok('2: second release on an already-live order → not claimable, no re-materialize');

  // ── 3. Cancel-race: resolving_action:cancel → claim aborts ──
  await db.ref('/').set(null); await seedScheduled('R3', { extra: { resolving_action: 'cancel' } });
  const r3 = await REL.releaseOne(deps, { orderId: 'R3', now: NOW, claimId: 'c3' });
  assert.strictEqual(r3.claimed, false); assert.strictEqual((await val('orders/R3')).status, 'scheduled'); ok('3: cancel in progress → release aborts, stays scheduled');

  // ── 4. Closed-at-release → HOLD + block + alert (never materialize) ──
  await db.ref('/').set(null); const beforeAlerts = alerts.length;
  await seedScheduled('R4', { scheduled_for: L(2026, 0, 6, 21, 30), release_at: NOW }); // 21:30 is past close 20:45
  const r4 = await REL.releaseOne(deps, { orderId: 'R4', now: NOW, claimId: 'c4' });
  assert.strictEqual(r4.blocked, true); assert.strictEqual(r4.reason, 'closed_at_slot'); const o4 = await val('orders/R4');
  assert.strictEqual(o4.status, 'scheduled'); assert.strictEqual(o4.scheduled_blocked, true); assert.strictEqual(o4.blocked_reason, 'closed_at_slot'); assert.ok(o4.release_claim_id == null); ok('4: closed slot → NOT materialized, scheduled_blocked:true + blocked_reason, claim reverted');
  assert.strictEqual(await val('tasks/R4_pickup'), null); ok('4: blocked → no tasks/tracking (never dumped on a dark kitchen)');
  assert.ok(alerts.length === beforeAlerts + 1 && alerts[alerts.length - 1].kind === 'scheduled_blocked'); ok('4: dispatcher scheduled_blocked alert raised');

  // ── 5. Skip-blocked: re-releasing a blocked order → not claimable, NO re-alert (R2-#1) ──
  const alertsNow = alerts.length;
  const r5 = await REL.releaseOne(deps, { orderId: 'R4', now: NOW, claimId: 'c5' });
  assert.strictEqual(r5.claimed, false); assert.strictEqual(alerts.length, alertsNow); ok('5: blocked order skipped on re-run → no claim, NO re-alert (no alert loop)');

  // ── 6. Delivery release: tasks materialized, delivery payment_method preserved ──
  await db.ref('/').set(null); await seedScheduled('R6', { order_type: 'delivery', payment_method: 'online' });
  await REL.releaseOne(deps, { orderId: 'R6', now: NOW, claimId: 'c6' });
  assert.ok(await val('tasks/R6_pickup') && await val('tasks/R6_delivery')); assert.strictEqual((await val('tasks/R6_delivery')).payment_method, 'online'); ok('6: delivery release → pickup+delivery tasks, delivery payment_method preserved (online)');

  // ── 7. Online paid held: release does NOT overwrite charged_at (captured at hold) ──
  await db.ref('/').set(null); await seedScheduled('R7', { payment_method: 'online', extra: { payment_status: 'confirmed', charged_at: 111111 } });
  await REL.releaseOne(deps, { orderId: 'R7', now: NOW, claimId: 'c7' }); const o7 = await val('orders/R7');
  assert.strictEqual(o7.charged_at, 111111); assert.strictEqual(o7.payment_status, 'confirmed'); assert.strictEqual(o7.status, 'new'); ok('7: online paid-held → charged_at preserved (hold time), payment_status confirmed, status new');

  // ── 8. Recover stale releasing (claim died mid-finalize) ──
  await db.ref('/').set(null); await seedScheduled('R8', { extra: { status: 'releasing', releasing_since: NOW - 10 * 60000, release_claim_id: 'dead' } });
  const r8 = await REL.recoverStaleReleasing(deps, { orderId: 'R8', now: NOW, claimId: 'c8' });
  assert.strictEqual(r8.recovered, true); assert.strictEqual((await val('orders/R8')).status, 'new'); ok('8: stale releasing (>5m) → recovered + materialized');

  // ── 9. Fresh releasing is NOT recovered (protects a live in-flight claim) ──
  await db.ref('/').set(null); await seedScheduled('R9', { extra: { status: 'releasing', releasing_since: NOW - 30000, release_claim_id: 'live' } });
  const r9 = await REL.recoverStaleReleasing(deps, { orderId: 'R9', now: NOW, claimId: 'c9' });
  assert.strictEqual(r9.recovered, false); assert.strictEqual((await val('orders/R9')).status, 'releasing'); ok('9: fresh releasing (<5m) → not recovered (in-flight protected)');

  console.log(`\n${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('F-MATRIX FAILED:', e); process.exit(1); });
