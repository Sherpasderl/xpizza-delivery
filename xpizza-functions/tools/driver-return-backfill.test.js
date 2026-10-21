'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §B) — the owner's return_restaurant_id backfill: evidence = the live
// current_restaurant_id, else the latest DELIVERED order over the FULL indexed history under BOTH attributions
// (delivered_by_driver_uid, legacy delivered_by_uid), used only when that restaurant's identity EXISTS; no x_pizza default;
// a set-if-absent transaction per driver (never overwrites); idempotent; the read-back fails while any driver is unresolved;
// set-return <uid> <rid> resolves one by hand (set-if-absent, identity required, read-back). The CLI refuses without --project.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./driver-return-backfill-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// an in-memory RTDB: nested data, child paths, orderByChild().equalTo() queries, transactions, multi-path update
function fakeRtdb(init) {
  const data = JSON.parse(JSON.stringify(init)); const log = { tx: [], queries: [] };
  const get = (p) => (p ? p.split('/') : []).reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : null), data);
  const put = (p, v) => {
    const ks = p.split('/'); let o = data;
    for (const k of ks.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = v;
  };
  const snapOf = (v) => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v !== null && v !== undefined });
  const ref = (p) => ({
    once: async () => snapOf(get(p)),
    orderByChild: (f) => ({ equalTo: (x) => ({ once: async () => {
      log.queries.push(`${p}:${f}=${x}`);
      const out = {}; for (const [k, o] of Object.entries(get(p) || {})) if (o && o[f] === x) out[k] = o;
      return snapOf(Object.keys(out).length ? out : null);
    } }) }),
    transaction: async (fn) => {
      log.tx.push(p);
      const cur = get(p); const next = fn(cur === undefined ? null : cur);
      if (next === undefined) return { committed: false, snapshot: snapOf(cur) };
      put(p, next); return { committed: true, snapshot: snapOf(next) };
    },
  });
  return { ref: (p) => ref(p || ''), data, log, put };
}

const ID = { name: 'Loc', hub_lat: 15.5, hub_lng: -88, phone: '+504', active: true, version: 1, delivery_radius_km: 5 };
const order = (rid, extra) => ({ status: 'delivered', restaurant_id: rid, created_at: 100, ...extra });
const seed = () => ({
  restaurants: { tb_centro: { identity: ID }, tb_norte: { identity: ID } },
  drivers: {
    d_live: { name: 'Live', current_restaurant_id: 'tb_norte' },
    d_hist: { name: 'Hist', current_restaurant_id: null },
    d_legacy: { name: 'Legacy' },
    d_present: { name: 'Present', return_restaurant_id: 'tb_centro', current_restaurant_id: 'tb_norte' },
    d_none: { name: 'Nobody' },
    d_norid: { name: 'NoRid' },
    d_ghost: { name: 'Ghost' },
    d_cancel: { name: 'OnlyCancelled' },
  },
  orders: {
    o1: order('tb_centro', { delivered_by_driver_uid: 'd_hist', delivered_at: 1000 }),
    o2: order('tb_norte', { delivered_by_driver_uid: 'd_hist', delivered_at: 900 }),                 // older → not chosen
    o3: order('tb_norte', { delivered_by_uid: 'd_legacy', delivered_at: 500 }),                      // legacy attribution only
    o4: order('tb_centro', { delivered_by_driver_uid: 'd_legacy', delivered_at: 400 }),
    o5: order(undefined, { delivered_by_driver_uid: 'd_norid', delivered_at: 700 }),                 // latest has NO restaurant_id
    o6: order('tb_centro', { delivered_by_driver_uid: 'd_norid', delivered_at: 600 }),
    o7: order('tb_ghost', { delivered_by_driver_uid: 'd_ghost', delivered_at: 800 }),                // unknown identity
    o8: { status: 'cancelled', restaurant_id: 'tb_centro', delivered_by_driver_uid: 'd_cancel', created_at: 5 },
    o9: order('tb_centro', { delivered_by_driver_uid: 'd_live', delivered_at: 9999 }),               // live rid wins anyway
    o10: order('tb_norte', { delivered_by_driver_uid: 'd_hist', created_at: 2000 }),                  // no delivered_at → created_at… but 2000 > 1000
  },
});

(async () => {
  const db = fakeRtdb(seed());
  const plan = await C.planBackfill(db);
  const by = Object.fromEntries(plan.rows.map((r) => [r.uid, r]));
  assert.deepStrictEqual(by.d_live, { uid: 'd_live', name: 'Live', rid: 'tb_norte', source: 'live current_restaurant_id' });
  assert.deepStrictEqual(by.d_hist, { uid: 'd_hist', name: 'Hist', rid: 'tb_norte', source: 'latest delivered order o10' }, 'the max of delivered_at else created_at, over every attribution');
  assert.deepStrictEqual(by.d_legacy, { uid: 'd_legacy', name: 'Legacy', rid: 'tb_norte', source: 'latest delivered order o3' }, 'legacy delivered_by_uid counts (and wins when it is the latest)');
  assert.ok(!by.d_present, 'a present value is never planned over');
  assert.deepStrictEqual(plan.present, ['d_present']);
  assert.deepStrictEqual(plan.unresolved, [
    { uid: 'd_cancel', name: 'OnlyCancelled', reason: 'no live restaurant and no delivered order' },
    { uid: 'd_ghost', name: 'Ghost', reason: 'latest delivered order o7 names tb_ghost, which has no identity' },
    { uid: 'd_none', name: 'Nobody', reason: 'no live restaurant and no delivered order' },
    { uid: 'd_norid', name: 'NoRid', reason: 'latest delivered order o5 has no restaurant_id' },
  ], 'unresolved: no evidence, an order without restaurant_id (NO x_pizza default), an unknown identity');
  for (const uid of Object.keys(seed().drivers)) {
    const needsHistory = !['d_present', 'd_live'].includes(uid);   // a present value / a live rid needs no history read
    assert.strictEqual(db.log.queries.includes(`orders:delivered_by_driver_uid=${uid}`), needsHistory, `${uid}: indexed history query iff needed`);
  }
  assert.ok(db.log.queries.includes('orders:delivered_by_uid=d_legacy'), 'and on the legacy delivered_by_uid');
  ok('plan: live rid, else the latest delivered order over BOTH attributions (full history, max delivered_at|created_at) whose identity exists; present values skipped; no evidence / no restaurant_id / unknown identity → UNRESOLVED (never x_pizza)');

  // codex build r1 P1: a read-back BEFORE the apply must fail for EVERY driver without a persisted string value — including the
  // fillable ones (live rid / history), whose evidence exists but was never written — so the stage-B gate cannot open early
  const pre = await C.readBack(db);
  for (const uid of ['d_live', 'd_hist', 'd_legacy']) assert.ok(pre.some((p) => p.startsWith(`${uid}: `) && /no return_restaurant_id persisted/.test(p)), `read-back before apply names fillable ${uid}`);
  for (const uid of ['d_cancel', 'd_ghost', 'd_none', 'd_norid']) assert.ok(pre.some((p) => p.startsWith(`${uid}: UNRESOLVED`)), `and unresolved ${uid}`);
  assert.ok(!pre.some((p) => p.startsWith('d_present:')), 'a present valid value is not a problem');
  const odd = fakeRtdb({ restaurants: { tb_centro: { identity: ID } }, drivers: { d_num: { name: 'Num', return_restaurant_id: 7, current_restaurant_id: 'tb_centro' } } });
  assert.ok((await C.readBack(odd)).some((p) => p.startsWith('d_num: ') && /not a string/.test(p)), 'a NON-STRING persisted value fails the read-back');
  ok('read-back BEFORE the apply fails for every driver lacking a persisted string value (fillable included) and for a non-string value');

  // apply: a set-if-absent transaction per planned driver
  db.put('drivers/d_hist/return_restaurant_id', 'tb_centro');   // a stage-A writer lands between plan and apply
  const res = await C.applyBackfill(db, plan.rows);
  assert.deepStrictEqual(res, { written: ['d_legacy', 'd_live'], kept: ['d_hist'] }, 'the transaction never overwrites a value written meanwhile');
  assert.strictEqual(db.data.drivers.d_hist.return_restaurant_id, 'tb_centro');
  assert.deepStrictEqual(db.log.tx.sort(), ['drivers/d_hist/return_restaurant_id', 'drivers/d_legacy/return_restaurant_id', 'drivers/d_live/return_restaurant_id']);
  assert.strictEqual(db.data.drivers.d_present.return_restaurant_id, 'tb_centro', 'a present value untouched');
  ok('apply: one set-if-absent transaction per planned driver — a value written meanwhile (stage A) is kept, never overwritten');

  const again = await C.planBackfill(db);
  assert.deepStrictEqual(again.rows, [], 'a second run plans 0');
  ok('idempotent: a second run plans 0 writes');

  // read-back: exits 1 (problems) while any driver is unresolved
  let rb = await C.readBack(db);
  assert.deepStrictEqual(rb.map((p) => p.split(':')[0]), ['d_cancel', 'd_ghost', 'd_none', 'd_norid'], 'every unresolved driver is a problem');
  ok('read-back: FAILS while any driver is unresolved (stage B blocked), naming each');

  // set-return resolves them by hand
  assert.deepStrictEqual(await C.setReturn(db, 'd_none', 'tb_zzz'), { ok: false, error: 'tb_zzz has no identity — refusing' });
  assert.deepStrictEqual(await C.setReturn(db, 'd_missing', 'tb_centro'), { ok: false, error: 'no driver d_missing' });
  assert.deepStrictEqual(await C.setReturn(db, 'd_present', 'tb_norte'), { ok: false, error: 'd_present already has return_restaurant_id "tb_centro" — PRESERVED (set-if-absent)' });
  assert.deepStrictEqual(await C.setReturn(db, 'd_present', 'tb_centro'), { ok: true, noop: true, back: 'tb_centro' });
  assert.deepStrictEqual(await C.setReturn(db, 'd_none', 'tb_centro', { dryRun: true }), { ok: true, dryRun: true });
  assert.strictEqual(db.data.drivers.d_none.return_restaurant_id, undefined, 'a dry run writes nothing');
  for (const uid of ['d_cancel', 'd_ghost', 'd_none', 'd_norid']) assert.deepStrictEqual(await C.setReturn(db, uid, 'tb_centro'), { ok: true, back: 'tb_centro' });
  assert.deepStrictEqual(await C.setReturn(db, '../x', 'tb_centro'), { ok: false, error: 'not a driver uid: "../x"' });
  rb = await C.readBack(db);
  assert.deepStrictEqual(rb, [], 'read-back clean once every driver is resolved');
  ok('set-return: identity required, driver required, set-if-absent (a different value PRESERVED; equal → no-op), dry run writes nothing, read-back; then the read-back is clean');

  db.put('drivers/d_live/return_restaurant_id', 'tb_gone');
  assert.deepStrictEqual(await C.readBack(db), ['d_live: return_restaurant_id "tb_gone" has no identity']);
  ok('read-back: a value naming a restaurant without an identity is a problem');

  // 🔴 the spawned CLI can never reach a real database: dead loopback RTDB / Firestore ports, void credentials
  const env = { ...process.env, FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/creds.json' };
  delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.NODE_OPTIONS;
  const cli = path.join(__dirname, 'driver-return-backfill.js');
  const r = spawnSync(process.execPath, [cli], { env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(r.status, 0, 'refuses without --project');
  assert.ok(!/driver-return-backfill (APPLY|DRY RUN)/.test(r.stdout), 'and reads nothing');
  const expected = require('./require-project').expectedProject();
  for (const v of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
    const r2 = spawnSync(process.execPath, [cli, 'set-return', 'd1', 'tb_centro', '--apply'], { env: { ...env, [v]: expected }, encoding: 'utf8', timeout: 20000 });
    assert.notStrictEqual(r2.status, 0, `${v}=${expected} without --project is refused`);
    assert.match(r2.stderr, /explicit flag/);
    assert.ok(!/DRY RUN|APPLY|applied/.test(r2.stdout), 'nothing planned, read or written');
  }
  ok('the CLI refuses to run (backfill or set-return, dry run or --apply) without a stated --project');

  console.log(`\ndriver-return-backfill: OK (${n})`);
})().catch((e) => { console.error('driver-return-backfill FAILED:', e); process.exit(1); });
