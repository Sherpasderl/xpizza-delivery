'use strict';
/**
 * OWNER-RUN emulator test — notifyPreparing (Fix A: proactive "preparando · listo en ~X min" WhatsApp).
 *
 *   npm run test:preparing-ready
 *   (= firebase emulators:exec --only database --project demo-xpizza "node test/preparing-ready.emulator.test.js")
 *   Needs Java + the Firebase emulator, like pickup-ready.emulator.test.js.
 *
 * Invokes the REAL onValueWritten trigger via `.run({data:{before,after},params})` against the RTDB emulator,
 * with `whatsapp.sendMessage` monkey-patched to a controllable spy AND `db.ref` instrumented to (a) record
 * every WRITE attempt (set/update/remove/push/transaction — catches transient writes a final snapshot misses)
 * and (b) inject read/write faults on chosen paths. Asserts: one send per order (both types); redelivery+
 * concurrent → one; stale-status suppression; isSendConfirmed classification; eligibility skips; ETA config +
 * ABSENT-fallback + REJECTED-read-fallback; failed send_started_at write → no send; claim retained across a
 * redelivery AFTER a failed send; mark-before-send ordering; and ZERO writes outside the per-order marker.
 */
const assert = require('assert');

// ── PROD-WIPE SAFETY GUARD (BEFORE require('../index.js'), which initializeApp's a PRODUCTION databaseURL,
//    index.js:148). This test wipes db.ref('/'); GCLOUD_PROJECT alone does NOT redirect an explicit
//    databaseURL. Refuse to run unless the RTDB EMULATOR host is wired (emulators:exec sets it). ──
(function requireEmulator() {
  const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
  const local = /(^|\/\/|@)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:\d+)?$/.test(host) || /localhost|127\.0\.0\.1/.test(host);
  if (!host || !local) {
    console.error('\n🛑 REFUSING TO RUN — FIREBASE_DATABASE_EMULATOR_HOST is not a local emulator.');
    console.error('   This test wipes the database ROOT and index.js points at PRODUCTION. Run it via:');
    console.error('   npm run test:preparing-ready   (firebase emulators:exec --only database …)\n');
    process.exit(2);
  }
})();

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA || 'instanceTEST';
process.env.ULTRAMSG_TOKEN_LA_MUSA = process.env.ULTRAMSG_TOKEN_LA_MUSA || 'tokTEST';
process.env.TRACKING_BASE_LA_MUSA = process.env.TRACKING_BASE_LA_MUSA || 'https://track.lamusa.hn';

const app = require('../index.js');
const whatsapp = require('../whatsapp');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

// ── db.ref instrumentation: record write ATTEMPTS + inject faults (shared singleton → the trigger's own
//    getDatabase().ref(...) is the same instance, so the patch takes effect inside the handler). ──
const realRef = db.ref.bind(db);
let writes = [];                                   // {op, path} recorded while `recording`
let recording = false;
const faults = { onceIncludes: null, setEndsWith: null };   // per-case fault injection
function wrap(ref, path) {
  for (const m of ['set', 'update', 'remove', 'push']) {
    const orig = ref[m].bind(ref);
    ref[m] = (...a) => {
      if (recording) writes.push({ op: m, path });
      if (faults.setEndsWith && m === 'set' && path.endsWith(faults.setEndsWith)) {
        return Promise.reject(new Error('injected write fail: ' + path));
      }
      return orig(...a);
    };
  }
  const origTx = ref.transaction.bind(ref);
  ref.transaction = (...a) => { if (recording) writes.push({ op: 'transaction', path }); return origTx(...a); };
  const origOnce = ref.once.bind(ref);
  ref.once = (...a) => {
    if (faults.onceIncludes && path.includes(faults.onceIncludes)) return Promise.reject(new Error('injected read fail: ' + path));
    return origOnce(...a);
  };
  const origChild = ref.child.bind(ref);
  ref.child = (sub) => wrap(origChild(sub), (path === '/' ? '' : path) + '/' + sub);
  return ref;
}
db.ref = (p) => wrap(realRef(p), typeof p === 'string' ? p : '/');

// ── sendMessage spy ──
let sends = [];
let sendMode = 'ok';
let spyReadMarkerId = null;      // when set, capture that order's send_started_at AT SEND TIME (mark-before-send)
let startMarkerAtSend = undefined;
whatsapp.sendMessage = async (phone, body, restaurantId) => {
  sends.push({ phone, body, restaurantId });
  if (spyReadMarkerId) startMarkerAtSend = (await realRef('preparing_notifications/' + spyReadMarkerId + '/send_started_at').once('value')).val();
  if (sendMode === 'throw') throw new Error('injected provider failure');
  if (sendMode === 'null') return null;
  if (sendMode === 'obj_empty') return {};
  if (sendMode === 'error_body') return { error: 'nope' };
  if (sendMode === 'sent_flag') return { sent: true };
  return { id: 'MSG-' + sends.length };
};
function resetSpy(mode = 'ok') { sends = []; sendMode = mode; spyReadMarkerId = null; startMarkerAtSend = undefined; }
function clearFaults() { faults.onceIncludes = null; faults.setEndsWith = null; }

const ev = (orderId, before, after) => ({ data: { before: { val: () => before }, after: { val: () => after } }, params: { orderId } });
const IDENTITY = { active: true, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 10, version: 1, name: 'X Pizza', phone: '+50497952893', hours: null, whatsapp_enabled: true };
const baseOrder = (o = {}) => ({ order_type: 'delivery', restaurant_id: 'x_pizza', customer_phone: '99990000', customer_name: 'Test', tracking_token: 'TOK123', status: 'preparing', ...o });
const seedOrder = (id, o) => db.ref(`orders/${id}`).set(baseOrder(o));
const notif = async (id) => (await db.ref(`preparing_notifications/${id}`).once('value')).val();
const subtree = async (p) => (await db.ref(p).once('value')).val();
async function reset() {
  await db.ref('/').set(null);
  await db.ref('restaurants/x_pizza/identity').set(IDENTITY);
  await db.ref('restaurants/la_musa/identity').set({ ...IDENTITY, name: 'La Musa' });
  await db.ref('config/whatsapp_enabled').set(true);
}
// run the trigger while RECORDING write attempts (cleared per call)
async function runRec(id, before, after) {
  writes = []; recording = true;
  try { await app.notifyPreparing.run(ev(id, before, after)); } finally { recording = false; }
}
const FORBIDDEN = ['orders/', 'tasks/', 'payments/', 'payment_attempts/', 'facturas/', 'factura/', 'order_tracking/', 'drivers/', 'dispatcher_alerts/'];
function assertWritesScopedTo(markerId) {
  for (const w of writes) {
    assert.ok(w.path.startsWith(`preparing_notifications/${markerId}`), `write escaped the marker: ${w.op} ${w.path}`);
  }
  for (const w of writes) for (const f of FORBIDDEN) assert.ok(!w.path.startsWith(f), `write hit a forbidden tree: ${w.op} ${w.path}`);
}
function assertNoForbiddenWrites() {
  for (const w of writes) for (const f of FORBIDDEN) assert.ok(!w.path.startsWith(f), `write hit a forbidden tree: ${w.op} ${w.path}`);
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. →preparing (delivery AND pickup) → ONE send; claimed+started+sent; ALL writes under the marker ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    await seedOrder('D1', { order_type: 'delivery' });
    await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    await runRec('D1', 'new', 'preparing');
    assert.strictEqual(sends.length, 1, 'delivery preparing → one send');
    assert.ok(/estará listo en ~20 min/.test(sends[0].body) && /salga en camino/.test(sends[0].body) && !/listo para recoger/.test(sends[0].body), 'delivery readiness copy + config ETA');
    const n = await notif('D1');
    assert.ok(n.claimed_at && n.send_started_at && n.sent_at && !n.send_unresolved_at, 'claimed+started+sent, no unresolved');
    assertWritesScopedTo('D1');   // COMPREHENSIVE: every write attempt (incl. transient) stayed under the per-order marker
    assert.strictEqual(await subtree('tasks'), null, 'no tasks tree');
    assert.strictEqual(await subtree('payment_attempts'), null, 'no payment tree');
    assert.strictEqual(await subtree('facturas'), null, 'no factura tree');

    await seedOrder('K1', { order_type: 'pickup' });
    await runRec('K1', 'new', 'preparing');
    assert.strictEqual(sends.length, 2, 'pickup preparing → send too (both types)');
    assert.ok(/listo para recoger/.test(sends[1].body), 'pickup readiness copy');
    assertWritesScopedTo('K1');
    ok('→preparing (delivery+pickup) → ONE send each; EVERY write attempt scoped to the per-order marker');
  }

  // ── 2. Redelivery + concurrent → exactly ONE send; distinct markers ──
  await reset(); resetSpy('ok'); clearFaults(); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
  {
    await seedOrder('R1', {});
    await app.notifyPreparing.run(ev('R1', 'new', 'preparing'));
    await app.notifyPreparing.run(ev('R1', 'new', 'preparing'));
    assert.strictEqual(sends.length, 1, 'redelivered → ONE send');
    await seedOrder('R2', {}); resetSpy('ok');
    await Promise.all([app.notifyPreparing.run(ev('R2', 'new', 'preparing')), app.notifyPreparing.run(ev('R2', 'new', 'preparing'))]);
    assert.strictEqual(sends.length, 1, 'concurrent → ONE send');
    const m = await subtree('preparing_notifications');
    assert.ok(m.R1 && m.R2 && m.R1 !== m.R2, 'distinct per-order markers (interpolated path)');
    ok('redelivery + concurrent → exactly ONE send; distinct per-order markers');
  }

  // ── 3. STALE-STATUS GUARD: preparing event on an already-advanced order → skip, NO send, no forbidden write ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    for (const st of ['ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled']) {
      await seedOrder('S_' + st, { status: st });
      await runRec('S_' + st, 'new', 'preparing');
      const n = await notif('S_' + st);
      assert.ok(n && n.skipped_reason === 'stale_status' && !n.claimed_at, `status=${st}: skip stale_status, no claim`);
      assertNoForbiddenWrites();
    }
    assert.strictEqual(sends.length, 0, 'stale events → ZERO sends');
    ok('stale-status guard: late preparing on ready/otd/delivered/completed/cancelled → skip, no send/forbidden write');
  }

  // ── 4. isSendConfirmed classification (NOT result != null) ──
  await reset(); clearFaults(); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
  {
    const cases = [['null', false], ['throw', false], ['obj_empty', false], ['error_body', false], ['sent_flag', true], ['ok', true]];
    let i = 0;
    for (const [mode, confirmed] of cases) {
      resetSpy(mode);
      const id = 'C' + (i++);
      await seedOrder(id, {});
      await app.notifyPreparing.run(ev(id, 'new', 'preparing'));
      const n = await notif(id);
      assert.ok(n.send_started_at, `${mode}: attempt made`);
      if (confirmed) assert.ok(n.sent_at && !n.send_unresolved_at, `${mode}: → sent_at`);
      else assert.ok(n.send_unresolved_at && !n.sent_at, `${mode}: → send_unresolved_at, NO sent_at`);
    }
    ok('isSendConfirmed: {}/null/thrown/{error} → unresolved; {sent:true}/{id} → sent_at');
  }

  // ── 5. Ineligible → skip + reason, no claim/send, no forbidden write ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    const seedRaw = (id, o) => db.ref(`orders/${id}`).set(o);
    await seedRaw('E_missing_phone', baseOrder({ customer_phone: '' }));
    await seedRaw('E_no_rid', baseOrder({ restaurant_id: '' }));
    await seedRaw('E_unsupported', baseOrder({ restaurant_id: 'taco_stand' }));
    await seedOrder('E_disabled', { restaurant_id: 'la_musa' }); await db.ref('restaurants/la_musa/identity/whatsapp_enabled').set(false);
    const expect = { E_missing_phone: 'no_phone', E_no_rid: 'no_restaurant_id', E_unsupported: 'unsupported_restaurant', E_disabled: 'whatsapp_disabled' };
    for (const [id, reason] of Object.entries(expect)) {
      await runRec(id, 'new', 'preparing');
      const n = await notif(id);
      assert.ok(n && n.skipped_reason === reason && !n.claimed_at && !n.sent_at, `${id} → skip ${reason}, no claim/send`);
      assertNoForbiddenWrites();
    }
    await runRec('E_never_seeded', 'new', 'preparing');
    assert.ok((await notif('E_never_seeded')).skipped_reason === 'order_missing', 'missing order → skip order_missing');
    assert.strictEqual(sends.length, 0, 'ineligible → zero sends');
    ok('ineligible (no_phone/no_rid/unsupported/disabled/order_missing) → skip+reason, no claim/send/forbidden write');
  }

  // ── 6a. ETA from config; 6b. ABSENT config → 25; 6c. REJECTED read → 25 (the CAUGHT read path) ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    await seedOrder('ETAcfg', { order_type: 'pickup' }); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    await app.notifyPreparing.run(ev('ETAcfg', 'new', 'preparing'));
    assert.ok(/~20 min/.test(sends[sends.length - 1].body), 'config prep_eta_min=20 → ~20 min');

    await seedOrder('ETAabsent', { order_type: 'pickup' }); await db.ref('restaurants/x_pizza/prep_eta_min').remove();
    await app.notifyPreparing.run(ev('ETAabsent', 'new', 'preparing'));
    assert.ok(/~25 min/.test(sends[sends.length - 1].body), 'absent config → neutral fallback 25');

    // REJECTED read (not merely absent): the handler's ETA .once('value') rejects → caught → fallback 25, still sends.
    await db.ref('restaurants/x_pizza/prep_eta_min').set(20);   // present, but the read will be forced to reject
    await seedOrder('ETAreject', { order_type: 'pickup' });
    faults.onceIncludes = 'prep_eta_min';
    await app.notifyPreparing.run(ev('ETAreject', 'new', 'preparing'));
    clearFaults();
    assert.ok(/~25 min/.test(sends[sends.length - 1].body), 'REJECTED prep_eta_min read → caught → fallback 25 (still sends)');
    assert.ok((await notif('ETAreject')).sent_at, 'rejected ETA read still produces a confirmed send');
    ok('ETA: config value / absent→25 / REJECTED read→caught→25 (never throws, always sends)');
  }

  // ── 7. send_started_at write FAILS → NO send, claimed_at set, send_started_at absent (provably unsent) ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('SS1', {}); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    faults.setEndsWith = 'send_started_at';
    await app.notifyPreparing.run(ev('SS1', 'new', 'preparing'));
    clearFaults();
    assert.strictEqual(sends.length, 0, 'send_started_at write failed → sendMessage NEVER called');
    const n = await notif('SS1');
    assert.ok(n.claimed_at && !n.send_started_at && !n.sent_at && !n.send_unresolved_at, 'claimed-only (no start) ⇒ genuinely unsent');
    ok('failed send_started_at write → NO send; claimed-only marker (mark-before-send integrity)');
  }

  // ── 8. Claim RETAINED across a redelivery AFTER a failed send (no auto-reclaim → no double-send) ──
  await reset(); resetSpy('null'); clearFaults();   // first send returns null → unresolved
  {
    await seedOrder('CR1', {}); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    await app.notifyPreparing.run(ev('CR1', 'new', 'preparing'));
    const n1 = await notif('CR1');
    assert.ok(n1.claimed_at && n1.send_unresolved_at && !n1.sent_at, 'first attempt: claimed + send_unresolved_at, NO sent_at');
    resetSpy('ok');   // even if the provider would now succeed, the retained claim must block a resend
    await app.notifyPreparing.run(ev('CR1', 'new', 'preparing'));   // redelivery after failure
    assert.strictEqual(sends.length, 0, 'redelivery after a failed send → claim retained → NO second send');
    ok('claim retained across redelivery after a failed send → no auto-reclaim, no double-send');
  }

  // ── 9. Mark-before-send ORDERING: send_started_at is persisted at the moment sendMessage is called ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    await seedOrder('MB1', {}); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    spyReadMarkerId = 'MB1';
    await app.notifyPreparing.run(ev('MB1', 'new', 'preparing'));
    assert.ok(startMarkerAtSend, 'send_started_at was ALREADY persisted when sendMessage fired (mark-before-send)');
    ok('mark-before-send: send_started_at persisted before the provider call');
  }

  // ── 10. No-op transitions → early return, nothing written ──
  await reset(); resetSpy('ok'); clearFaults();
  {
    await seedOrder('N1', {});
    await app.notifyPreparing.run(ev('N1', 'preparing', 'preparing'));
    await app.notifyPreparing.run(ev('N1', 'new', 'ready'));
    assert.strictEqual(sends.length, 0, 'no-op / non-preparing → no send');
    assert.strictEqual(await notif('N1'), null, 'nothing written to the marker');
    ok('no-op (preparing→preparing) + non-preparing (→ready) → early return, nothing written');
  }

  console.log(`\npreparing-ready.emulator.test.js: ${pass} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e && e.stack) || e); process.exit(1); });
