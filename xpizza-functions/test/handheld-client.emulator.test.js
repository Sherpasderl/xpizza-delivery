'use strict';
/**
 * H1b T8 (codex P2-12) — the REAL handheld client modules (xpizza-handheld/api.js, offline-queue.js, outcomes.js, feeds.js) against
 * the REAL H1a callables (index.js exports, run in-process through their own .run(request), as test/merchant-assign-hold does)
 * and the REAL repo rules on the RTDB emulator.
 *   node tools/emulator-run.js --only database --project demo-xpizza "node test/handheld-client.emulator.test.js"   (npm run test:handheld-client)
 *
 * CALLABLE / QUEUE cases — must pass now:
 *   C1 the T3 classes from REAL responses: ok, a receipt replay (ok), stale_state (terminal), invalid-argument (terminal),
 *      not_served (terminal), unauthenticated (auth), a revoked device (terminal permission-denied). The retry class is a
 *      transport failure (no response) — it cannot come from an in-process handler; outcomes.test.js pins it.
 *   C2 a persisted queue replay after a simulated restart: the original op_id is resent; the server applies it once.
 * FEED cases — EXPECTED RED until downloads-5f F2(c) adds the device query clause (A-2), like G-1. Reported, never silently passed:
 *   F1 two locations, no cross-read (own-rid query allowed, another rid's denied)        F2 a forbidden root /orders read
 *   F3 feed transitions new → preparing → ready through the real callables               F4 revoked → sessionLost
 *   F5 (BC4) a scheduled order released into 'new' across an app restart appears in Nuevos
 * The device context reads the SAME namespace the admin SDK writes (xpizza-delivery-default-rtdb), with the repo rules loaded
 * into it through the emulator's admin REST endpoint.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const fns = require('../index');

const NS = 'xpizza-delivery-default-rtdb';
const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
// HC_RULES=<file> runs the same cases under other rules — e.g. F2's N-full artifact (xpizza-reference/f2-narrow/N-full.rules.json,
// which carries the device query clause) to prove the feed cases go GREEN once F2(c) lands.
const RULES = fs.readFileSync(process.env.HC_RULES || path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const HH = path.join(__dirname, '..', '..', 'xpizza-handheld');
const db = getDatabase();
const val = async (p) => (await db.ref(p).once('value')).val();
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const feedResults = [];
const T0 = Date.now();

// Third synthetic brand ('tb_'): two member locations of brand 'tb', one handheld each.
const DEV_N = 'hh_tb_norte_t8'; const DEV_C = 'hh_tb_centro_t8';
const order = (id, rid, over = {}) => ({ order_id: id, restaurant_id: rid, routing_reason: 'nearest', status: 'new', order_type: 'pickup', display_number: 7,
  customer_name: 'Cliente Prueba', items_text: '1x Plato', total: 100, payment_method: 'cash', created_at: T0 - 60000, ...over });
const seed = () => db.ref().set({
  brands: { tb: { name: 'Marca TB', active: true, locations: { tb_norte: 'member', tb_centro: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_norte: { order_surface: 'handheld', identity: { brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 }, handhelds: { [DEV_N]: { kind: 'handheld', revoked: false } } },
    tb_centro: { order_surface: 'handheld', identity: { brand_id: 'tb', location_name: 'Centro', prep_default_min: 20 }, handhelds: { [DEV_C]: { kind: 'handheld', revoked: false } } },
  },
  orders: { o1: order('o1', 'tb_norte'), o2: order('o2', 'tb_norte'), oc: order('oc', 'tb_centro'), os: order('os', 'tb_norte', { status: 'scheduled', release_at: T0 + 60000 }) },
});

const authOf = (uid, rid) => ({ uid, token: { handheld: true, rid } });
// the client's injected `call`, onto the REAL exported callables in-process
const callAs = (auth) => async (name, data) => {
  if (!fns[name] || typeof fns[name].run !== 'function') throw new Error(`no callable ${name}`);
  return fns[name].run({ data, auth, rawRequest: { headers: {} } });
};

async function putRules() {
  const res = await fetch(`http://${HOST}/.settings/rules.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: RULES });
  if (!res.ok) throw new Error(`rules load failed: ${res.status}`);
}
// the feeds.js adapter over a rules-enforced compat database (the device's own credentials)
const denied = new Set();                              // which listener paths the rules refused (diagnosis)
function adapter(cdb) {
  const tag = (p, err) => (e) => { denied.add(p); err(e); };
  return {
    onQuery(p, child, value, h) {
      const q = cdb.ref(p).orderByChild(child).equalTo(value);
      const e = tag(`${p}?${child}=${value}`, h.error);
      const a = q.on('child_added', (s) => h.added(s.key, s.val()), e);
      const c = q.on('child_changed', (s) => h.changed(s.key, s.val()), e);
      const r = q.on('child_removed', (s) => h.removed(s.key), e);
      q.once('value').then(() => h.loaded(), e);
      return () => { q.off('child_added', a); q.off('child_changed', c); q.off('child_removed', r); };
    },
    onValue(p, cb, err) { const ref = cdb.ref(p); const f = ref.on('value', (s) => cb(s.val()), tag(p, err)); return () => ref.off('value', f); },
  };
}
const until = async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return pred(); };
async function feedCase(label, fn) {
  try { await fn(); feedResults.push({ label, ok: true }); console.log(`  ok   [feed] ${label}`); }
  catch (e) { feedResults.push({ label, ok: false, why: e && e.message }); console.log(`  RED  [feed] ${label} — expected until F2(c): ${e && e.message}`); }
}

(async () => {
  const { createQueue, memoryStorage } = await import(path.join(HH, 'offline-queue.js'));
  const { createApi } = await import(path.join(HH, 'api.js'));
  const { classify } = await import(path.join(HH, 'outcomes.js'));
  const { startFeeds } = await import(path.join(HH, 'feeds.js'));
  const M = await import(path.join(HH, 'model.js'));
  await seed();
  await putRules();
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const deviceDb = (uid, rid) => env.authenticatedContext(uid, { handheld: true, rid }).database(`http://${HOST}?ns=${NS}`);
  const session = (uid, rid) => ({ current: () => ({ uid, rid, gen: 1 }) });
  const mkApi = (storage, auth, rid, online = () => true) => {
    const queue = createQueue({ storage, partition: { uid: auth ? auth.uid : 'x', rid }, session: session(auth ? auth.uid : 'x', rid) });
    return { queue, api: createApi({ call: callAs(auth), queue, isOnline: online, rid }) };
  };

  // ── C1: the T3 classes from REAL responses ──────────────────────────────────────────────────────────────────────────────
  {
    const auth = authOf(DEV_N, 'tb_norte');
    const { queue, api } = mkApi(memoryStorage(), auth, 'tb_norte');
    const a = api.act('accept', 'o1', { prep_min: 22 });
    const r1 = await api.flush();
    assert.deepStrictEqual([r1.sent, r1.dropped.length, (await val('orders/o1/status'))], [1, 0, 'preparing'], JSON.stringify(r1));
    assert.strictEqual((await val('orders/o1/prep')).committed_min, 22);
    ok('ok: a queued accept → the real merchantAccept commits (preparing, prep 22)');
    const replay = await callAs(auth)('merchantAccept', { rid: 'tb_norte', oid: 'o1', op_id: a.item.op_id, prep_min: 22 });
    assert.deepStrictEqual(classify(replay), { class: 'ok', code: null });
    ok('ok: resending the SAME op_id is a receipt replay → ok');
    const stale = await api.direct('merchantAccept', { oid: 'o1', prep_min: 22 });
    assert.deepStrictEqual([stale.class, stale.code], ['terminal', 'stale_state'], JSON.stringify(stale));
    ok('terminal: a second accept with a NEW op on an accepted order → stale_state');
    const bad = await api.direct('merchantMoreTime', { oid: 'o1', add_min: 7 });
    assert.deepStrictEqual([bad.class, bad.code], ['terminal', 'invalid-argument'], JSON.stringify(bad));
    ok('terminal: a malformed payload → invalid-argument');
    const other = await api.direct('merchantAccept', { oid: 'oc', prep_min: 20 });
    assert.strictEqual(other.class, 'terminal', JSON.stringify(other));
    assert.strictEqual(await val('orders/oc/status'), 'new');
    ok(`terminal: another location's order is not served (${other.code}); nothing written`);
    const anon = await mkApi(memoryStorage(), null, 'tb_norte').api.direct('merchantAccept', { oid: 'o2', prep_min: 20 });
    assert.deepStrictEqual([anon.class, anon.code], ['auth', 'unauthenticated'], JSON.stringify(anon));
    ok('auth: no credentials → unauthenticated (the client pauses and re-pairs)');
    void queue;
  }

  // ── C2: a persisted queue replay after a simulated restart ───────────────────────────────────────────────────────────────
  {
    const auth = authOf(DEV_N, 'tb_norte');
    const storage = memoryStorage();
    const first = mkApi(storage, auth, 'tb_norte');
    const it = first.api.act('accept', 'o2', { prep_min: 15 });
    // the app dies before the response: the send fails at the transport, the item stays persisted with its op_id
    const dead = createQueue({ storage, partition: { uid: DEV_N, rid: 'tb_norte' }, session: session(DEV_N, 'tb_norte') });
    const r0 = await dead.flush(async () => { throw new TypeError('Failed to fetch'); });
    assert.strictEqual(r0.stopped, 'retry');
    assert.strictEqual(await val('orders/o2/status'), 'new');
    const reborn = mkApi(storage, auth, 'tb_norte');                // restart: a new queue over the same storage
    assert.deepStrictEqual(reborn.queue.items().map((x) => x.op_id), [it.item.op_id]);
    const r1 = await reborn.api.flush();
    assert.deepStrictEqual([r1.sent, await val('orders/o2/status')], [1, 'preparing']);
    const again = await callAs(auth)('merchantAccept', { rid: 'tb_norte', oid: 'o2', op_id: it.item.op_id, prep_min: 15 });
    assert.strictEqual(classify(again).class, 'ok');
    const ops = (await val('orders/o2/handheld_ops')) || {};
    assert.strictEqual(Object.keys(ops).length, 1, 'ONE receipt: the server applied the op once');
    ok('a persisted accept survives a restart and is resent with its ORIGINAL op_id; the server applies it once');
  }

  // ── C1 (cont.): a revoked device is refused ──────────────────────────────────────────────────────────────────────────────
  {
    await db.ref(`restaurants/tb_centro/handhelds/${DEV_C}/revoked`).set(true);
    const { api } = mkApi(memoryStorage(), authOf(DEV_C, 'tb_centro'), 'tb_centro');
    const r = await api.direct('merchantAccept', { oid: 'oc', prep_min: 20 });
    assert.deepStrictEqual([r.class, r.code], ['terminal', 'permission-denied'], JSON.stringify(r));
    ok('terminal: a revoked device → permission-denied (the feed\'s sessionLost then re-pairs it)');
    await db.ref(`restaurants/tb_centro/handhelds/${DEV_C}/revoked`).set(false);
  }

  // ── FEED cases (expected red until F2(c)) ────────────────────────────────────────────────────────────────────────────────
  await feedCase('F2 a forbidden root /orders read (unqueried) is denied', async () => {
    const cdb = deviceDb(DEV_N, 'tb_norte');
    let denied = false;
    try { await cdb.ref('orders').once('value'); } catch (_) { denied = true; }
    assert.ok(denied, 'the device read ALL orders');
  });

  let feedN = null; let stN = null;
  await feedCase('F1 own-rid query delivers only its own orders (and sessionLost stays false)', async () => {
    feedN = startFeeds({ rtdb: adapter(deviceDb(DEV_N, 'tb_norte')), rid: 'tb_norte', brandId: 'tb', onState: (s) => { stN = s; } });
    await until(() => stN && (stN.loaded || stN.sessionLost));
    assert.ok(stN && !stN.sessionLost, `sessionLost — denied: ${[...denied].join(', ')} (F2(c) adds the device query clause + the order_control/{rid} grant)`);
    assert.ok(stN.loaded);
    assert.deepStrictEqual(Object.keys(stN.orders).sort(), ['o1', 'o2', 'os']);
  });
  await feedCase('F1 another location\'s query is denied', async () => {
    let lost = false;
    const f = startFeeds({ rtdb: adapter(deviceDb(DEV_N, 'tb_norte')), rid: 'tb_centro', brandId: 'tb', onState: (s) => { if (s.sessionLost) lost = true; } });
    await until(() => lost);
    f.stop();
    assert.ok(lost, 'a tb_norte device read tb_centro');
  });
  await feedCase('F3 feed transitions new → preparing → ready through the real callables', async () => {
    assert.ok(stN && !stN.sessionLost && stN.loaded, 'no feed (own-rid query refused)');
    const auth = authOf(DEV_N, 'tb_norte');
    await db.ref('orders/o3').set(order('o3', 'tb_norte'));
    await until(() => stN.orders.o3 && stN.orders.o3.status === 'new');
    assert.deepStrictEqual(M.queues(stN.orders).nuevos.map((o) => o.id).includes('o3'), true);
    const { api } = mkApi(memoryStorage(), auth, 'tb_norte');
    api.act('accept', 'o3', { prep_min: 20 }); await api.flush();
    await until(() => stN.orders.o3.status === 'preparing');
    assert.ok(M.queues(stN.orders).prep.some((o) => o.id === 'o3'));
    api.act('ready', 'o3'); await api.flush();
    await until(() => stN.orders.o3.status === 'ready');
    assert.ok(M.queues(stN.orders).listos.some((o) => o.id === 'o3'));
  });
  await feedCase('F5 (BC4) a scheduled order released into new across an app restart appears in Nuevos', async () => {
    assert.ok(stN && !stN.sessionLost && stN.loaded, 'no feed (own-rid query refused)');
    assert.ok(!M.queues(stN.orders).nuevos.some((o) => o.id === 'os'), 'scheduled stays hidden');
    feedN.stop();                                                        // the app dies
    await db.ref('orders/os/status').set('new');                        // the server releases it meanwhile
    let st2 = null;
    feedN = startFeeds({ rtdb: adapter(deviceDb(DEV_N, 'tb_norte')), rid: 'tb_norte', brandId: 'tb', onState: (s) => { st2 = s; } });   // restart
    await until(() => st2 && st2.loaded);
    assert.ok(M.queues(st2.orders).nuevos.some((o) => o.id === 'os'));
  });
  await feedCase('F4 revoked → sessionLost (the listener is cancelled)', async () => {
    let lost = false;
    const f = startFeeds({ rtdb: adapter(deviceDb(DEV_N, 'tb_norte')), rid: 'tb_norte', brandId: 'tb', onState: (s) => { if (s.sessionLost) lost = true; } });
    await until(() => false, 500);
    assert.ok(!lost, 'lost BEFORE the revoke (no F2(c) device clause yet)');
    await db.ref(`restaurants/tb_norte/handhelds/${DEV_N}/revoked`).set(true);
    await until(() => lost);
    f.stop();
    assert.ok(lost, 'still reading after the revoke');
  });
  if (feedN) feedN.stop();
  await env.cleanup();

  const red = feedResults.filter((r) => !r.ok);
  console.log(`\nhandheld-client: callable/queue OK (${n}); feed ${feedResults.length - red.length}/${feedResults.length}${red.length ? ` — ${red.length} EXPECTED RED until F2(c) (device query clause)` : ' — FULLY GREEN'}`);
  process.exit(0);
})().catch((e) => { console.error('handheld-client FAILED:', e && e.stack || e); process.exit(1); });
